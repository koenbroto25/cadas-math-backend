-- ============================================================
-- 005 — content_release_log (FASE 2.3) + student_sessions (FASE 2.4)
-- ============================================================

-- Catatan rilis konten: satu baris per eksekusi ETL
CREATE TABLE IF NOT EXISTS content_release_log (
    id SERIAL PRIMARY KEY,
    released_at TIMESTAMPTZ DEFAULT NOW(),
    source TEXT DEFAULT 'material_generator_dev',
    exercises_count INT,
    explanations_count INT,
    audio_segments_count INT,
    notes TEXT
);

-- Hasil sesi latihan (FASE 2.4: POST /api/progress/session)
CREATE TABLE IF NOT EXISTS student_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    device_id TEXT,
    level_id INT NOT NULL,
    total_questions INT NOT NULL DEFAULT 0,
    correct_count INT NOT NULL DEFAULT 0,
    avg_time_ms INT,
    results JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_student ON student_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_sessions_level ON student_sessions(level_id);
