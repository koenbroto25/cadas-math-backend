-- Migration 021: Penyelarasan fee ke matriks owner (marketing.md bagian 2)
-- - Nonaktifkan fee parent & student (tidak ada fee untuk tipe ini)
-- - Tambah key tier-kuota baru (head 10%, guru 20%/10% bertier, sales 10% min 10)
-- - CHECK type: tambah 'sales', pertahankan lama agar baris existing tidak pecah
BEGIN;

-- 1) Izinkan tipe 'sales' (sales = referrer di bawah marketing)
ALTER TABLE referrers DROP CONSTRAINT IF EXISTS referrers_type_check;
ALTER TABLE referrers ADD CONSTRAINT referrers_type_check
  CHECK (type IN ('school','marketing','parent','student','sales'));

-- 2) Matikan fee parent & student (keputusan owner P1)
INSERT INTO referral_settings (key, value, description) VALUES
  ('parent_enabled',  'false', 'Referral orang tua AKTIF sebagai referrer? (fee dinonaktifkan owner P1)'),
  ('student_enabled', 'false', 'Referral siswa AKTIF sebagai referrer? (fee dinonaktifkan owner P1)')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;

-- 3) Key tier-kuota baru (matriks owner marketing.md bagian 2)
INSERT INTO referral_settings (key, value, description) VALUES
  ('head_marketing_rate',  '10',  'Fee head marketing (%) — dari jaringan guru+sales'),
  ('teacher_rate_full',    '20',  'Fee guru tier penuh (%) — min 100 siswa bayar'),
  ('teacher_quota_full',   '100', 'Kuota murid bayar guru tier penuh'),
  ('teacher_rate_half',    '10',  'Fee guru tier setengah (%) — 50-99 siswa bayar'),
  ('teacher_quota_half',   '50',  'Kuota murid bayar guru tier setengah'),
  ('sales_rate',           '10',  'Fee sales/referrer bawah marketing (%)'),
  ('sales_quota',          '10',  'Kuota murid bayar sales agar fee cair'),
  ('parent_rate',          '0',   'Fee parent DINONAKTIFKAN (owner P1) — parent boleh jadi referrer, fee ikut sales'),
  ('student_rate',         '0',   'Fee student DINONAKTIFKAN (owner P1)')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;

INSERT INTO _migrations(name) VALUES ('021_fee_matrix_owner')
  ON CONFLICT DO NOTHING;

COMMIT;
