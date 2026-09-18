-- ============================================================
-- Migration: Sistem Auth Baru Cadas Matematika
-- File: 001_new_auth_system.sql
-- Jalankan di Neon production via psql atau Neon console
-- ============================================================

BEGIN;

-- ── 1. Tambah kolom baru ke tabel students ───────────────────
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS display_id     VARCHAR(5)   UNIQUE,
  ADD COLUMN IF NOT EXISTS parent_phone   VARCHAR(20),
  ADD COLUMN IF NOT EXISTS card_shared    BOOLEAN      NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS card_shared_at TIMESTAMPTZ;

-- ── 2. Index untuk lookup cepat ──────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_display_id
  ON students(display_id);

CREATE INDEX IF NOT EXISTS idx_students_parent_phone
  ON students(parent_phone);

-- ── 3. Function generate display_id (32 char safe set) ───────
CREATE OR REPLACE FUNCTION generate_display_id()
RETURNS VARCHAR(5) AS $$
DECLARE
  chars  TEXT    := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result VARCHAR(5) := '';
  i      INT;
  attempt INT    := 0;
BEGIN
  LOOP
    result := '';
    FOR i IN 1..4 LOOP
      result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
    -- Cek uniqueness
    IF NOT EXISTS (SELECT 1 FROM students WHERE display_id = result) THEN
      RETURN result;
    END IF;
    attempt := attempt + 1;
    IF attempt > 100 THEN
      RAISE EXCEPTION 'Tidak bisa generate display_id unik setelah 100 percobaan';
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── 4. Generate display_id untuk siswa lama yang belum punya ─
UPDATE students
SET display_id = generate_display_id()
WHERE display_id IS NULL;

-- ── 5. Set NOT NULL setelah semua baris terisi ───────────────
ALTER TABLE students
  ALTER COLUMN display_id SET NOT NULL;

-- ── 6. Tambah kolom phone ke tabel parents ───────────────────
ALTER TABLE parents
  ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

CREATE INDEX IF NOT EXISTS idx_parents_phone ON parents(phone);

-- ── 7. Tabel parent_children (many-to-many) ──────────────────
CREATE TABLE IF NOT EXISTS parent_children (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID        NOT NULL REFERENCES parents(id)   ON DELETE CASCADE,
  student_id UUID        NOT NULL REFERENCES students(id)  ON DELETE CASCADE,
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parent_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_parent_children_parent  ON parent_children(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_children_student ON parent_children(student_id);

-- ── 8. Migrasi link lama (parent_id di students → parent_children) ─
-- Hanya jika kolom parent_id sudah ada di tabel students
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'students' AND column_name = 'parent_id'
  ) THEN
    INSERT INTO parent_children (parent_id, student_id)
    SELECT parent_id, id
    FROM students
    WHERE parent_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;

COMMIT;

-- ── Verifikasi ────────────────────────────────────────────────
SELECT
  COUNT(*)                                        AS total_students,
  COUNT(display_id)                               AS has_display_id,
  COUNT(*) FILTER (WHERE display_id IS NULL)      AS missing_display_id,
  COUNT(*) FILTER (WHERE length(display_id) != 4) AS wrong_length
FROM students;
