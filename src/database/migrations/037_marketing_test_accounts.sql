-- 037: Secure one-time Head Marketing test accounts (M7).
-- Test accounts are preview credentials, never student/production accounts.
BEGIN;

CREATE TABLE IF NOT EXISTS marketing_test_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash TEXT NOT NULL UNIQUE,
  code_hint CHAR(4) NOT NULL,
  label TEXT,
  owner_referrer_id UUID REFERENCES referrers(id) ON DELETE SET NULL,
  created_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_ip TEXT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_marketing_test_accounts_owner_active
  ON marketing_test_accounts(owner_referrer_id, expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_marketing_test_accounts_created
  ON marketing_test_accounts(created_at DESC);

INSERT INTO _migrations(name) VALUES ('037_marketing_test_accounts') ON CONFLICT DO NOTHING;
COMMIT;
