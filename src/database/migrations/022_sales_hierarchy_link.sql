-- Migration 022: Hierarki sales di bawah head marketing + dukungan demo tanpa simpan (A2 + A3 + A9)
-- - Tipe 'sales' sudah ditambahkan migrasi 021 (disini defensif utk DB lama)
-- - Kolom referrers.parent_referrer_id = id head marketing (pemilik kode)
-- - Key demo_no_persist_enabled untuk A3 (demo tanpa simpan progress)
BEGIN;

-- 1) Tipe 'sales' (defensif — 021 sudah menambahkan)
ALTER TABLE referrers DROP CONSTRAINT IF EXISTS referrers_type_check;
ALTER TABLE referrers ADD CONSTRAINT referrers_type_check
  CHECK (type IN ('school','marketing','parent','student','sales'));

-- 2) Hierarki: sales/guru hidup di bawah head marketing
ALTER TABLE referrers
  ADD COLUMN IF NOT EXISTS parent_referrer_id UUID REFERENCES referrers(id);

CREATE INDEX IF NOT EXISTS idx_referrers_parent ON referrers(parent_referrer_id);

-- 3) A3: flag global + kolom per-passcode "demo tanpa simpan progress"
ALTER TABLE demo_passcodes
  ADD COLUMN IF NOT EXISTS no_persist BOOLEAN NOT NULL DEFAULT false;

-- 4) A4: status 'ready' = fee otomatis siap cair saat kuota tier terpenuhi
ALTER TABLE referrer_earnings DROP CONSTRAINT IF EXISTS referrer_earnings_status_check;
ALTER TABLE referrer_earnings ADD CONSTRAINT referrer_earnings_status_check
  CHECK (status IN ('pending','ready','transferred','cancelled'));

INSERT INTO referral_settings (key, value, description) VALUES
  ('demo_no_persist_enabled', 'true', 'Demo passcode mendukung no_persist=true: sesi latihan TIDAK disimpan (A3)')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, description = EXCLUDED.description;

INSERT INTO _migrations(name) VALUES ('022_sales_hierarchy_link')
  ON CONFLICT DO NOTHING;

COMMIT;