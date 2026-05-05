# PullVault

PullVault is a paper-trading card marketplace simulation focused on one thing first: correctness under concurrency.  
It combines pack drops, P2P listings, live auctions, and real-time portfolio updates.

## Repository Structure
- `apps/web`: Next.js 14 + TypeScript + Tailwind frontend
- `apps/server`: Express + Socket.io API with background workers
- `packages/common`: shared Zod schemas, event names, and contracts
- `docs/architecture.md`: full architecture and tradeoff writeup
- `infra/migrations`: SQL migrations

## Tech Stack
- Frontend: Next.js App Router, React, TypeScript, Tailwind
- Backend: Express, Socket.io, TypeScript
- Data: PostgreSQL (source of truth), Redis (idempotency/cache)
- Testing: Jest + Supertest (including concurrency suites)

## What Is Implemented

### Part A: Core Platform Features ✅
- JWT authentication with starting paper balance ($1000)
- Pack drops with live window enforcement and atomic purchase flow
- Server-side pack generation at purchase time + reveal endpoint
- Marketplace listing/buy with atomic ownership + balance transfer
- Live auctions with bid concurrency handling and anti-snipe extension
- Settlement worker for auction close and fee distribution
- Idempotency key handling for financial write APIs
- Portfolio summary/history + websocket updates
- Pokemon TCG metadata ingestion + simulated rarity-based price movement
- Admin economics dashboard endpoint

### Part B: Production Hardening ✅
- **B1 - Pack Economics:** Dynamic rarity-weight optimization with Monte Carlo validation
- **B2 - Anti-Bot:** Atomic rate limiting, automatic fairness windows, multi-signal bot detection
- **B3 - Auction Integrity:** Sealed-bid endgame (60s), staggered anti-snipe warning (90s-60s), wash-trade detection, enhanced bid validation
- **B4 - Fairness:** Cryptographic pack opening verification with public audit log
- **B5 - Health Dashboard:** Fraud/economic/fairness/user health metrics with real-time updates

**All features maintain financial correctness as the primary invariant, with Part B adding production-ready hardening on top of Part A's solid foundation.**

## Quick Start
### 1) Install dependencies
```bash
npm install
```

### 2) Configure environment
```bash
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.local.example apps/web/.env.local
```

If you are on Windows PowerShell:
```powershell
Copy-Item apps/server/.env.example apps/server/.env
Copy-Item apps/web/.env.local.example apps/web/.env.local
```

### 3) Bootstrap database
```bash
npm run db:bootstrap -w @pullvault/server
```

Optional commands:
```bash
npm run db:migrate -w @pullvault/server
npm run db:seed -w @pullvault/server
npm run db:cleanup:test -w @pullvault/server
```

### 4) Run app
```bash
npm run dev
```

- Web: `http://localhost:3000`
- API + Socket.io: `http://localhost:4000`
- Health check: `GET /health`

## Environment Variables
### `apps/server/.env`
- `PORT` (default `4000`)
- `CORS_ORIGIN` (default `http://localhost:3000`)
- `JWT_SECRET`
- `DATABASE_URL`
- `REDIS_URL`
- `PLATFORM_USER_ID`
- `POKEMON_TCG_API_KEY` (optional but recommended)
- `POKEMON_TCG_API_BASE` (default `https://api.pokemontcg.io/v2`)
- `PRICE_TICK_SECONDS` (default `45`)

### `apps/web/.env.local`
- `NEXT_PUBLIC_API_BASE` (default `http://localhost:4000`)
- `NEXT_PUBLIC_SOCKET_BASE` (default `http://localhost:4000`)

## Test Commands
### Run all tests from repo root
```bash
npm run test
```

### Run all server tests directly
```bash
npm run test -w @pullvault/server
```

### Watch mode (server tests)
```bash
npm run test:watch -w @pullvault/server
```

### Concurrency suite only
```bash
npm run test:concurrency -w @pullvault/server
```

Before tests, create `apps/server/.env.test` from `.env.test.example` and point to isolated Postgres/Redis.

