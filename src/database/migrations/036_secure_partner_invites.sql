-- 036: Secure partner invites — hash-only, one-time, revocable, audited.
BEGIN;

CREATE TABLE IF NOT EXISTS partner_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK (target_type IN ('school', 'sales')),
  inviter_referrer_id UUID REFERENCES referrers(id) ON DELETE SET NULL,
  created_by_admin BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  used_referrer_id UUID REFERENCES referrers(id) ON DELETE SET NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_partner_invites_active
  ON partner_invites(target_type, expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_partner_invites_inviter
  ON partner_invites(inviter_referrer_id, created_at DESC);

INSERT INTO _migrations(name) VALUES ('036_secure_partner_invites') ON CONFLICT DO NOTHING;
COMMIT;
