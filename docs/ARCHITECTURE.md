# PullVault Architecture

## 1) System overview and current operating mode

PullVault is a monorepo:
- `apps/web`: Next.js 14 (App Router), TypeScript, Tailwind
- `apps/server`: Express + Socket.io + background workers
- `packages/common`: shared schemas/constants/events

Infra:
- PostgreSQL: source of truth for balances, inventory, ownership, auctions, settlements
- Redis: cache/idempotency (not pub/sub in current deployment)
- Price feed mode in Part A: Pokemon TCG card metadata + simulated live price drift
- Portfolio history mode in Part A: periodic net-worth snapshots persisted to `portfolio_snapshots`

Core design principle: **financial correctness first** (ACID + row-level locking + idempotency), then real-time UX.

Part A stance: concurrency risk is primarily at the **database transaction layer** (pack inventory, bids, balances, ownership). Single-server Socket.io broadcast is acceptable for Part A once P0 financial flows are correct.

Plain English:
- If two people click at the same time, the database decides who wins safely.
- Money and item ownership changes are done together in one transaction.
- Live websocket updates are for UX speed, not the source of truth.

---

## 2) Fixed parameters and product decisions

### Required parameter decisions (code-accurate)

| Parameter | Value in current build | Why |
|---|---|---|
| Item Type | Pokemon TCG cards | Product scope |
| Price Source | Pokemon TCG API metadata + simulated rarity-based prices | Reliable free-tier bootstrap while preserving live market behavior in UX |
| Currency | USD paper trading | Matches trial requirement |
| Starting Balance | `$1000.00` | Enough for multiple packs + auction participation |
| Pack Tiers | `Basic`, `Pro`, `Elite` | Clear progression from casual to high-stakes |
| Cards Per Pack | Basic `3`, Pro `5`, Elite `7` | Increased opening depth with tier |
| Pack Prices | Basic `$5`, Pro `$15`, Elite `$40` | Meaningful ladder for spend/risk |
| Drop Inventory | Basic `180`, Pro `90`, Elite `35` per drop | Creates scarcity pressure at upper tiers |
| Trading Fee | `5%` | Competitive fee while monetizing P2P |
| Auction Fee | `7%` | Higher than trade for premium live-liquidity surface |
| Min Bid Increment | `max($1.00, 5% of current bid)` | Prevents noisy micro-bids, improves discovery |
| Auction Durations | `60s`, `300s`, `900s` | Supports quick, standard, extended auctions |
| Anti-Snipe | If an open bid arrives in final `30s`, extend by `30s`, up to `6` times | Fair response window without infinite extension |
| Rarity Weights | See table below | Higher tiers allocate more weight to premium rarities |

### Rarity weights by tier

**Note:** The weights below are bootstrap defaults (Part A). The pack economics optimizer (B1) may override these values at runtime to maintain target margins and win-rates. See the "Pack Economics" section for details on how the optimizer adjusts weights dynamically.

Bootstrap defaults (Part A):
- **Basic (3 cards):** `Common 0.72`, `Uncommon 0.22`, `Rare 0.05`, `Holo Rare 0.01`
- **Pro (5 cards):** `Common 0.55`, `Uncommon 0.25`, `Rare 0.12`, `Holo Rare 0.06`, `Ultra Rare/EX/GX 0.02`
- **Elite (7 cards):** `Common 0.32`, `Uncommon 0.24`, `Rare 0.20`, `Holo Rare 0.14`, `Ultra Rare/EX/GX 0.08`, `Secret Rare 0.02`

This creates the intended experience: premium tiers materially increase probability mass in high rarities.

Plain English:
- Basic packs are cheaper and safer.
- Pro and Elite packs are riskier but have better chances at high-value pulls.
- Fees are how the platform earns on trading/auctions.

---

## 3) Concurrency and consistency guarantees

### Pack drops (simultaneous buy race)

Guarantee required: if `N` users buy when `M` packs remain, exactly `M` succeed.

Mechanism:
1. Start DB transaction.
2. `SELECT ... FOR UPDATE` on target drop row.
3. Validate live window + inventory.
4. Debit available balance (row-locked balance update).
5. Decrement inventory.
6. Create purchase + pre-generate cards server-side.
7. Commit; on failure rollback all.

Why it is safe:
- Inventory and balance mutations happen in one transaction.
- No state where user is charged but pack not granted.
- Row lock serializes last-pack contention.
- Idempotency key prevents duplicate financial side effects.

