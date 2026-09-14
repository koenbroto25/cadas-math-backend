-- Migration 017: admin_rag_miss
-- Log pertanyaan siswa yang tidak terjawab dari corpus (semantic miss)
-- Digunakan sebagai backlog pengembangan materi di dashboard admin.
--
-- Jalankan: psql -U postgres -d cadas_app_dev -f src/database/migrations/017_admin_rag_miss.sql

CREATE TABLE IF NOT EXISTS admin_rag_miss (
  id              BIGSERIAL PRIMARY KEY,
  student_id      UUID         REFERENCES students(id) ON DELETE SET NULL,
  level_id        INTEGER      NOT NULL,
  question_text   TEXT         NOT NULL,
  top_sim_score   NUMERIC(5,4),                -- similarity score tertinggi yang didapat (< SIM_PARTIAL)
  top_chunk_text  TEXT,                        -- chunk terdekat yang ditemukan (untuk konteks admin)
  llm_answered    BOOLEAN      NOT NULL DEFAULT false,  -- apakah akhirnya dijawab LLM
  llm_model       TEXT,                        -- model yang menjawab jika llm_answered=true
  resolved        BOOLEAN      NOT NULL DEFAULT false,  -- admin tandai sudah ditangani (materi ditambah)
  resolved_at     TIMESTAMPTZ,
  resolved_note   TEXT,                        -- catatan admin saat resolve
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Index untuk query dashboard: per level, terbaru, belum resolved
CREATE INDEX IF NOT EXISTS idx_rag_miss_level_created
  ON admin_rag_miss (level_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_miss_resolved
  ON admin_rag_miss (resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rag_miss_student
  ON admin_rag_miss (student_id, created_at DESC);

-- Komentar tabel
COMMENT ON TABLE admin_rag_miss IS
  'Log pertanyaan siswa yang tidak terjawab dari corpus RAG (skor di bawah SIM_PARTIAL). '
  'Digunakan sebagai backlog pengembangan materi. resolved=true berarti sudah ditangani admin.';
