BEGIN;

CREATE TABLE IF NOT EXISTS pack_fairness_commitments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  server_seed text NOT NULL,
  server_seed_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('RESERVED','CONSUMED','REVEALED','EXPIRED')),
  reserved_by uuid REFERENCES users(id),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  revealed_at timestamptz,
  purchase_id uuid UNIQUE REFERENCES pack_purchases(id),
  client_seed text,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes')
);

CREATE INDEX IF NOT EXISTS ix_pack_fairness_commitments_reserved_by_status_expires
  ON pack_fairness_commitments (reserved_by, status, expires_at);

CREATE INDEX IF NOT EXISTS ix_pack_fairness_commitments_status_expires
  ON pack_fairness_commitments (status, expires_at);

CREATE TABLE IF NOT EXISTS pack_card_pool_snapshots (
  hash text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pack_opening_fairness (
  purchase_id uuid PRIMARY KEY REFERENCES pack_purchases(id),
  commitment_id uuid NOT NULL UNIQUE REFERENCES pack_fairness_commitments(id),
  scheme_version text NOT NULL DEFAULT 'pf-pack-v1',
  server_seed_hash text NOT NULL,
  client_seed text NOT NULL,
  nonce int NOT NULL DEFAULT 0,
  drop_id uuid NOT NULL REFERENCES drops(id),
  config_version_id uuid REFERENCES pack_config_versions(id),
  rarity_weight_micros jsonb NOT NULL,
  card_pool_hash text NOT NULL,
  cards_per_pack int NOT NULL,
  selected_cards_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_pack_opening_fairness_created_at
  ON pack_opening_fairness (created_at);

CREATE INDEX IF NOT EXISTS ix_pack_opening_fairness_drop_created
  ON pack_opening_fairness (drop_id, created_at);

CREATE INDEX IF NOT EXISTS ix_pack_opening_fairness_config_created
  ON pack_opening_fairness (config_version_id, created_at);

CREATE TABLE IF NOT EXISTS pack_opening_audit_events (
  id bigserial PRIMARY KEY,
  purchase_id uuid NOT NULL REFERENCES pack_purchases(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  event_hash text NOT NULL UNIQUE,
  previous_event_hash text,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_pack_opening_audit_events_created_id
  ON pack_opening_audit_events (created_at, id);

CREATE INDEX IF NOT EXISTS ix_pack_opening_audit_events_purchase_id
  ON pack_opening_audit_events (purchase_id);

COMMIT;
