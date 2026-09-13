-- Migration 015: student_trial_usage
-- Track berapa soal trial sudah dikerjakan per siswa per level
-- Trial = 5 soal pertama (ORDER BY source_id) di level yang belum dibayar

BEGIN;

CREATE TABLE IF NOT EXISTS student_trial_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level_id     INT  NOT NULL,
  questions_used INT NOT NULL DEFAULT 0,  -- sudah mengerjakan berapa soal trial
  exhausted    BOOLEAN NOT NULL DEFAULT false, -- sudah habis 5 soal
  first_used_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at  TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT student_trial_usage_student_level_key UNIQUE (student_id, level_id)
);

CREATE INDEX IF NOT EXISTS idx_trial_usage_student ON student_trial_usage(student_id);
CREATE INDEX IF NOT EXISTS idx_trial_usage_exhausted ON student_trial_usage(student_id, exhausted);

INSERT INTO _migrations(name) VALUES ('015_student_trial_usage') ON CONFLICT DO NOTHING;

COMMIT;
