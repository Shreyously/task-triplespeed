BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_events (
  id bigserial PRIMARY KEY,
  user_id uuid,
  ip_hash text,
  route_type text NOT NULL,
  access_policy text NOT NULL,
  allowed boolean NOT NULL,
  degraded boolean NOT NULL default false,
  failure_mode text NOT NULL,
  blocked_by text,
  retry_after_seconds int,
  request_limit int NOT NULL,
  remaining int NOT NULL,
  created_at timestamptz NOT NULL default now()
);

CREATE INDEX IF NOT EXISTS ix_rate_limit_events_created_at
  ON rate_limit_events (created_at);

CREATE INDEX IF NOT EXISTS ix_rate_limit_events_route_created
  ON rate_limit_events (route_type, created_at);

CREATE INDEX IF NOT EXISTS ix_rate_limit_events_allowed_created
  ON rate_limit_events (allowed, created_at);

CREATE INDEX IF NOT EXISTS ix_rate_limit_events_blocked_by_created
  ON rate_limit_events (blocked_by, created_at);

CREATE TABLE IF NOT EXISTS bot_activity_events (
  id bigserial PRIMARY KEY,
  user_id uuid,
  ip_hash text,
  user_agent_hash text,
  score numeric(5,4) NOT NULL,
  action text NOT NULL,
  reasons jsonb NOT NULL default '[]'::jsonb,
  created_at timestamptz NOT NULL default now()
);

CREATE INDEX IF NOT EXISTS ix_bot_activity_events_created_at
  ON bot_activity_events (created_at);

CREATE INDEX IF NOT EXISTS ix_bot_activity_events_user_created
  ON bot_activity_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_bot_activity_events_action_created
  ON bot_activity_events (action, created_at);

CREATE INDEX IF NOT EXISTS ix_bot_activity_events_score_created
  ON bot_activity_events (score, created_at);

CREATE TABLE IF NOT EXISTS fairness_verification_events (
  id bigserial PRIMARY KEY,
  purchase_id uuid NOT NULL REFERENCES pack_purchases(id),
  user_id uuid,
  client_fingerprint_hash text,
  ok boolean NOT NULL,
  checks jsonb NOT NULL default '{}'::jsonb,
  created_at timestamptz NOT NULL default now()
);

CREATE INDEX IF NOT EXISTS ix_fairness_verification_events_created_at
  ON fairness_verification_events (created_at);

CREATE INDEX IF NOT EXISTS ix_fairness_verification_events_purchase_created
  ON fairness_verification_events (purchase_id, created_at);

CREATE INDEX IF NOT EXISTS ix_fairness_verification_events_user_created
  ON fairness_verification_events (user_id, created_at);

CREATE INDEX IF NOT EXISTS ix_fairness_verification_events_fingerprint_created
  ON fairness_verification_events (client_fingerprint_hash, created_at);

COMMIT;
