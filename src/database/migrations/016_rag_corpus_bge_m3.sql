-- Migration 016: RAG Corpus — BGE-M3 1024-dim
-- Tujuan:
--   1. Ganti dimensi vector dari 384 → 1024 (sesuai BGE-M3 Ollama output)
--   2. Tambah kolom exercise_id dan chunk_type agar bisa menyimpan
--      ~16.000 chunks dari exercises (hint_text, quick_trick, speech_text)
--      selain 15 explanation rows yang sudah ada
--   3. Buat index ivfflat untuk ANN search yang efisien di ~16K rows
--
-- Jalankan dari psql atau node migration runner.
-- Semua perubahan dalam satu transaksi — aman di-rollback jika gagal.

BEGIN;

-- ── Langkah 1: Hapus baris lama (dimensi 384, tidak compatible) ─────────────
-- Harus dihapus dulu karena ALTER TYPE vector dimension tidak bisa
-- dilakukan jika ada data existing dengan dimensi berbeda.
TRUNCATE TABLE explanations_embedding;

-- ── Langkah 2: Drop index lama jika ada ────────────────────────────────────
DROP INDEX IF EXISTS idx_explanations_embedding_vector;
DROP INDEX IF EXISTS idx_explanations_embedding_embedding;
DROP INDEX IF EXISTS explanations_embedding_embedding_idx;

-- ── Langkah 3: Ubah dimensi kolom embedding 384 → 1024 ─────────────────────
ALTER TABLE explanations_embedding
  ALTER COLUMN embedding TYPE vector(1024)
  USING NULL::vector(1024);

-- ── Langkah 4: Tambah kolom exercise_id (nullable, FK ke exercises) ─────────
-- Nullable karena baris dari tabel explanations tidak punya exercise_id.
ALTER TABLE explanations_embedding
  ADD COLUMN IF NOT EXISTS exercise_id UUID REFERENCES exercises(id) ON DELETE CASCADE;

-- ── Langkah 5: Tambah kolom chunk_type ─────────────────────────────────────
-- Nilai: 'hint_text' | 'quick_trick' | 'speech_text' | 'explanation'
ALTER TABLE explanations_embedding
  ADD COLUMN IF NOT EXISTS chunk_type TEXT NOT NULL DEFAULT 'explanation';

-- ── Langkah 6: Tambah kolom metadata tambahan ───────────────────────────────
-- source_table: untuk tracing origin chunk (exercises / explanations)
ALTER TABLE explanations_embedding
  ADD COLUMN IF NOT EXISTS source_table TEXT NOT NULL DEFAULT 'explanations';

-- ── Langkah 7: Index ANN — ivfflat ─────────────────────────────────────────
-- ivfflat cocok untuk ~16K rows. lists=128 adalah aturan praktis:
-- sqrt(16000) ≈ 126, bulatkan ke 128.
-- Dibangun SETELAH data diisi oleh build-rag-corpus.js (jalankan
-- manual: CREATE INDEX setelah build selesai, atau biarkan script handle).
-- Di sini kita create dengan IF NOT EXISTS agar idempotent.
CREATE INDEX IF NOT EXISTS idx_ee_embedding_ivfflat
  ON explanations_embedding
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 128);

-- ── Langkah 8: Index bantu untuk filter cepat ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_ee_level_id       ON explanations_embedding (level_id);
CREATE INDEX IF NOT EXISTS idx_ee_concept_id     ON explanations_embedding (concept_id);
CREATE INDEX IF NOT EXISTS idx_ee_exercise_id    ON explanations_embedding (exercise_id);
CREATE INDEX IF NOT EXISTS idx_ee_chunk_type     ON explanations_embedding (chunk_type);
CREATE INDEX IF NOT EXISTS idx_ee_embedding_ready ON explanations_embedding (embedding_ready);

-- ── Langkah 9: Constraint unik per source chunk ─────────────────────────────
-- Mencegah duplicate jika build-rag-corpus.js dijalankan dua kali.
-- exercise_id + chunk_type = unik untuk exercise chunks
-- explanation_id = unik untuk explanation chunks
CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_unique_exercise_chunk
  ON explanations_embedding (exercise_id, chunk_type)
  WHERE exercise_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ee_unique_explanation
  ON explanations_embedding (explanation_id)
  WHERE explanation_id IS NOT NULL AND exercise_id IS NULL;

-- ── Selesai ──────────────────────────────────────────────────────────────────
COMMIT;

-- Verifikasi setelah migration:
-- SELECT column_name, data_type, atttypmod
-- FROM information_schema.columns c
-- JOIN pg_attribute a ON a.attname = c.column_name
-- JOIN pg_class cl ON cl.oid = a.attrelid AND cl.relname = 'explanations_embedding'
-- WHERE table_name = 'explanations_embedding';
