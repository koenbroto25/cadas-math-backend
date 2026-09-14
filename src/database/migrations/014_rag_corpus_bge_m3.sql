-- Migration 014: RAG corpus generalisasi + upgrade embedding ke BGE-M3 (1024 dim)
-- Sebelumnya: explanations_embedding hanya index 15 baris explanations, embedding 384-dim hashing-trick.
-- Sekarang: index ~16.276 chunks dari exercises (hint/trick/speech) + explanations (content/variants),
--           embedding asli BGE-M3 1024-dim via Ollama lokal.

-- 1. Hapus data lama (minimal, hashing-trick, tidak berguna)
TRUNCATE TABLE explanations_embedding;

-- 2. Drop FK constraint ke explanations (source sekarang bisa exercises ATAU explanations)
ALTER TABLE explanations_embedding DROP CONSTRAINT IF EXISTS explanations_embedding_explanation_id_fkey;

-- 3. Generalisasi kolom: explanation_id -> source_id (UUID generik) + source_type
ALTER TABLE explanations_embedding RENAME COLUMN explanation_id TO source_id;
ALTER TABLE explanations_embedding ADD COLUMN IF NOT EXISTS source_type VARCHAR(30) NOT NULL DEFAULT 'explanation';
-- source_type: 'explanation' | 'explanation_variant' | 'exercise_hint' | 'exercise_trick' | 'exercise_speech'

-- 4. Upgrade dimensi vector: 384 -> 1024 (BGE-M3)
ALTER TABLE explanations_embedding ALTER COLUMN embedding TYPE vector(1024);

-- 5. Index untuk pencarian cepat (ivfflat, cosine distance)
DROP INDEX IF EXISTS idx_explanations_embedding_vector;
CREATE INDEX idx_explanations_embedding_vector
  ON explanations_embedding USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- 6. Index tambahan untuk filter cepat
CREATE INDEX IF NOT EXISTS idx_ee_level_source ON explanations_embedding(level_id, source_type);
CREATE INDEX IF NOT EXISTS idx_ee_source_id ON explanations_embedding(source_id);
