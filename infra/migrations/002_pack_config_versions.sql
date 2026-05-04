-- Migration 002: Pack Config Versions
-- Creates tier-scoped, versioned rarity weight configs for B1 economics.

BEGIN;

DO $$ BEGIN
  CREATE TYPE config_trigger_reason AS ENUM (
    'bootstrap_seed',
    'scheduled',
    'margin_drift',
    'manual',
    'price_anomaly'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pack_config_versions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier                TEXT NOT NULL,
  version             INT NOT NULL,
  rarity_weights      JSONB NOT NULL,
  target_margin       NUMERIC(5,4) NOT NULL,
  actual_ev           NUMERIC(18,2) NOT NULL,
  simulated_margin    NUMERIC(5,4) NOT NULL,
  simulated_win_rate  NUMERIC(5,4) NOT NULL,
  market_snapshot     JSONB NOT NULL,
  trigger_reason      config_trigger_reason NOT NULL,
  is_active           BOOLEAN NOT NULL DEFAULT false,
  activated_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tier, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_pack_config_one_active_per_tier
  ON pack_config_versions (tier)
  WHERE is_active = true;

ALTER TABLE pack_purchases
  ADD COLUMN IF NOT EXISTS config_version_id UUID REFERENCES pack_config_versions(id);

COMMIT;
