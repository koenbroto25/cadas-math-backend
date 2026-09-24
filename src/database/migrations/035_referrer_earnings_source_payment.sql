-- 035: Backfill-safe support for quota catch-up source payment.
BEGIN;
ALTER TABLE referrer_earnings
  ADD COLUMN IF NOT EXISTS source_payment_id UUID REFERENCES payment_records(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_referrer_earnings_source_payment
  ON referrer_earnings(source_payment_id);
INSERT INTO _migrations(name) VALUES ('035_referrer_earnings_source_payment') ON CONFLICT DO NOTHING;
COMMIT;
