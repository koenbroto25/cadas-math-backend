-- ============================================================
-- 006 — Auth Schema Updates
-- ============================================================

-- Parent butuh password untuk akses dashboard
ALTER TABLE parents ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Teacher butuh password untuk akses dashboard
ALTER TABLE teachers ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- Siswa sudah punya id, tapi untuk "Profile Switcher" (V3 §5.3),
-- kita tambahkan device_profile_id atau sekadar pakai UUID
ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_hash TEXT;
