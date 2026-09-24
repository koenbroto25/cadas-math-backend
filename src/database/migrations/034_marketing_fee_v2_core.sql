-- 034: Marketing fee v2 core.
-- Guru: 1–19=5, 20–29=10, 30–39=15, 40+=20.
-- Referrer: 90-day window, 10–19=5, 20+=10.
-- Head marketing: core 10% flat. Semester/yearly bonuses are NOT implemented here.
BEGIN;

INSERT INTO referral_settings(key, value, description) VALUES
 ('marketing_fee_v2_enabled','true','Aktifkan core fee marketing v2'),
 ('teacher_tier_1_rate','5','Core fee guru mulai 1 direct paying student (%)'),
 ('teacher_tier_20_rate','10','Core fee guru mulai 20 direct paying students (%)'),
 ('teacher_tier_30_rate','15','Core fee guru mulai 30 direct paying students (%)'),
 ('teacher_tier_40_rate','20','Core fee guru mulai 40 direct paying students (%)'),
 ('referrer_tier_10_rate','5','Core fee referrer mulai 10 distinct students dalam window (%)'),
 ('referrer_tier_20_rate','10','Core fee referrer mulai 20 distinct students dalam window (%)'),
 ('referrer_window_days','90','Masa window referrer dari payment direct pertama'),
 ('head_marketing_rate','10','Core fee head marketing tahap awal; bonus semester/tahunan terpisah')
ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, description=EXCLUDED.description;

CREATE TABLE IF NOT EXISTS referrer_windows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  started_from_payment_id UUID REFERENCES payment_records(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','expired','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrer_windows_open
  ON referrer_windows(referrer_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS idx_referrer_windows_referrer
  ON referrer_windows(referrer_id, started_at DESC);

ALTER TABLE referrer_earnings
  ADD COLUMN IF NOT EXISTS earning_type TEXT NOT NULL DEFAULT 'transaction',
  ADD COLUMN IF NOT EXISTS source_quota INTEGER,
  ADD COLUMN IF NOT EXISTS window_id UUID REFERENCES referrer_windows(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eligible_at TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE referrer_earnings
SET idempotency_key = 'legacy:' || referrer_id::text || ':' || COALESCE(payment_record_id::text, id::text)
WHERE idempotency_key IS NULL;

DROP INDEX IF EXISTS uq_referrer_earnings_payment_referrer;
CREATE UNIQUE INDEX IF NOT EXISTS uq_referrer_earnings_idempotency
  ON referrer_earnings(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_referrer_earnings_partner_type
  ON referrer_earnings(referrer_id, earning_type, status);

INSERT INTO _migrations(name) VALUES ('034_marketing_fee_v2_core') ON CONFLICT DO NOTHING;
COMMIT;
