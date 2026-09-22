-- Migration 024: Session Notification System (fixed: students.id = UUID)
BEGIN;

CREATE TABLE IF NOT EXISTS study_sessions (
  id                  SERIAL PRIMARY KEY,
  student_id          UUID NOT NULL REFERENCES students(id),
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at            TIMESTAMPTZ,
  duration_active_ms  BIGINT DEFAULT 0,
  duration_total_ms   BIGINT DEFAULT 0,
  exit_count          INTEGER DEFAULT 0,
  focus_ratio         NUMERIC(5,2),
  level               INTEGER,
  correct_count       INTEGER DEFAULT 0,
  total_count         INTEGER DEFAULT 0,
  accuracy            NUMERIC(5,2),
  level_up            BOOLEAN DEFAULT FALSE,
  notif_sent          BOOLEAN DEFAULT FALSE,
  status              VARCHAR(20) DEFAULT 'active'
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_student ON study_sessions(student_id);
CREATE INDEX IF NOT EXISTS idx_study_sessions_started ON study_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_study_sessions_student_date ON study_sessions(student_id, started_at);

CREATE TABLE IF NOT EXISTS study_schedules (
  id          SERIAL PRIMARY KEY,
  student_id  UUID NOT NULL REFERENCES students(id) UNIQUE,
  days        INTEGER[] DEFAULT '{1,2,3,4,5}',
  start_time  TIME NOT NULL DEFAULT '16:00',
  end_time    TIME NOT NULL DEFAULT '17:00',
  timezone    VARCHAR(50) DEFAULT 'Asia/Jakarta',
  active      BOOLEAN DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id          SERIAL PRIMARY KEY,
  user_id     UUID NOT NULL,
  user_type   VARCHAR(10) NOT NULL,
  token       TEXT NOT NULL UNIQUE,
  platform    VARCHAR(10) NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id, user_type);

ALTER TABLE students
  ADD COLUMN IF NOT EXISTS daily_target_minutes INTEGER DEFAULT 30,
  ADD COLUMN IF NOT EXISTS weekly_target_days   INTEGER DEFAULT 5;

INSERT INTO _migrations(name) VALUES ('024_session_notification_system')
  ON CONFLICT DO NOTHING;

COMMIT;