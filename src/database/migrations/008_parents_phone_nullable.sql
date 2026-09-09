-- ============================================================
-- 008 — parents.phone nullable (fix: parent bisa daftar via email saja)
-- ============================================================
-- Alur [ADD] §6.2: parent register dengan email ATAU phone (salah satu).
-- Sebelumnya phone NOT NULL → error 500 saat daftar email-only.

ALTER TABLE parents ALTER COLUMN phone DROP NOT NULL;

-- Pastikan tetap unik bila terisi (hindari duplikat string kosong/null)
-- Hapus constraint unik lama (bukan index biasa)
ALTER TABLE parents DROP CONSTRAINT IF EXISTS parents_phone_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_parents_phone
    ON parents(phone) WHERE phone IS NOT NULL;
