-- Migration 018: demo_passcodes
-- Passcode 4-digit untuk Demo Mode (Sprint K.7).
-- Dibuat oleh admin (x-admin-secret) atau referrer tipe marketing (Bearer token).
-- Diredeem publik via POST /api/auth/demo/redeem → JWT demo ber-timeout.
--
-- Idempotent: aman dijalankan berulang (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS demo_passcodes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         char(4) NOT NULL UNIQUE,
  label        text,
  created_by   text NOT NULL DEFAULT 'admin',
  expires_at   timestamptz NOT NULL,
  redeemed_at  timestamptz,
  redeemed_ip  text,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_demo_passcodes_code ON demo_passcodes(code);
CREATE INDEX IF NOT EXISTS idx_demo_passcodes_active ON demo_passcodes(is_active);
