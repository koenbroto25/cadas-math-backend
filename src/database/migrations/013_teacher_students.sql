-- Migration 013: teacher_students junction table
-- Guru bisa punya banyak murid, murid bisa punya banyak guru

BEGIN;

CREATE TABLE IF NOT EXISTS teacher_students (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id uuid NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
  student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  linked_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT teacher_students_teacher_student_key UNIQUE (teacher_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_teacher_students_teacher ON teacher_students(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_students_student ON teacher_students(student_id);

INSERT INTO _migrations(name) VALUES ('013_teacher_students') ON CONFLICT DO NOTHING;

COMMIT;
