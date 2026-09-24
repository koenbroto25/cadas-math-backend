-- 033: Parent-first marketing attribution.
BEGIN;
ALTER TABLE parents ADD COLUMN IF NOT EXISTS referred_by UUID REFERENCES referrers(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_parents_referred_by ON parents(referred_by);
INSERT INTO _migrations(name) VALUES ('033_parent_marketing_attribution') ON CONFLICT DO NOTHING;
COMMIT;
