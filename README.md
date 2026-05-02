# PullVault (P0)

Monorepo with:
- `apps/web`: Next.js 14 frontend
- `apps/server`: Express API + Socket.io + settlement worker
- `packages/common`: shared contracts

## P0 Implemented
- Auth + JWT + starting paper balance ($1000)
- Pack drops + atomic purchase flow with DB transaction and live-window enforcement
- Server-side pack generation (locked at buy time) and one-by-one reveal summary
- Marketplace list/buy transaction safety
- Auction creation + bid race handling + anti-snipe
- Settlement worker (close + settle + fee split)
- Idempotency keys (Redis cache + DB unique constraints)
- Balance invariant enforced in DB: `available + held = total`
- Collection and portfolio endpoints with websocket portfolio updates
- Pokemon TCG metadata ingestion plus simulated rarity-based live price drift

## Stack
- Next.js + TypeScript + Tailwind
- Express + Socket.io
- PostgreSQL (Neon compatible)
- Redis (Upstash compatible)

## Setup
1. Install dependencies
```bash
npm install
```

2. Configure env
- Copy `apps/server/.env.example` to `apps/server/.env`
- Copy `apps/web/.env.local.example` to `apps/web/.env.local`

3. Bootstrap DB schema + seed
```bash
npm run db:bootstrap -w @pullvault/server
```

Optional: run SQL migrations (safe to re-run)
```bash
npm run db:migrate -w @pullvault/server
```

Optional: load drop seed data
```bash
npm run db:seed -w @pullvault/server
```

If test runs leave duplicate/test drops, clean them up:
```bash
npm run db:cleanup:test -w @pullvault/server
```

4. Start web + server
```bash
npm run dev
```

- Web: `http://localhost:3000`
- API/Socket: `http://localhost:4000`

## Concurrency Tests (Jest)
1. Copy `apps/server/.env.test.example` to `apps/server/.env.test` and point it to isolated Postgres/Redis instances.
2. Run tests:
```bash
npm run test -w @pullvault/server
```
3. Run only race-condition suite:
```bash
npm run test:concurrency -w @pullvault/server
```

## API Surface
- `POST /auth/signup`
- `POST /auth/login`
- `GET /auth/me`
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
- `POST /workers/settlement/tick`

## Notes
- Money is handled with `decimal.js` in services.
- Settlement worker runs every 5 seconds.
- Simulated price worker runs on `PRICE_TICK_SECONDS` cadence.
- Set `POKEMON_TCG_API_KEY` in `apps/server/.env` for card metadata pull.
- SQL migrations live in `infra/migrations` and are tracked in `applied_migrations`.