Plain English:
- We lock the pack row first, then check stock, then charge, then assign the pack.
- If anything fails, everything is rolled back automatically.
- So we never oversell and never “charge without giving pack.”

### Marketplace atomicity

Mechanism:
1. Transaction + `FOR UPDATE` on listing.
2. Validate listing is still `ACTIVE`.
3. Validate card market-state is `LISTED` (not in auction/sold).
4. Debit buyer, credit seller net, credit platform fee.
5. Transfer card owner + mark listing sold + clear market-state.
6. Record transaction + ledger entries.

Why it is safe:
- Prevents double-sell under concurrent buys.
- Money and ownership transfer are all-or-nothing.

Plain English:
- One listing can only be sold once.
- Buyer payment, seller credit, and card transfer happen together or not at all.

### Auction consistency

Mechanism:
1. Transaction + `FOR UPDATE` on auction.
2. Validate status/time and min bid.
3. Hold bidder funds; release previous top bidder funds atomically.
4. Apply anti-snipe extension rule.
5. Update auction state + insert bid + ledger.
6. Settlement worker closes and settles from DB state (not memory).

Why it is safe:
- Concurrent bids are serialized by row lock.
- Held funds prevent over-commit across auctions.
- Recoverable after restart because truth lives in PostgreSQL.

Plain English:
- Two bids at the same moment are processed one-by-one in a safe order.
- Outbid users get their hold released; top bidder stays reserved.
- If server restarts, auction state is still in DB and settlement can continue.

---

## 4) Economics, EV math, and business tradeoff

### Price engine mechanism (current Part A mode)

Current mode uses Pokemon TCG API for **card metadata** and simulates market pricing:

1. **Fetch and cache card pool**
   - Pull cards from Pokemon API with `name`, `set`, `rarity`, and image.
   - Normalize rarity labels into internal buckets:
     - `Common`, `Uncommon`, `Rare`, `Holo Rare`, `Ultra Rare/EX/GX`, `Secret Rare`.
   - Cache the pool in Redis for 1 hour.

2. **Assign initial value at pack purchase**
   - Pack contents are decided server-side at buy time.
   - For each card, assign `market_value` and `acquisition_value` from rarity-based base ranges plus small variance:
     - Common `[0.05, 0.50]`
     - Uncommon `[0.25, 2.00]`
     - Rare `[1.00, 10.00]`
     - Holo Rare `[3.00, 30.00]`
     - Ultra Rare/EX/GX `[15.00, 150.00]`
     - Secret Rare `[50.00, 500.00]`

3. **Simulate live market movement**
   - On each price tick (`PRICE_TICK_SECONDS`, default 45s), each card price drifts by `[-1.2%, +1.2%]`.
   - Clamp to a floor of `$0.01`.
   - Persist new prices to PostgreSQL and broadcast websocket updates to affected users/rooms.

4. **Portfolio effects**
   - Collection P/L and net worth update from latest persisted card prices.
   - Portfolio history snapshots are periodically written for charting.
   - Client reads timeseries from `GET /portfolio/history?range=24h|7d|30d`.

Worked example:
- Card starts at `$20.00`.
- Tick drift is `+0.8%` -> new price = `20.00 * 1.008 = 20.16`.
- Next tick drift is `-1.2%` -> new price = `20.16 * 0.988 = 19.92` (rounded to 2 decimals).

TCGPlayer integration note:
- We currently only have Pokemon API key access in this environment, so Part A runs in metadata + simulated-market mode.
- When TCGPlayer access is enabled, the same pipeline can swap quote source from simulated drift to external market quotes while keeping the same persistence/broadcast flow.

### EV model used in Part A

Initial card values are generated from rarity ranges:
- Common `[0.05, 0.50]`
- Uncommon `[0.25, 2.00]`
- Rare `[1.00, 10.00]`
- Holo Rare `[3.00, 30.00]`
- Ultra Rare/EX/GX `[15.00, 150.00]`
- Secret Rare `[50.00, 500.00]`

Using midpoint approximation for expectation:
- Common `0.275`, Uncommon `1.125`, Rare `5.5`, Holo `16.5`, Ultra `82.5`, Secret `275`.

Approximate EV per pack from current weights:
- **Basic (3 cards):** EV/card `~0.94`, EV/pack `~2.81`, Margin vs $5 `~+2.19`
- **Pro (5 cards):** EV/card `~3.31`, EV/pack `~16.57`, Margin vs $15 `~-1.57`
- **Elite (7 cards):** EV/card `~10.70`, EV/pack `~74.90`, Margin vs $40 `~-34.90`

