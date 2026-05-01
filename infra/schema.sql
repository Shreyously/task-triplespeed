create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists balances (
  user_id uuid primary key references users(id),
  available_balance numeric(18,2) not null default 0,
  held_balance numeric(18,2) not null default 0,
  total_balance numeric(18,2) not null default 0,
  updated_at timestamptz not null default now(),
  check (available_balance >= 0),
  check (held_balance >= 0),
  check (total_balance >= 0),
  check (available_balance + held_balance = total_balance)
);

create table if not exists drops (
  id uuid primary key default gen_random_uuid(),
  tier text not null,
  price numeric(18,2) not null,
  cards_per_pack int not null,
  inventory int not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  rarity_weights jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists pack_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  drop_id uuid not null references drops(id),
  price_paid numeric(18,2) not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists cards (
  id uuid primary key default gen_random_uuid(),
  purchase_id uuid references pack_purchases(id),
  owner_id uuid not null references users(id),
  name text not null,
  set_name text not null,
  rarity text not null,
  image_url text not null,
  market_value numeric(18,2) not null,
  acquisition_value numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create type market_state as enum ('NONE','LISTED','IN_AUCTION');

create table if not exists card_market_state (
  card_id uuid primary key references cards(id),
  state market_state not null default 'NONE',
  listing_id uuid,
  auction_id uuid,
  updated_at timestamptz not null default now()
);

create table if not exists listings (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id),
  seller_id uuid not null references users(id),
  price numeric(18,2) not null,
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now()
);

create type auction_status as enum ('SCHEDULED','LIVE','CLOSING','CLOSED','SETTLED');

create table if not exists auctions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references cards(id),
  seller_id uuid not null references users(id),
  status auction_status not null,
  start_time timestamptz not null,
  end_time timestamptz not null,
  current_bid numeric(18,2) not null default 0,
  highest_bidder_id uuid,
  anti_snipe_extensions int not null default 0,
  settled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists bids (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null references auctions(id),
  bidder_id uuid not null references users(id),
  amount numeric(18,2) not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists trade_transactions (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references listings(id),
  buyer_id uuid not null references users(id),
  seller_id uuid not null references users(id),
  gross_amount numeric(18,2) not null,
  fee_amount numeric(18,2) not null,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists auction_settlements (
  id uuid primary key default gen_random_uuid(),
  auction_id uuid not null unique references auctions(id),
  winner_id uuid,
  gross_amount numeric(18,2),
  fee_amount numeric(18,2),
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  type text not null,
  amount numeric(18,2) not null,
  reference_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists portfolio_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  total_value numeric(18,2) not null,
  taken_at timestamptz not null default now()
);
