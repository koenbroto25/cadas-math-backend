-- ============================================================
-- 019 — Auth Baru: kolom display (Opsi A1) + rapikan auth system
-- Keputusan D1: TAMBAH kolom baru, biarkan kolom lama apa adanya.
-- Idempotent: aman dijalankan ulang (IF NOT EXISTS / DO block).
-- Menggantikan file lama 001_new_auth_system.sql (jangan dipakai lagi —
-- file lama sort paling awal + berisi BEGIN/COMMIT/SELECT yg tak cocok
-- dengan migrate.js + duplikat nomor 001).
-- ============================================================

-- ── 1. Kolom baru students (display utk flow baru) ─────────────
ALTER TABLE students ADD COLUMN IF NOT EXISTS name       TEXT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS kelas      INT;
ALTER TABLE students ADD COLUMN IF NOT EXISTS display_id VARCHAR(5);
ALTER TABLE students ADD COLUMN IF NOT EXISTS parent_phone VARCHAR(20);
ALTER TABLE students ADD COLUMN IF NOT EXISTS card_shared BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE students ADD COLUMN IF NOT EXISTS card_shared_at TIMESTAMPTZ;

-- Username lama NOT NULL tanpa default menyulitkan insert baru;
-- beri default agar register baru (display_id based) tidak wajib isi.
DO $$
BEGIN
  BEGIN
    ALTER TABLE students ALTER COLUMN username SET DEFAULT 'siswa_' || substr(md5(random()::text), 1, 8);
  EXCEPTION WHEN others THEN NULL;
  END;
END;
$$;

-- Backfill satu arah lama -> baru (hanya yg masih NULL, tidak timpa data):
-- display_name -> name, grade_level -> kelas.
UPDATE students SET name  = display_name WHERE name IS NULL AND display_name IS NOT NULL;
UPDATE students SET kelas = grade_level  WHERE kelas IS NULL AND grade_level IS NOT NULL;

-- ── 2. Index display_id ───────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_display_id ON students(display_id);
CREATE INDEX IF NOT EXISTS idx_students_parent_phone ON students(parent_phone);

-- Backfill display_id untuk baris lama yg belum punya (JS-side loop aman:
-- gunakan function sementara lalu hapus agar tak ada duplikasi logika).
CREATE OR REPLACE FUNCTION tmp_generate_display_id()
RETURNS VARCHAR(5) AS $$
DECLARE
  chars  TEXT := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result VARCHAR(5) := '';
  i      INT;
  attempt INT := 0;
BEGIN
  LOOP
    result := '';
    FOR i IN 1..4 LOOP
      result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    END LOOP;
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

UPDATE students SET display_id = tmp_generate_display_id() WHERE display_id IS NULL;
DROP FUNCTION IF EXISTS tmp_generate_display_id();

-- ── 3. Kolom parents.name (display utk flow baru) ─────────────
ALTER TABLE parents ADD COLUMN IF NOT EXISTS name VARCHAR(120);
UPDATE parents SET name = display_name WHERE name IS NULL AND display_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_parents_phone ON parents(phone);

-- ── 4. Tabel parent_children (many-to-many) ───────────────────
CREATE TABLE IF NOT EXISTS parent_children (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_id  UUID        NOT NULL REFERENCES parents(id)   ON DELETE CASCADE,
  student_id UUID        NOT NULL REFERENCES students(id)  ON DELETE CASCADE,
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(parent_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_parent_children_parent  ON parent_children(parent_id);
CREATE INDEX IF NOT EXISTS idx_parent_children_student ON parent_children(student_id);

-- Migrasi link lama (students.parent_id -> parent_children) bila kolom ada.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'students' AND column_name = 'parent_id'
  ) THEN
    INSERT INTO parent_children (parent_id, student_id)
    SELECT parent_id, id FROM students WHERE parent_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END;
$$;