### Interpretation

Current parameters intentionally favor excitement in higher tiers, but make top-tier pack EV economically aggressive (negative gross pack margin under midpoint assumptions). In Part A this is acceptable for engagement-first simulation, but **not long-term sustainable without rebalancing**.

Monetization currently comes from:
- Pack spread (positive in Basic, negative in Pro/Elite under current assumptions)
- Trade fee `5%`
- Auction fee `7%`

Planned Part B lever: tune tier prices and/or rarity weights dynamically to hit target blended margin while preserving "occasional win" feel.

Plain English:
- Right now, higher tiers are very generous to players on average.
- That helps excitement, but it can hurt platform margin.
- Next step is tuning prices/weights so users still win sometimes but business stays healthy.

---

## 5) Caching strategy and scale limits

### Current caching strategy

Redis is used for:
1. **Idempotency response cache** (fast duplicate suppression)
2. **Pokemon card pool cache** (reduced API traffic)

Background persistence (non-cache):
1. **Portfolio snapshot worker** writes net-worth points every 5 minutes for historical performance charts.

Socket broadcast is currently single-node in-memory Socket.io (no Redis pub/sub adapter yet). This is a deliberate simplification for trial scope, because Part A correctness risk sits in transactional DB paths, not broadcast fanout.

Plain English:
- Redis is used for fast cache/idempotency, not for realtime fanout yet.
- This keeps infra simple while we focus on transaction correctness.

### What breaks first at 10,000 users

Likely bottlenecks in order:
1. **WebSocket fanout on single server** (connection/memory limits)
2. **Postgres write contention** on hot auction/drop rows
3. **Price/snapshot background writes** as card/user count grows
4. **No multi-node socket adapter** means no horizontal realtime scale

### Scale path

1. Add Socket.io Redis adapter for cross-node pub/sub.
2. Separate API and realtime nodes behind load balancer.
3. Introduce read replicas and tighter query/index tuning.
4. Batch worker writes and shard high-frequency jobs.

Plain English:
- First pain point is lots of simultaneous websocket users.
- Second is heavy DB write pressure on hot rows.
- We already know the upgrade path, but we intentionally deferred it for Part A.

---

## 6) Key tradeoffs

1. **PostgreSQL over eventual-consistency stores**  
Chosen to guarantee financial correctness under concurrency.

2. **Server-side pack determination at buy-time**  
Prevents client-side reveal manipulation.

3. **Engagement-first tier economics in Part A**  
Improves dopamine loop but requires Part B rebalancing for sustained margins.

4. **Single-node realtime in Part A**  
Faster implementation and easier debugging; known horizontal-scale limitation.

5. **No Redis pub/sub in Part A by design**  
Deferred intentionally until P0 transaction guarantees are nailed. Mentioned as scale path, not required for initial correctness.

---

## 7) Considered and deferred (intentional non-goals for Part A)

1. **Redis pub/sub Socket.io adapter now**  
Considered for multi-node realtime scale. Deferred because Part A priority is transactional correctness under contention, not horizontal websocket scale.

2. **Distributed lock service for auctions/drops**  
Considered, but row-level DB locks already provide stronger correctness with lower complexity for this stage.

3. **Event-sourced financial ledger as primary write path**  
Considered for audit extensibility, deferred in favor of simpler ACID transaction flows to reduce implementation risk in trial timebox.

4. **Dynamic pricing/odds rebalancer**  
Considered for economics optimization, deferred to Part B where EV tuning and abuse resistance are explicitly tested.

---

## 8) Direct answers to review prompts

- **How does pack drop handle concurrent purchases?**  
Row-level lock on drop + transactional balance debit + inventory decrement + purchase creation in one ACID transaction.

- **How does auction maintain consistency?**  
Row-level lock on auction row, atomic hold/release flow for bidders, DB-backed settlement worker.

- **Caching strategy?**  
Redis cache-aside for idempotency/card-pool; DB remains source of truth; Socket events currently single-node.

- **What breaks first at 10,000 users?**  
Realtime fanout and single-node socket architecture, then DB hot-row/write pressure.

- **Pack EV math and parameter choices?**  
Documented above with code-accurate weights/prices; current model intentionally high-variance and engagement-forward, with explicit need for Part B rebalancing.

---

## 9) Part B: Platform Hardening