### Concurrency test files included
- `apps/server/test/concurrency/packDrop.concurrency.test.ts`
- `apps/server/test/concurrency/marketplace.concurrency.test.ts`
- `apps/server/test/concurrency/auction.concurrency.test.ts`

### Current test scope notes
- Web app (`apps/web`) does not currently define automated test scripts.
- Shared package (`packages/common`) does not currently define automated test scripts.

## API Surface

### Part A: Core Platform Endpoints
**Authentication:**
- `POST /signup`
- `POST /login`
- `GET /me`

**Pack Drops:**
- `GET /drops`
- `POST /packs/buy`
- `GET /packs/:purchaseId/reveal`

**Marketplace:**
- `POST /listings`
- `GET /listings`
- `POST /listings/:id/buy`

**Auctions:**
- `POST /auctions`
- `GET /auctions/live`
- `GET /auctions/:id/snapshot`
- `POST /auctions/:id/bids`

**Portfolio & Collection:**
- `GET /collection`
- `GET /portfolio/summary`
- `GET /portfolio/history`

**Admin & Workers (Part A):**
- `GET /analytics/dashboard` (basic economics metrics)
- `POST /workers/settlement/tick`

### Part B: Hardening & Analytics Endpoints
**Pack Economics (B1):**
- `POST /analytics/simulate` - Admin Monte Carlo simulation (default 10,000 runs)
- `POST /analytics/rebalance` - Manual rebalance with optional `dryRun` parameter
- `GET /analytics/drift` - Current margin drift by tier
- `GET /analytics/config-history/:tier` - Rarity weight version history

**Auction Integrity (B3):**
- `POST /auctions/:id/sealed-bids` - Submit/update sealed max bid for endgame
- `GET /auctions/:id/integrity-flags` - Admin review of suspicious auction patterns

**Fairness Verification (B4):**
- `GET /packs/:purchaseId/fairness-proof` - Cryptographic verification data
- `GET /fairness/audit-log` - Public audit log of all pack openings
- `GET /fairness/verify/:purchaseId` - Browser-based verification endpoint

**Platform Health (B5):**
- `GET /analytics/dashboard` - Enhanced with fraud/economic/fairness/user health metrics
- `GET /analytics/health/fraud` - Rate limit blocks, bot activity, degraded mode
- `GET /analytics/health/economics` - Rolling margins, revenue projections, alerts
- `GET /analytics/health/fairness` - Rarity distribution chi-squared test results
- `GET /analytics/health/users` - Engagement, retention, conversion metrics

**Admin Operations:**
- `POST /admin/fairness-flags/:flagId/resolve` - Resolve auction integrity flags
- `POST /admin/rate-limits/reset` - Reset user-specific rate limits (admin only)

## Architecture Overview

**Detailed architecture documentation:** `docs/architecture.md`

### Part A: Core Platform Architecture (Baseline)

**Foundation Principles:**
- PostgreSQL is the financial source of truth for all balances, inventory, and ownership
- Redis provides idempotency keys, caching, and transient enforcement state
- Concurrency safety enforced through database transactions + row-level locks (`FOR UPDATE`)
- Money movement and ownership transfer are committed atomically
- Socket.io delivers real-time UX signals (drops, bids, listings, portfolio, prices)
- Background workers handle settlement, drop sync, price ticks, and portfolio snapshots

**Design Philosophy:**
- Financial correctness first (ACID transactions), then real-time UX
- Single-server Socket.io acceptable for Part A focus on transactional safety
- Database row locks provide stronger correctness than distributed locks for current scale
- Server-side pack determination prevents client-side manipulation

### Part B: Production Hardening Features

#### B1 - Pack Economics Algorithm
- **Dynamic rarity-weight optimizer** that maintains target platform margins while ensuring acceptable user win rates
- **Mathematical optimization** using binary search and Monte Carlo validation (10,000 simulations)
- **Automatic rebalancing** when margin drift exceeds 5% threshold
- **Version control** for rarity weights with audit trail and rollback capability
- **Target metrics:** 20% platform margin, 25% minimum win rate (15% for Basic packs)

