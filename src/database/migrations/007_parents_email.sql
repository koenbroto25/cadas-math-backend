-- ============================================================
-- 007 — parents.email (alur register parent via email/HP, V3 §5.1)
-- ============================================================

ALTER TABLE parents ADD COLUMN IF NOT EXISTS email TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_parents_email
    ON parents(email) WHERE email IS NOT NULL;