Part B builds on the Part A transaction-safe foundation with production hardening around economics, abuse resistance, auction integrity, public fairness proofs, and admin health monitoring. These systems are documented separately from the Part A baseline so the original architecture remains readable and each hardening feature has a clear owner and evaluation surface.

---

## 10) B1 - Pack economics algorithm

### Before B1: static pack economics

The first economics model used fixed tier odds and rarity value ranges:
- Basic, Pro, and Elite had hard-coded rarity weights on `drops`.
- Card values came from rarity ranges plus simulated market drift.
- EV was calculated after the fact from average card values by rarity.
- Admins could change drop prices and windows, but rarity weights did not automatically respond to market movement.

That model was useful for proving pack purchase, reveal, balance, and portfolio flows. It did not guarantee independent profitability per tier when card prices moved, and high-variance tiers could become negative-EV for the platform without an automatic correction.

### Current B1: versioned rarity-weight optimizer

B1 now treats each tier's rarity weights as an active economic config in `pack_config_versions`. Pack purchase reads the active config for the tier inside the purchase transaction and stores `config_version_id` on `pack_purchases`. That means purchased packs are tied to the weights active at purchase time; later rebalances affect future purchases, not already-created pack openings.

Default economic targets:
- `TARGET_MARGIN = 0.20`: each tier targets 20% gross margin, so target EV is 80% of pack price.
- `WIN_RATE_FLOOR = 0.25`: Pro and Elite target at least one winning pack in four, where a win means `pack_value >= pack_price`.
- Basic uses a tier-specific `0.15` win-rate floor because a $5, 3-card pack has less room to maintain both 20% margin and frequent wins.

Expected value math:
```
EV_tier = cards_per_pack * sum(weight_r * avg_market_value_r)
target_EV = pack_price * (1 - target_margin)
margin = (pack_price - EV_tier) / pack_price
win_rate = simulated_count(pack_value >= pack_price) / simulation_runs
```

Market values come from the full Pokemon card pool, not only already-opened cards. For each pool card, the engine uses observed average `cards.market_value` when available; otherwise it uses a stable rarity-based fallback estimate. Rarity averages are computed from that full pool snapshot.

Current optimization flow:
1. Load active drop price, cards per pack, active config, and pool market averages.
2. Build `w_profit` by greedily placing as much weight as allowed on the cheapest rarities.
3. Build `w_excite` by greedily placing as much weight as allowed on the most expensive rarities.
4. Binary search an interpolation value `alpha` for 50 iterations:
   ```
   w(alpha) = (1 - alpha) * w_profit + alpha * w_excite
   ```
5. Select the highest-excitement weight vector whose analytical EV stays at the 20% target margin.
6. Project weights back into the bounded simplex so they sum to 1 and respect rarity min/max bounds.
7. Apply the per-rebalance delta cap against the currently active config.
8. Run Monte Carlo validation with 10,000 pack openings.
9. If win rate is too low, bump `alpha` by `0.02` steps, accepting up to a 5 percentage-point margin concession during the search, then rerun full validation.
10. Activate a new config only if acceptance rules pass; otherwise keep the current config.

Constraint rules:
- every rarity has configured min/max bounds, so the optimizer cannot make packs 99% commons or remove chase-card odds entirely
- shared rarities can move by at most `MAX_WEIGHT_DELTA = 0.08` per rebalance cycle
- weight totals must equal `1.0 +/- 0.001`
- candidates must satisfy tier margin and tier win-rate floors in simulation before activation

Simulation and admin endpoints:
- `POST /analytics/simulate`: admin-only Monte Carlo simulation, default 10,000 runs, max 50,000, optional tier and custom weights
- `POST /analytics/rebalance`: manual rebalance, with optional `dryRun`
- `GET /analytics/drift`: current margin drift by tier
- `GET /analytics/config-history/:tier`: version history and market snapshots

Automatic rebalancing:
- The worker runs `rebalanceIfNeeded("scheduled")` every `REBALANCE_INTERVAL_MINUTES`.
- Drift is `abs(active_margin - target_margin)`.
- A tier rebalances when drift exceeds `DRIFT_THRESHOLD = 0.05`.
- If a single card spikes or crashes, the affected rarity's average and simulation distribution shift; bounds plus the delta cap prevent violent one-cycle changes.
- If the pool is too small or structurally infeasible, the optimizer rejects the candidate and leaves the current active config in place.

### Implementation detail summary

**Overview**: The B1 system is a sophisticated rarity weight optimizer that maintains target platform margins while ensuring acceptable user win rates through mathematical optimization and Monte Carlo validation.

