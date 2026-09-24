-- ============================================================
-- 027_qris_midtrans.sql
-- Paywall QRIS-only via Midtrans (Fase 5)
--
-- Alur status pembelian dengan QRIS:
--   'unpaid'  : QRIS dibuat, menunggu pembayaran
--   'pending' : settlement Midtrans (sudah bayar) — kredit menggantung
--               menunggu jangkar placement (model §13.5 tidak berubah)
--   'active'  : diaktifkan ke scope level (activatePendingPurchases)
-- ============================================================

-- Lewati constraint CHECK status lama ('pending','active') bila ada
ALTER TABLE purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE purchases
  ADD CONSTRAINT purchases_status_check
  CHECK (status IN ('unpaid', 'pending', 'active'));

-- Kolom transaksi Midtrans
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS order_id TEXT UNIQUE;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMPTZ;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS midtrans_status TEXT;

-- QRIS jadi metode default (baris lama 'manual_transfer' tetap terbaca apa adanya)
ALTER TABLE purchases ALTER COLUMN payment_method SET DEFAULT 'qris_midtrans';
