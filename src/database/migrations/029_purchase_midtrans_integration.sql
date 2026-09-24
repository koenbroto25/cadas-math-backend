-- 029: Integrasi purchases + Midtrans QRIS + marketing attribution
-- Idempotent migration. Memperluas tabel existing tanpa menghapus data lama.
BEGIN;

-- Payment record boleh dibuat saat pembayaran parent-first terjadi sebelum anak ada.
ALTER TABLE midtrans_invoices ADD COLUMN IF NOT EXISTS qr_code_url TEXT;
ALTER TABLE midtrans_invoices ADD COLUMN IF NOT EXISTS purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL;
ALTER TABLE midtrans_invoices ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES parents(id) ON DELETE SET NULL;
ALTER TABLE midtrans_invoices ALTER COLUMN student_id DROP NOT NULL;
ALTER TABLE midtrans_invoices ALTER COLUMN level_from DROP NOT NULL;
ALTER TABLE midtrans_invoices ALTER COLUMN level_to DROP NOT NULL;

-- Normalisasi row lama sebelum constraint paket baru dipasang.
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_package_check;
UPDATE purchases SET package = 'basic_single' WHERE package = 'level_1';
UPDATE purchases SET package = 'basic_bundle_3' WHERE package = 'level_3';

-- Empat paket resmi: Basic 1/3 level dan Premium 1/3 level.
ALTER TABLE purchases ADD CONSTRAINT purchases_package_check
  CHECK (package IN ('basic_single', 'basic_bundle_3', 'premium_single', 'premium_bundle_3'));
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_amount_idr_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_amount_idr_check
  CHECK (amount_idr IN (40000, 100000, 65000, 165000));

-- Purchase menyimpan paket lengkap dan attribution marketing.
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS referrer_code TEXT;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS is_confirmed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS qr_code_url TEXT;

-- Payment record boleh dibuat tanpa student pada parent-first.
ALTER TABLE payment_records ALTER COLUMN student_id DROP NOT NULL;
ALTER TABLE payment_records ALTER COLUMN level_from DROP NOT NULL;
ALTER TABLE payment_records ALTER COLUMN level_to DROP NOT NULL;
ALTER TABLE payment_records ADD COLUMN IF NOT EXISTS purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL;
ALTER TABLE payment_records ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES parents(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_purchase
  ON payment_records (purchase_id) WHERE purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_midtrans_invoices_purchase ON midtrans_invoices(purchase_id);
CREATE INDEX IF NOT EXISTS idx_purchases_referrer_code ON purchases(referrer_code);

INSERT INTO _migrations(name) VALUES ('029_purchase_midtrans_integration') ON CONFLICT DO NOTHING;
COMMIT;
