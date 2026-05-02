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
- JWT auth with starting paper balance (`$1000`)
- Pack drops with live window enforcement and atomic purchase flow
- Server-side pack generation at purchase time + reveal endpoint
- Marketplace listing/buy with atomic ownership + balance transfer
- Live auctions with bid concurrency handling and anti-snipe extension
- Settlement worker for auction close and fee distribution
- Idempotency key handling for financial write APIs
- Portfolio summary/history + websocket updates
- Pokemon TCG metadata ingestion + simulated rarity-based price movement
- Admin economics dashboard endpoint

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
- `POST /signup`
- `POST /login`
- `GET /me`
- `GET /drops`
- `POST /packs/buy`
- `GET /packs/:purchaseId/reveal`
- `POST /listings`
- `GET /listings`
- `POST /listings/:id/buy`
- `POST /auctions`
- `GET /auctions/live`
- `GET /auctions/:id/snapshot`
- `POST /auctions/:id/bids`
- `GET /collection`
- `GET /portfolio/summary`
- `GET /portfolio/history`
- `GET /analytics/dashboard` (admin)
- `POST /workers/settlement/tick`

## Architecture Overview
Detailed version: `docs/architecture.md`.

Short summary:
- PostgreSQL is the financial source of truth.
- Redis is used for idempotency/cache, not as primary state.
- Concurrency safety is enforced with DB transactions + row locks (`FOR UPDATE`).
- Money movement and ownership transfer are committed atomically.
- Socket.io provides real-time UX signals (drops, bids, listings, portfolio, prices).
- Workers handle settlement, drop sync, price ticks, and portfolio snapshots.

## Correctness Under Concurrency (How it is enforced)
- Pack buys: lock drop row, validate inventory/time, debit buyer, decrement inventory, create purchase, commit in one transaction.
- Listing buys: lock listing/card market state, transfer funds/ownership, apply fee, commit atomically.
- Auction bids: lock auction row, enforce min increment, hold/release bidder balances, update bid state atomically.
- Balance invariant maintained in DB: `available + held = total`.
- Idempotency keys prevent duplicate financial side effects on retries.

## Platform Economics (Current Part A)
- Currency: USD paper trading
- Starting balance: `$1000`
- Fees: `5%` trading, `7%` auction
- Pack tiers: Basic/Pro/Elite with fixed price, card count, inventory, and rarity weights
- Price engine: Pokemon metadata + simulated rarity-driven pricing and drift

For full EV math and parameter rationale, see `docs/architecture.md` section 4.

## Scope Cuts (Intentional for this phase)
- Multi-node websocket fanout (no Redis pub/sub adapter yet)
- Distributed locking service (DB row locks are used instead)
- Event-sourced ledger as primary write path
- Dynamic odds/pricing rebalancer for margin optimization
- Production-grade observability/alerting stack

These were deferred to keep focus on transactional correctness, race safety, and end-to-end playable UX.

## Evaluation Criteria
| Criteria | Weight | What we look for |
|----------|--------|-----------------|
| Correctness Under Concurrency | 30% | Pack drops don't oversell. Trades are atomic. Auctions handle simultaneous bids. Balances always consistent. |
| Real-Time Experience | 20% | WebSocket updates feel instant. Auction room is live. Portfolio values update. Reconnection handled. |
| System Design & Architecture | 20% | Clean separation. Schema makes sense. API is RESTful. Architecture doc shows tradeoff understanding. Parameter choices are justified. |
| Platform Economics | 15% | Pack EV math is sound. Fee structure reasonable. Dashboard exists. Candidate can explain the business model. |
| Code Quality & Polish | 15% | TypeScript used properly. Error handling exists. UI is usable. README is helpful. |

## Notes
- Money math uses `decimal.js` to reduce precision errors.
- If local test runs create duplicate test drops, run cleanup command above.
- Part A is intentionally biased toward proving correctness and market loop viability before horizontal scale work.
