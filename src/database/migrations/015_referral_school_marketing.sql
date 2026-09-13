-- Migration 015: Referral System Sekolah + Marketing
BEGIN;

ALTER TABLE referrers
  ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'marketing'
    CHECK (type IN ('school','marketing','parent','student')),
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE IF NOT EXISTS referral_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO referral_settings (key, value, description) VALUES
  ('school_rate',       '30',    'Default komisi sekolah (%)'),
  ('marketing_rate',    '10',    'Default komisi marketing (%)'),
  ('parent_rate',       '5',     'Default komisi orang tua (%)'),
  ('student_rate',      '5',     'Default komisi siswa (%)'),
  ('school_enabled',    'true',  'Referral sekolah aktif?'),
  ('marketing_enabled', 'true',  'Referral marketing aktif?'),
  ('parent_enabled',    'false', 'Referral orang tua aktif?'),
  ('student_enabled',   'false', 'Referral siswa aktif?'),
  ('split_fee_enabled', 'true',  'Split fee sekolah+marketing aktif?')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS school_marketing_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id     UUID NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  marketing_id  UUID NOT NULL REFERENCES referrers(id) ON DELETE CASCADE,
  is_active     BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(school_id, marketing_id)
);

CREATE INDEX IF NOT EXISTS idx_sml_school    ON school_marketing_links(school_id);
CREATE INDEX IF NOT EXISTS idx_sml_marketing ON school_marketing_links(marketing_id);

ALTER TABLE referrer_earnings
  ADD COLUMN IF NOT EXISTS split_group_id UUID,
  ADD COLUMN IF NOT EXISTS referrer_type  TEXT;

UPDATE referrers SET type = 'marketing' WHERE type = 'marketing';

CREATE INDEX IF NOT EXISTS idx_referrers_type      ON referrers(type);
CREATE INDEX IF NOT EXISTS idx_referrers_is_active ON referrers(is_active);

INSERT INTO _migrations(name) VALUES ('015_referral_school_marketing')
  ON CONFLICT DO NOTHING;

COMMIT;