-- ============================================================
-- 003 — Penyesuaian skema hasil audit sumber (material_generator_dev)
-- + tabel voice untuk migrasi bertahap
-- ============================================================

-- Variant milik PENDEKATAN PENJELASAN (GASING/PMRI/quick), bukan per
-- soal/konsep — sumber tidak punya variant per exercise. Boleh NULL.
ALTER TABLE concepts ALTER COLUMN variant DROP NOT NULL;
ALTER TABLE exercises ALTER COLUMN variant DROP NOT NULL;

-- Jejak sumber + kolom konten penuh untuk exercises
ALTER TABLE exercises
    ADD COLUMN IF NOT EXISTS source_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS source_concept_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS speech_text TEXT,
    ADD COLUMN IF NOT EXISTS quick_trick TEXT,
    ADD COLUMN IF NOT EXISTS operation VARCHAR(8),
    ADD COLUMN IF NOT EXISTS num1 NUMERIC,
    ADD COLUMN IF NOT EXISTS num2 NUMERIC,
    ADD COLUMN IF NOT EXISTS correct_answer NUMERIC,
    ADD COLUMN IF NOT EXISTS visualization_type VARCHAR(32);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exercises_source_id
    ON exercises(source_id) WHERE source_id IS NOT NULL;

-- explanations diperkaya dari sumber (step/variants/speech)
ALTER TABLE explanations
    ADD COLUMN IF NOT EXISTS source_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS steps JSONB,
    ADD COLUMN IF NOT EXISTS variants JSONB,
    ADD COLUMN IF NOT EXISTS quick_method TEXT,
    ADD COLUMN IF NOT EXISTS speech_friendly_text TEXT,
    ADD COLUMN IF NOT EXISTS speech_variants JSONB;

CREATE UNIQUE INDEX IF NOT EXISTS uq_explanations_source_id
    ON explanations(source_id) WHERE source_id IS NOT NULL;

-- ---------- VOICE (migrasi bertahap) ----------

-- Fase voice 1: segmen audio konsep per level (120 segmen, 100% ada)
-- File: audio/speech/gemini/wav/L{n}_{seg}.wav + visemes/L{n}_{seg}.json
CREATE TABLE IF NOT EXISTS level_audio_segments (
    id SERIAL PRIMARY KEY,
    level_id INT NOT NULL REFERENCES levels(id),
    segment TEXT NOT NULL,
    spoken_text TEXT,
    audio_url TEXT NOT NULL,
    viseme_url TEXT,
    viseme_json JSONB,
    UNIQUE (level_id, segment)
);

-- Fase voice 2: cache TTS per soal (hint/trick) — di-backfill bertahap
-- selama precache di speed-math-master masih berjalan (~54% saat ini).
-- Konvensi file: audio/speech/cache/{source_id}_hint.wav | _trick.wav
CREATE TABLE IF NOT EXISTS exercise_audio (
    id SERIAL PRIMARY KEY,
    exercise_source_id VARCHAR(64) NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('hint', 'trick')),
    audio_url TEXT NOT NULL,
    file_exists BOOLEAN DEFAULT FALSE,
    UNIQUE (exercise_source_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_eaudio_source ON exercise_audio(exercise_source_id);
