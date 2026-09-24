-- Migration 023: Rate-limit login PIN admin (A7 — marketing.md bagian 5)
-- PIN 4 digit mudah di-brute-force: maks 10 percobaan / 15 menit / IP.
-- catatan: limiternya in-memory di proses backend (auth.js); tabel ini
-- menyediakan jejak audit + sumber lockout yang bertahan lintas restart.
BEGIN;

CREATE TABLE IF NOT EXISTS admin_pin_attempts (
  id           BIGSERIAL PRIMARY KEY,
  ip           TEXT NOT NULL,
  success      BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_pin_attempts_ip_time
  ON admin_pin_attempts(ip, created_at);

INSERT INTO _migrations(name) VALUES ('023_admin_pin_rate_limit')
  ON CONFLICT DO NOTHING;

COMMIT;