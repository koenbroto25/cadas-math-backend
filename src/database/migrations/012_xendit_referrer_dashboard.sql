-- ============================================================
-- 012 - Xendit Invoices + Referrer Auth + Dashboard (Sprint D)
-- ============================================================

-- 1. Xendit invoices (payment gateway)
CREATE TABLE IF NOT EXISTS xendit_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  xendit_invoice_id TEXT UNIQUE NOT NULL,
  xendit_invoice_url TEXT NOT NULL,
  product_type TEXT NOT NULL,
  level_from INT NOT NULL,
  level_to INT NOT NULL,
  amount_idr INT NOT NULL,
  referrer_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','expired','failed')),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_xendit_invoices_student ON xendit_invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_xendit_invoices_status ON xendit_invoices(status);
CREATE INDEX IF NOT EXISTS idx_xendit_invoices_xendit_id ON xendit_invoices(xendit_invoice_id);

-- 2. Referrer earnings log
CREATE TABLE IF NOT EXISTS referrer_earnings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  payment_record_id UUID REFERENCES payment_records(id),
  xendit_invoice_id UUID REFERENCES xendit_invoices(id),
  student_id UUID REFERENCES students(id),
  amount_idr INT NOT NULL,
  commission_rate NUMERIC(5,2) NOT NULL,
  commission_idr INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','transferred','cancelled')),
  transferred_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrer_earnings_referrer ON referrer_earnings(referrer_id);
CREATE INDEX IF NOT EXISTS idx_referrer_earnings_status ON referrer_earnings(status);

-- 3. Download clicks tracker (untuk /d/:token redirect)
CREATE TABLE IF NOT EXISTS download_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_token TEXT NOT NULL,
  referrer_id UUID REFERENCES referrers(id) ON DELETE SET NULL,
  ip_hash TEXT,
  user_agent TEXT,
  clicked_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_download_clicks_token ON download_clicks(referral_token);
CREATE INDEX IF NOT EXISTS idx_download_clicks_referrer ON download_clicks(referrer_id);

-- 4. Extend referrers table: auth + bank + stats
ALTER TABLE referrers
  ADD COLUMN IF NOT EXISTS full_name TEXT,
  ADD COLUMN IF NOT EXISTS email TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS referral_token TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS bank_name TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_number TEXT,
  ADD COLUMN IF NOT EXISTS bank_account_name TEXT,
  ADD COLUMN IF NOT EXISTS total_clicks INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_conversions INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_earnings_idr INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_transferred_idr INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Drop old status check constraint dan buat ulang dengan nilai baru
ALTER TABLE referrers DROP CONSTRAINT IF EXISTS referrers_status_check;
ALTER TABLE referrers ADD CONSTRAINT referrers_status_check
  CHECK (status IN ('pending','approved','rejected','suspended'));

-- 5. technique_taught_and_passed (Fase belum dimulai, siapkan tabel)
CREATE TABLE IF NOT EXISTS technique_taught_and_passed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level INT NOT NULL,
  technique_key TEXT NOT NULL,
  taught_at TIMESTAMPTZ DEFAULT NOW(),
  passed_at TIMESTAMPTZ,
  pass_score NUMERIC(5,2),
  UNIQUE (student_id, level, technique_key)
);

CREATE INDEX IF NOT EXISTS idx_technique_student ON technique_taught_and_passed(student_id);
CREATE INDEX IF NOT EXISTS idx_technique_level ON technique_taught_and_passed(student_id, level);