**Core Mathematical Algorithm**:

1. **Binary Search Optimization**
   - Constructs two endpoint weight vectors:
     - `w_profit`: Max weight on cheapest rarities (maximizes platform margin)
     - `w_excite`: Max weight on most expensive rarities (maximizes user EV/variance)
   - Binary search on interpolation parameter `α ∈ [0,1]` to find `α*` where:
     ```
     EV(α) = N × Σᵣ w(α)[r] × μᵣ = P × (1 - M)
     ```
     Where `N` = cards per pack, `μᵣ` = market average for rarity `r`, `P` = pack price, `M` = target margin
   - Converges to `<0.0001%` error in 50 iterations

2. **Monte Carlo Validation Engine**
   - Runs 10,000 simulations per optimization cycle
   - Uses the full Redis-backed pack pool as the simulation universe, with per-card market values derived from observed card-specific prices when available and stable rarity-based fallback prices otherwise
   - Computes comprehensive statistics:
     - Mean/median/stddev pack values
     - Percentile distribution (p5, p10, p25, p50, p75, p90, p95)
     - Win rate: fraction where `pack_value >= pack_price`
     - Projected profit per 1,000/10,000 packs
     - Rarity hit rates vs. target weights

**Mathematical Constraints and Parameters**:

| Parameter | Value | Mathematical Purpose |
|---|---|---|
| `TARGET_MARGIN` | `0.20` (20%) | Platform gross margin target |
| `WIN_RATE_FLOOR` | `0.25` default; Basic `0.15` | Minimum "winning" pack rate for retention |
| `MAX_WEIGHT_DELTA` | `±0.08` (±8%) | Prevents whiplash from price volatility |
| `DRIFT_THRESHOLD` | `0.05` (5%) | Triggers rebalance when margin drifts >5% |
| `MARGINAL_WIN_RATE_BUFFER` | `0.02` (2%) | Warning buffer above win-rate floor |
| `MAX_MARGIN_CONCESSION` | `0.05` (5%) | Maximum margin sacrifice for win-rate adjustment |
| `SIMULATION_RUNS` | `10,000` | Monte Carlo sample size for validation |

**Weight Bounds per Rarity** (min/max to prevent degenerate solutions):
```
Common:           [0.15, 0.85]
Uncommon:         [0.08, 0.50]
Rare:             [0.02, 0.35]
Holo Rare:        [0.01, 0.25]
Ultra Rare/EX/GX: [0.005, 0.15]
Secret Rare:      [0.002, 0.08]
```

**Acceptance Rules** (ALL must pass for activation):
1. **Margin Rule**: `simulated_margin >= target_margin`
2. **Win-Rate Rule**: `win_rate >= WIN_RATE_FLOOR`
3. **Bounds Rule**: All weights within `[min, max]` per rarity
4. **Delta Cap Rule**: `|new_weight - current_weight| <= MAX_WEIGHT_DELTA`
5. **Normalization Rule**: `Σ weights = 1.0 ± 0.001`

**Feasibility Classification**:
- **FEASIBLE**: Passes all acceptance rules with healthy buffer
- **MARGINAL**: Passes but within 2% of win-rate floor (monitor closely)
- **INFEASIBLE**: Fails acceptance rules (rejected, current config kept active)

**Win-Rate Adjustment Algorithm**:
When Monte Carlo shows `win_rate < WIN_RATE_FLOOR`:
1. Increment `α` by `WIN_RATE_ALPHA_BUMP` (0.02)
2. Recompute weights and validate margin concession (max 5% below target)
3. Re-run Monte Carlo validation
4. Repeat until win-rate satisfied or margin concession exceeded
5. If still infeasible → reject candidate, keep current config

**Drift Detection and Rebalancing**:
- Background worker checks each tier's `active_margin` against live prices every `REBALANCE_INTERVAL_MINUTES`
- Computes: `drift = |current_active_margin - target_margin|`
- Triggers rebalance when: `drift > DRIFT_THRESHOLD`
- Manual triggers: bootstrap, price anomalies, administrative requests

**Version Control System**:
- Each optimization creates versioned config with:
  - Rarity weights and market snapshot
  - Analytical EV and simulated metrics
  - Trigger reason and timestamp
- Only one config active per tier (enforced by database constraint)
- Complete audit trail for debugging and rollback

