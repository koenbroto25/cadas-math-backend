-- ============================================================
-- CADAS APP DEV — Initial Schema (v1)
-- Source: PLAN_DEV_v3.1 §4 + Addendum v1 overrides
-- NOTE: pgvector extension is handled separately in 002_pgvector.sql
-- (probed gracefully — see src/database/migrate.js)
-- ============================================================

-- ---------- CONTENT TABLES (migrated from speed-math-master) ----------

CREATE TABLE IF NOT EXISTS levels (
    id INT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS concepts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    level_id INT NOT NULL REFERENCES levels(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    variant TEXT NOT NULL CHECK (variant IN ('gasing', 'pmri', 'quick')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS exercises (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id UUID REFERENCES concepts(id),
    level_id INT NOT NULL,
    question_text TEXT NOT NULL,
    answer_value TEXT NOT NULL,
    hint_text TEXT,
    variant TEXT NOT NULL CHECK (variant IN ('gasing', 'pmri', 'quick')),
    is_fast_track BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS explanations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    concept_id UUID REFERENCES concepts(id),
    level_id INT NOT NULL,
    content TEXT NOT NULL,
    audio_url TEXT,
    viseme_json JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);


-- ---------- STUDENTS / PARENTS / TEACHERS (V3.1 §4.2/4.4) ----------

CREATE TABLE IF NOT EXISTS students (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username TEXT UNIQUE NOT NULL,
    display_name TEXT,
    grade_level INT,
    current_level INT DEFAULT 1,
    trial_level INT DEFAULT 1,
    -- ⚠️ OVERRIDE (Addendum v1 §1.2): granular per-level purchase,
    -- BUKAN is_premium boolean global
    paid_basic_up_to_level INT DEFAULT NULL,
    paid_premium_up_to_level INT DEFAULT NULL,
    premium_activated_at TIMESTAMPTZ,
    referred_by UUID,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS parent_children (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
    student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    UNIQUE (parent_id, student_id)
);

CREATE TABLE IF NOT EXISTS teachers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    -- 'school' = guru sekolah (classroom gratis, 0% komisi)
    -- 'private' = guru les/tutor privat (dapat referral + komisi)
    teacher_type TEXT NOT NULL CHECK (teacher_type IN ('school', 'private')),
    is_verified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    teacher_id UUID REFERENCES teachers(id),
    student_id UUID REFERENCES students(id),
    referral_code TEXT UNIQUE NOT NULL,
    -- ⚠️ OVERRIDE Addendum v1 §4: per transaksi, bukan recurring
    commission_model TEXT DEFAULT 'per_transaction',
    commission_rate NUMERIC(5,2) DEFAULT 10.00,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);



-- ---------- BILLING (V3.1 §4.5 + Addendum v1) ----------

CREATE TABLE IF NOT EXISTS payment_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID NOT NULL REFERENCES students(id),
    -- 'basic_single' | 'basic_bundle_3' | 'premium_single' | 'premium_bundle_3'
    product_type TEXT NOT NULL,
    level_from INT NOT NULL,
    level_to INT NOT NULL,
    amount_idr INT NOT NULL,
    payment_method TEXT DEFAULT 'manual_transfer',
    proof_url TEXT,
    referrer_code TEXT,
    commission_amount_idr NUMERIC(12,2) DEFAULT 0,
    is_confirmed BOOLEAN DEFAULT FALSE,
    confirmed_by_admin_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- RAG / ASKKAK (V3.1 §4.3 + ⚠️ OVERRIDE: llm_model = openrouter) ----------

CREATE TABLE IF NOT EXISTS student_questions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id),
    level_id INT NOT NULL,
    question_text TEXT NOT NULL,
    answer_text TEXT,
    -- ⚠️ OVERRIDE: 'lexical' | 'semantic' | 'openrouter' (BUKAN ollama-local)
    source TEXT CHECK (source IN ('lexical', 'semantic', 'openrouter')),
    llm_model TEXT DEFAULT 'openrouter',
    response_time_ms INT,
    was_helpful BOOLEAN,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS explanations_embedding (
    id SERIAL PRIMARY KEY,
    level_id INT NOT NULL,
    concept_id UUID REFERENCES concepts(id),
    explanation_id UUID REFERENCES explanations(id) ON DELETE CASCADE,
    chunk_text TEXT NOT NULL,
    -- kolom embedding ditambahkan oleh 002_pgvector.sql bila tersedia
    embedding_ready BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS llm_usage_log (
    id BIGSERIAL PRIMARY KEY,
    student_id UUID REFERENCES students(id),
    level_id INT NOT NULL,
    model TEXT DEFAULT 'openrouter',
    estimated_cost_usd NUMERIC(10,6),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------- BASIC INDEXES ----------

CREATE INDEX IF NOT EXISTS idx_exercises_level ON exercises(level_id);
CREATE INDEX IF NOT EXISTS idx_exercises_concept ON exercises(concept_id);
CREATE INDEX IF NOT EXISTS idx_explanations_concept ON explanations(concept_id);
CREATE INDEX IF NOT EXISTS idx_payment_student ON payment_records(student_id);
CREATE INDEX IF NOT EXISTS idx_sq_student ON student_questions(student_id);