#### B2 - Anti-Bot & Fairness Hardening
- **Atomic Redis Lua rate limiting** - single script evaluates all buckets before consuming any window
- **Hybrid Redis outage behavior** - read-only routes degrade open, financial write paths fail closed (503)
- **Automatic fairness windows** for contested drops - replaces fastest-client-wins with deterministic lottery
- **Soft-first bot handling** - medium-risk traffic gets throttled, high-confidence automation blocked
- **Multi-signal bot detection** using timing patterns, user agents, account age, and purchase behavior

#### B3 - Auction Integrity
- **Sealed-bid endgame** for final 60 seconds prevents sniping and endgame leakage. Staggered anti-snipe extensions (12s) are provided in the preceding 30-second warning window (90s-60s) for eligible auctions.
- **Second-price settlement** from sealed bids - winner pays runner-up max plus increment.
- **Anti-snipe (12s)** for short auctions (1min) in the final 30s window.
- **Enhanced bid validation** - self-bid blocking, fat-finger confirmation, pacing limits
- **Wash-trade detection** - flags suspicious patterns (repeated seller/winner pairs, low closes, micro bidding)
- **Integrity analytics** for admin review of auction health and suspicious activity

#### B4 - Provably Fair Pack Openings
- **Commit-reveal scheme** using SHA-256 and HMAC-SHA256 for cryptographic fairness
- **Deterministic card generation** from seeded RNG chain with canonical inputs
- **Browser verification** - users can verify pack openings without trusting server APIs
- **Public audit log** - tamper-evident chain of all pack openings for transparency
- **Zero-knowledge proof** that server cannot alter outcomes after commitment

#### B5 - Platform Health Dashboard
- **Fraud health metrics** - rate-limit blocks, bot activity, degraded mode counts
- **Economic health tracking** - rolling 24h margins by tier, revenue projections, margin alerts
- **Fairness verification** - chi-squared goodness-of-fit test for rarity distributions (7d window)
- **User health analytics** - auction participation, drop engagement, marketplace conversion, retention
- **Real-time updates** via Socket.io invalidation events

---

**For comprehensive architecture details, tradeoff analysis, and mathematical formulations, see [`docs/architecture.md`](docs/architecture.md)**

## Correctness Under Concurrency

### Part A: Database-Level Safety (Baseline)
- **Pack purchases:** Lock drop row, validate inventory/time, debit buyer, decrement inventory, create purchase - all in one ACID transaction
- **Marketplace buys:** Lock listing and card market state, transfer funds/ownership, apply fee - commit atomically
- **Auction bids:** Lock auction row, enforce min increment, hold/release bidder balances, update bid state atomically
- **Balance invariant:** `available + held = total` maintained via database CHECK constraints
- **Idempotency keys:** Prevent duplicate financial side effects on network retries

### Part B: Enhanced Concurrency Protection
- **B2 Fairness windows:** Automatic lottery system for contested drops eliminates fastest-client-wins advantage
- **B2 Atomic rate limiting:** Redis Lua scripts evaluate all rate limit buckets before consuming any window
- **B2 Bot protection:** Multi-signal detection with soft-first enforcement (throttle → block)
- **B3 Sealed-bid auctions:** Prevents endgame timing attacks and sniping exploitation
- **B3 Pacing limits:** Redis-backed per-user bid timing controls prevent auction manipulation
- **B4 Cryptographic fairness:** Commit-reveal scheme ensures server cannot alter pack outcomes after commitment

**For detailed concurrency guarantees and mathematical proofs, see `docs/architecture.md` section 3.**

## Platform Economics

### Part A: Economic Foundation
- **Currency:** USD paper trading
- **Starting balance:** `$1000` per user
- **Fees:** `5%` trading fee, `7%` auction fee
- **Pack tiers:** Basic ($5), Pro ($15), Elite ($40) with fixed card counts and rarity weights
- **Price engine:** Pokemon metadata + simulated rarity-driven pricing with drift
- **Market simulation:** Card values move by ±1.2% per price tick (default 45s)