**Mathematic Properties**:
- **Monotonicity**: EV increases monotonically with α (enables binary search)
- **Convexity**: Weight space is convex (linear interpolation between valid vectors)
- **Convergence**: Binary search guaranteed to find α* satisfying EV constraint
- **Robustness**: Delta cap prevents large jumps, Monte Carlo catches edge cases

---

## 11) B2 - Anti-bot and fairness hardening

### Redis-first atomic sliding windows

B2 moves request limiting from sequential per-bucket checks to a single Redis Lua evaluation per route class. We kept sorted-set sliding windows instead of fixed counters because they provide precise rolling windows under bursty contention and survive process restarts across multiple API instances.

For each request, the script:
- trims expired members from every relevant bucket
- evaluates all bucket counts before consuming anything
- rejects immediately if any bucket is saturated
- inserts the new request into every bucket only when all buckets pass

This removes the old partial-consumption failure mode where an earlier window could be charged before a later window rejected the same request. It also guarantees that 100 concurrent requests on one hot key admit exactly the configured limit.

Key families:
- `rate_limit:api:user:<userId>:minute`
- `rate_limit:api:ip:<ip>:minute`
- `rate_limit:auth:ip:<ip>:minute|hour`
- `rate_limit:pack_purchase:user:<userId>:minute|hour|day`
- `rate_limit:pack_purchase:ip:<ip>:minute|hour`
- `rate_limit:marketplace:user:<userId>:hour`
- `rate_limit:marketplace:ip:<ip>:hour`

TTL semantics:
- each sorted set gets a `PEXPIRE` slightly longer than its window
- the set self-cleans via `ZREMRANGEBYSCORE` on every request
- no SQL persistence is required because this state is transient enforcement state

### Hybrid Redis outage behavior

Redis outage handling is explicit and route-class aware:
- `PACK_PURCHASE`, `AUTH`, and `MARKETPLACE` write paths fail closed with `503`
- read-only `API` routes degrade open and emit degraded headers plus warning logs

This preserves anti-bot integrity on contested or state-changing flows while avoiding a full read outage for low-risk list/read endpoints.

### Automatic fairness window

The fairness queue concept remains Redis-backed and ephemeral, but B2 changes it from a manual queue into an automatic short-window lottery:
- fairness opens only when the drop is under pressure
- pressure combines low remaining inventory ratio with active short-interval contention
- eligible users receive at most one entry per drop per window
- after the window closes, the server deterministically selects winners up to current inventory
- winners receive a claimable slot; losers are told they lost without being charged

Deterministic winner selection is based on sorting participants by `SHA256(dropId, windowId, userId)`. This keeps the outcome testable and reproducible for a fixed input set while still removing fastest-client determinism.

Key families:
- `fairness_status:<dropId>`
- `fairness_window:<dropId>`
- `fairness_requests:<dropId>` for contention pressure
- `fairness_entries:<dropId>:<windowId>` for per-user queue metadata
- `fairness_results:<dropId>:<windowId>` for `AVAILABLE|CLAIMED|CONSUMED|LOST`
- `fairness_processing_lock:<dropId>` for single-window processing ownership

TTL semantics:
- contention keys live only for the short contention interval
- active fairness window metadata lives through queue open plus claim time
- results expire after the claim window because they are transient purchase rights, not financial truth

### Soft-first bot handling

The bot detector still uses multi-signal scoring, but the action ladder changes:
- low score: allow normally
- medium score: throttle by tightening pack purchase limits and forcing fairness participation when fairness is relevant
- high-confidence indicators: block immediately

Signals retained in B2:
- suspicious user agents
- too-fast repeated timing
- low timing variance across repeated attempts
- very new account age
- many accounts on one IP
- purchase-heavy behavior without normal marketplace participation

Timing/history tracking that feeds enforcement is now updated atomically in Redis so the signal path itself is less race-prone.

### Observability

B2 emits structured logs around:
- limiter degraded-open / degraded-closed events
- fairness window open and process events
- fairness participant and winner counts
- bot blocking and suspicious activity flags

---

## 12) B3 - Auction integrity

B3 adds an integrity layer on top of the Part A auction transaction model. The database remains the source of truth, but the bidding flow now changes state near the end of an auction and records post-settlement review signals for admins.

### Sniping prevention beyond anti-snipe timers

