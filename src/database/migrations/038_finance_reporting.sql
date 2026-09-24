-- 038: Finance domain — cash ledger, payout batches, reconciliation, audit.
BEGIN;

-- Amount signed: settlement/adjustment positive, refund/payout negative.
CREATE TABLE IF NOT EXISTS finance_cash_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('opening_balance','settlement','refund','payout','adjustment')),
  source_type TEXT NOT NULL,
  source_id UUID,
  external_id TEXT,
  amount_idr BIGINT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'IDR',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  bank_reference TEXT,
  description TEXT,
  actor_id UUID,
  actor_role TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_cash_source
  ON finance_cash_ledger(source_type, source_id, entry_type)
  WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finance_cash_occurred
  ON finance_cash_ledger(occurred_at DESC);

CREATE TABLE IF NOT EXISTS payout_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','scheduled','transferred','failed','cancelled')),
  total_idr BIGINT NOT NULL DEFAULT 0,
  partner_count INT NOT NULL DEFAULT 0,
  bank_reference TEXT,
  notes TEXT,
  created_by UUID,
  approved_by UUID,
  transferred_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  transferred_at TIMESTAMPTZ,
  failure_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON payout_batches(status, created_at DESC);

CREATE TABLE IF NOT EXISTS payout_batch_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_batch_id UUID NOT NULL REFERENCES payout_batches(id) ON DELETE CASCADE,
  earning_id UUID NOT NULL REFERENCES referrer_earnings(id) ON DELETE RESTRICT,
  referrer_id UUID NOT NULL REFERENCES referrers(id) ON DELETE RESTRICT,
  amount_idr BIGINT NOT NULL CHECK (amount_idr > 0),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','transferred','cancelled','failed')),
  transferred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payout_item_active_earning
  ON payout_batch_items(earning_id)
  WHERE status IN ('scheduled','transferred');
CREATE INDEX IF NOT EXISTS idx_payout_items_batch ON payout_batch_items(payout_batch_id);

CREATE TABLE IF NOT EXISTS finance_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_name TEXT NOT NULL,
  account_date DATE NOT NULL,
  app_balance_idr BIGINT NOT NULL,
  actual_balance_idr BIGINT NOT NULL,
  difference_idr BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'matched' CHECK (status IN ('matched','needs_reconciliation')),
  notes TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(account_name, account_date)
);

CREATE TABLE IF NOT EXISTS finance_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id UUID,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID,
  old_value JSONB,
  new_value JSONB,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_finance_audit_created ON finance_audit_logs(created_at DESC);

-- Preserve existing marketing ledger; expand lifecycle for finance scheduling.
ALTER TABLE referrer_earnings ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE referrer_earnings ADD COLUMN IF NOT EXISTS cancelled_by UUID;
ALTER TABLE referrer_earnings DROP CONSTRAINT IF EXISTS referrer_earnings_status_check;
ALTER TABLE referrer_earnings ADD CONSTRAINT referrer_earnings_status_check
  CHECK (status IN ('pending','ready','scheduled','transferred','cancelled'));

INSERT INTO _migrations(name) VALUES ('038_finance_reporting') ON CONFLICT DO NOTHING;
COMMIT;
