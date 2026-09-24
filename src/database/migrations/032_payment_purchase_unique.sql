-- 032: payment_record purchase key harus inferable oleh ON CONFLICT.
BEGIN;
DROP INDEX IF EXISTS uq_payment_records_purchase;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_records_purchase
  ON payment_records(purchase_id);
INSERT INTO _migrations(name) VALUES ('032_payment_purchase_unique') ON CONFLICT DO NOTHING;
COMMIT;
