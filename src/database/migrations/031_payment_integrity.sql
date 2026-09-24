-- 031: Integritas retry payment + komisi idempotent.
BEGIN;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS qr_string TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrer_earnings_payment_referrer
  ON referrer_earnings(payment_record_id, referrer_id)
  WHERE payment_record_id IS NOT NULL;
INSERT INTO _migrations(name) VALUES ('031_payment_integrity') ON CONFLICT DO NOTHING;
COMMIT;
