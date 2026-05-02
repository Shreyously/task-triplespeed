# PullVault Architecture (Part A)

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
| Anti-Snipe | If bid arrives in final `10s`, extend by `10s`, up to `6` times | Fair response window without infinite extension |
| Rarity Weights | See table below | Higher tiers allocate more weight to premium rarities |

### Rarity weights by tier

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

Planned Part B lever: tune tier prices and/or rarity weights dynamically to hit target blended margin while preserving “occasional win” feel.

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
