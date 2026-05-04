do $$
begin
  alter type auction_status add value if not exists 'SEALED_ENDGAME';
exception
  when duplicate_object then null;
end $$;

alter table auctions
  add column if not exists sealed_phase_started_at timestamptz,
  add column if not exists sealed_phase_ends_at timestamptz,
  add column if not exists sealed_bid_floor numeric(18,2),
  add column if not exists final_clearing_price numeric(18,2),
  add column if not exists winning_max_bid numeric(18,2);

create table if not exists sealed_bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references auctions(id),
  bidder_id uuid not null references users(id),
  max_bid_amount numeric(18,2) not null,
  confirmed_high_bid boolean not null default false,
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (auction_id, bidder_id),
  unique (bidder_id, idempotency_key)
);

alter table auction_settlements
  add column if not exists winning_max_bid numeric(18,2),
  add column if not exists final_clearing_price numeric(18,2);

create table if not exists auction_integrity_flags (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references auctions(id),
  flag_type text not null,
  severity int not null default 1,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'OPEN',
  created_at timestamptz not null default now()
);