Auctions now use a sealed-bid endgame:
- Normal auctions start in `LIVE` or `CLOSING` open ascending-bid mode.
- When an auction is within `SEALED_BID_WINDOW_SECONDS` (`30s`) of `end_time`, reads and bids promote it to `SEALED_ENDGAME`.
- Socket.io emits `auction:sealed:status` so existing auction rooms can switch UI mode without a page reload.
- During `SEALED_ENDGAME`, bidders submit or replace a hidden max bid in `sealed_bids`; the public `current_bid` and open bid history no longer reveal the new max bids.
- Funds are held for each bidder's current hidden max. Replacing a sealed bid atomically holds only the delta or releases the reduction.
- Settlement computes a second-price result from sealed candidates plus the current open leader. The winner pays the runner-up max plus the normal increment, capped by their own max.

Why this prevents endgame leakage:
- Bots cannot observe the true final willingness-to-pay of competitors during the last 30 seconds.
- Last-millisecond timing is less valuable because the final clearing price comes from hidden maximums, not the last visible bid.
- The open leader is included as a sealed candidate at the visible current bid, so the transition composes with existing open-bid state.

### Bid validation hardening

The bid path enforces several rules inside the auction transaction:
- **Minimum increment:** next bid must be at least `max($1.00, 5% of current bid)` above the current bid.
- **Self-bidding:** the seller cannot bid on their own auction.
- **Fat-finger confirmation:** a bid requires explicit confirmation when it is both at least `2x` the current-bid reference and at least `3x` card market value. If no market value exists, the current-bid multiple alone is used.
- **Open-bid pacing:** Redis enforces a `1500ms` per-user cooldown per auction plus a sliding window of at most `5` open bids per `10s`.
- **Sealed-bid update pacing:** Redis enforces a `1000ms` per-user sealed max update cooldown.
- **Idempotency:** open and sealed bid tables each deduplicate by `(bidder_id, idempotency_key)`.
- **Held funds:** bid holds and releases are done before state changes commit, preventing users from overcommitting across auctions.

### Wash-trade and collusion review flags

Flagging happens during settlement via `runIntegrityReview`; flagged auctions are inserted into `auction_integrity_flags` with `status='OPEN'` and are not auto-cancelled.

Current heuristics:
- `REPEATED_SELLER_WINNER_PAIR`, severity `3`: same seller/winner pair has at least `3` settlements in the last `30 days`.
- `LOW_CLOSE_WITHOUT_COMPETITION`, severity `2`: final price is below `65%` of market value and there was at most one distinct bidder.
- `SEALED_ENDGAME_LOW_COMPETITION`, severity `1`: auction reached sealed endgame but had two or fewer bidders.
- `MICRO_BID_LADDER`, severity `1`: one bidder placed at least `8` visible bids in the auction.

These are intentionally review heuristics rather than hard enforcement. The goal is to catch obvious collusion and suspicious low-competition outcomes while leaving legitimate repeat buyers, niche-card auctions, and normal single-bid outcomes available for admin judgment.

### Auction analytics

Admin analytics include auction integrity health in `GET /analytics/dashboard`:
- participation rate: percent of auctions whose visible `current_bid` is above zero
- average bidders per auction, counting both open and sealed bidders
- sealed endgame rate
- low-close rate against market value
- flag rate and total review flags
- snipe rate, measured by auctions with anti-snipe extensions
- recent flagged auction summaries with seller, winner, final price, market value, bidder count, severity, and details

The admin analytics page consumes these dashboard fields, and core auction actions emit `analytics:dashboard:invalidated` so the dashboard can refresh after auction creation, open bids, sealed bids, and settlement.

### WebSocket and UI composition

The existing room flow remains intact:
- Clients join `auction:<id>` through `join:auction`.
- Open bids continue to emit `auction:updated` and `auction:bid:history`.
- Sealed-state transitions emit `auction:sealed:status`.
- Settlement emits `auction:closed` with `winning_max_bid` and `final_clearing_price`.
- The web auction page renders `SEALED_ENDGAME`, labels the visible price as a floor, hides competitors' sealed max bids, shows the user's own sealed max, and displays second-price settlement details after close.

### Persistence

B3 uses these persisted fields and tables:
- `auctions.status` includes `SEALED_ENDGAME`.
- `auctions.sealed_phase_started_at`, `sealed_phase_ends_at`, `sealed_bid_floor`, `winning_max_bid`, and `final_clearing_price` record lifecycle and settlement pricing.
- `sealed_bids` stores one hidden max per `(auction_id, bidder_id)` plus idempotency.
- `auction_settlements` stores winner, gross amount, winning max, final clearing price, fee, and idempotency.
- `auction_integrity_flags` stores review flags, severity, JSON details, status, and created time.

