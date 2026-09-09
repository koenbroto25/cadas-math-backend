-- ============================================================
-- 011 — RAG & Selection Rule Tables (FASE 8)
-- ============================================================

-- Embedding untuk semantic search (Layer 2)
CREATE TABLE IF NOT EXISTS explanations_embedding (
  explanation_id UUID PRIMARY KEY REFERENCES explanations(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES concepts(id),
  level_id INT NOT NULL,
  embedding VECTOR(384),  -- dimension matches all-MiniLM-L6-v2
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Bias varian penjelasan per siswa (FASE 4.4 + FASE 8.3b)
CREATE TABLE IF NOT EXISTS student_variant_bias (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level INT NOT NULL,
  variant_id VARCHAR(50) NOT NULL,
  offer_from_attempt INT NOT NULL DEFAULT 2,  -- 1 = tawarkan di percobaan pertama
  source VARCHAR(20) NOT NULL CHECK (source IN ('placement', 'performance')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (student_id, level, variant_id, source)
);

-- Efektivitas penjelasan per siswa-konsep (FASE 8.3b)
CREATE TABLE IF NOT EXISTS student_explanation_effectiveness (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  concept_id UUID REFERENCES concepts(id),
  level INT NOT NULL,
  variant_used VARCHAR(50) NOT NULL,
  times_shown INT DEFAULT 0,
  times_helpful INT DEFAULT 0,
  last_shown_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (student_id, concept_id, variant_used)
);

-- Kuota AskKak per siswa per level (ADD §3.2)
CREATE TABLE IF NOT EXISTS student_level_quota (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level INT NOT NULL,
  llm_calls_used INT DEFAULT 0,
  llm_calls_limit INT DEFAULT 40,  -- default 40 calls per level per month
  quota_reset_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (student_id, level)
);

-- Cache pertanyaan siswa (dedup via question_hash)
CREATE TABLE IF NOT EXISTS student_questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  question_text TEXT NOT NULL,
  question_hash VARCHAR(64) NOT NULL,  -- SHA-256 of normalized question
  concept_id UUID,
  level INT,
  source VARCHAR(20) NOT NULL CHECK (source IN ('lexical', 'semantic', 'openrouter', 'pregenerated')),
  answer_text TEXT,
  audio_url TEXT,
  is_premium BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Circuit breaker log (FASE 8.4)
CREATE TABLE IF NOT EXISTS openrouter_cost_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID REFERENCES students(id),
  level INT,
  cost_usd NUMERIC(10,6),
  tokens_used INT,
  model VARCHAR(100),
  success BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_explanations_embedding_concept ON explanations_embedding(concept_id);
CREATE INDEX IF NOT EXISTS idx_explanations_embedding_level ON explanations_embedding(level_id);
CREATE INDEX IF NOT EXISTS idx_student_variant_bias_student ON student_variant_bias(student_id);
CREATE INDEX IF NOT EXISTS idx_student_variant_bias_level ON student_variant_bias(student_id, level);
CREATE INDEX IF NOT EXISTS idx_student_explanation_student ON student_explanation_effectiveness(student_id);
CREATE INDEX IF NOT EXISTS idx_student_explanation_concept ON student_explanation_effectiveness(student_id, concept_id);
CREATE INDEX IF NOT EXISTS idx_student_level_quota_student ON student_level_quota(student_id);
CREATE INDEX IF NOT EXISTS idx_student_questions_hash ON student_questions(student_id, question_hash);
CREATE INDEX IF NOT EXISTS idx_student_questions_student ON student_questions(student_id);
CREATE INDEX IF NOT EXISTS idx_openrouter_cost_created ON openrouter_cost_log(created_at);
