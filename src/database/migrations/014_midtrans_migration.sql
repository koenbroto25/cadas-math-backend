-- Migration 014: Xendit -> Midtrans
BEGIN;

ALTER TABLE xendit_invoices RENAME TO midtrans_invoices;
ALTER TABLE midtrans_invoices RENAME COLUMN xendit_invoice_id TO midtrans_order_id;
ALTER TABLE midtrans_invoices RENAME COLUMN xendit_invoice_url TO midtrans_payment_url;

ALTER TABLE midtrans_invoices
  ADD COLUMN IF NOT EXISTS midtrans_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_type TEXT,
  ADD COLUMN IF NOT EXISTS va_number TEXT,
  ADD COLUMN IF NOT EXISTS snap_token TEXT;

DROP INDEX IF EXISTS idx_xendit_invoices_student;
DROP INDEX IF EXISTS idx_xendit_invoices_status;
DROP INDEX IF EXISTS idx_xendit_invoices_xendit_id;

CREATE INDEX IF NOT EXISTS idx_midtrans_invoices_student  ON midtrans_invoices(student_id);
CREATE INDEX IF NOT EXISTS idx_midtrans_invoices_status   ON midtrans_invoices(status);
CREATE INDEX IF NOT EXISTS idx_midtrans_invoices_order_id ON midtrans_invoices(midtrans_order_id);

ALTER TABLE referrer_earnings
  RENAME COLUMN xendit_invoice_id TO midtrans_invoice_id;

INSERT INTO _migrations(name) VALUES ('014_midtrans_migration') ON CONFLICT DO NOTHING;

COMMIT;