### Test coverage

`apps/server/test/auctionIntegrity.test.ts` covers:
- snapshot promotion into sealed endgame near the threshold
- second-price sealed settlement
- sealed bid replacement and held-fund adjustment
- seller self-bid rejection
- rapid open-bid pacing rejection

---

## 13) B4 - Provably fair pack openings

PullVault now supports a commit-reveal pack opening proof built on SHA-256 and HMAC-SHA256.

Commit at purchase preparation time:
- Server creates `server_seed` (32 random bytes, hex).
- Server stores `server_seed_hash = SHA256(server_seed)` and returns only hash + commitment ID.
- User provides `client_seed` when buying.

Deterministic opening generation:
- Pack cards are generated at purchase time from HMAC draws keyed by `server_seed`.
- Inputs are canonicalized and include `purchaseId`, `dropId`, `configVersionId`, `clientSeed`, `nonce`, `slot`, and `cardPoolHash`.
- Rarity draws use integer micros (`sum = 1_000_000`) to avoid float drift.
- Card selection and initial acquisition value are deterministic from the same seed chain.

Reveal and verification:
- Reveal/public proof exposes `server_seed`, `server_seed_hash`, `client_seed`, rarity micros, card pool snapshot/hash, and selected card hash.
- Browser verification recomputes hash and full derived card list locally, without trusting server-side verdict APIs.
- If server_seed is altered after commitment, the recomputed SHA256(server_seed) will not match the stored server_seed_hash returned to the user at purchase time, and browser verification will report a failed hash check, invalidating the result.
- The verification process does not short-circuit on hash failure. By running the full derivation even after a hash mismatch, the system provides a stronger audit trail that confirms both the seed was tampered with and that the resulting cards differ from the original committed result.

Public audit log:
- Every opening appends a tamper-evident event (`event_hash`, `previous_event_hash`) to `pack_opening_audit_events`.
- Public audit page can verify chain continuity and aggregate rarity configuration usage.

Indexes introduced for B4:
- `pack_fairness_commitments`: unique `server_seed_hash`, unique `purchase_id`, plus `(reserved_by,status,expires_at)` and `(status,expires_at)` for reservation lookup/expiry cleanup.
- `pack_opening_fairness`: PK `purchase_id`, unique `commitment_id`, plus `(created_at)`, `(drop_id,created_at)`, `(config_version_id,created_at)` for proof lookup and distribution analysis.
- `pack_opening_audit_events`: unique `event_hash`, `(created_at,id)` for pagination, `(purchase_id)` for drill-down.

These logs are intentionally shaped so a later metrics pipeline or dashboard can consume them without changing the core enforcement flow again.

---

## 14) B5 - Platform health dashboard

The admin dashboard now extends beyond economics and reports four operational areas on `GET /analytics/dashboard`:

- Fraud health: rate-limit block behavior, degraded limiter mode counts, bot throttle/block activity, and high-risk account queue.
- Economic health: rolling 24h realized margin by tier (actual vs active target), plus revenue projections and margin alerts.
- Fairness audit: rarity distribution goodness-of-fit against advertised weights using a chi-squared test (7d window), with p-value and significance state.
- User health: auction participation, drop engagement, marketplace conversion, and D1/D7 retention with a composite health state.

### Real-time behavior

The dashboard keeps 30s polling and also subscribes to `analytics:dashboard:invalidated` Socket.io events. Core transactional flows emit invalidations after pack purchases, listing actions, auction actions, bot/rate-limit enforcement, and fairness verification events.

### New observability tables and index justification

`rate_limit_events`
- `created_at`: primary time-window scans for 24h/7d dashboards.
- `(route_type, created_at)`: route-level limiter effectiveness queries.
- `(allowed, created_at)`: fast blocked vs allowed aggregation.
- `(blocked_by, created_at)`: top blocked bucket ranking.

`bot_activity_events`
- `created_at`: rolling fraud trend window.
- `(user_id, created_at)`: flagged-account queue and recent user drilldown.
- `(action, created_at)`: throttle/block trend splits.
- `(score, created_at)`: high-score screening.

`fairness_verification_events`
- `created_at`: verification adoption trend windows.
- `(purchase_id, created_at)`: purchase-level verification drilldown.
- `(user_id, created_at)`: distinct verified users.
- `(client_fingerprint_hash, created_at)`: anonymous session-level adoption without storing raw fingerprint strings.