### Part B: Economic Enhancements
- **B1 Dynamic Economics:** Automatic rarity-weight optimization to maintain 20% platform margin
- **Target margin validation:** Monte Carlo simulation ensures EV stays within bounds
- **Market responsiveness:** Weights rebalance when card prices cause margin drift >5%
- **Win rate guarantees:** Minimum 25% win rate for Pro/Elite, 15% for Basic packs
- **Version control:** All economic changes tracked with audit trail and rollback capability

**For complete EV math, rarity weight formulas, and optimization algorithms, see `docs/architecture.md` section 10.**

## Implementation Scope

### Part A: Foundation (Completed)
- JWT authentication with starting paper balance ($1000)
- Pack drops with live window enforcement and atomic purchase flow
- Server-side pack generation at purchase time + reveal endpoint
- Marketplace listing/buy with atomic ownership + balance transfer
- Live auctions with bid concurrency handling and anti-snipe extension
- Settlement worker for auction close and fee distribution
- Idempotency key handling for financial write APIs
- Portfolio summary/history + websocket updates
- Pokemon TCG metadata ingestion + simulated rarity-based price movement
- Admin economics dashboard endpoint

### Part B: Production Hardening (Completed)
- **B1:** Pack economics algorithm with dynamic rarity-weight optimization
- **B2:** Anti-bot hardening with atomic rate limiting and automatic fairness windows
- **B3:** Auction integrity with sealed-bid endgame and wash-trade detection
- **B4:** Provably fair pack openings with cryptographic verification
- **B5:** Platform health dashboard with fraud, economic, fairness, and user metrics

### Intentional Scope Cuts
The following features were deferred to maintain focus on transactional correctness and market loop viability:

- **Multi-node websocket fanout** (no Redis pub/sub adapter yet) - Single-server Socket.io acceptable for current scale
- **Distributed locking service** - Database row locks provide stronger correctness for current requirements
- **Event-sourced ledger** - Simpler ACID transaction flows reduce implementation risk
- **Advanced pricing rebalancer features** - Core optimization implemented in B1; further enhancements deferred
- **Production observability stack** - Basic monitoring implemented, advanced alerting deferred

**For detailed rationale on these tradeoffs, see `docs/architecture.md` sections 6-7.**

## Evaluation Criteria
| Criteria | Weight | What we look for |
|----------|--------|-----------------|
| Correctness Under Concurrency | 30% | Pack drops don't oversell. Trades are atomic. Auctions handle simultaneous bids. Balances always consistent. |
| Real-Time Experience | 20% | WebSocket updates feel instant. Auction room is live. Portfolio values update. Reconnection handled. |
| System Design & Architecture | 20% | Clean separation. Schema makes sense. API is RESTful. Architecture doc shows tradeoff understanding. Parameter choices are justified. |
| Platform Economics | 15% | Pack EV math is sound. Fee structure reasonable. Dashboard exists. Candidate can explain the business model. |
| Code Quality & Polish | 15% | TypeScript used properly. Error handling exists. UI is usable. README is helpful. |

## Part A vs Part B Feature Matrix

| Feature Area | Part A (Baseline) | Part B (Hardening) |
|--------------|-------------------|-------------------|
| **Pack Economics** | Fixed rarity weights, static pricing | Dynamic optimization, automatic rebalancing |
| **Concurrency Safety** | DB transactions + row locks | Fairness windows, atomic rate limiting |
| **Auction Integrity** | Basic anti-snipe, transaction safety | Sealed-bid endgame, wash-trade detection |
| **Bot Protection** | Basic rate limiting | Multi-signal detection, soft-first enforcement |
| **Fairness Guarantees** | Financial correctness only | Cryptographic proof, public verification |
| **Observability** | Basic economics dashboard | Comprehensive health monitoring + analytics |
| **Scalability** | Single-server focus | Production-ready enforcement patterns |

**Implementation Philosophy:**
- **Part A** proves core transactional correctness and market loop viability
- **Part B** adds production hardening for abuse resistance, fairness, and operational visibility
- Both parts maintain financial correctness as the primary invariant

## Notes
- Money math uses `decimal.js` to avoid floating-point precision issues
- Financial operations never bypass database transactions or idempotency checks
- Part B features build upon Part A foundations without breaking existing guarantees
- For detailed implementation questions, refer to specific sections in `docs/architecture.md`
