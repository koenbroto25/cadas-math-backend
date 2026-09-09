-- ============================================================
-- 002 — pgvector enabling (Layer 2 semantic search, RAG pipeline)
-- Aplikasikan HANYA bila extension 'vector' tersedia di instance
-- Postgres. migrate.js mem-probe dulu dan skip dengan warning
-- bila tidak tersedia (dev DB saat ini = postgres:16 polos).
-- Untuk production: gunakan image 'pgvector/pgvector:pg16'.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE explanations_embedding
    ADD COLUMN IF NOT EXISTS embedding vector(384); -- all-MiniLM-L6-v2

CREATE INDEX IF NOT EXISTS idx_expl_embed_vector
    ON explanations_embedding
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
