-- Boss Battle System (Fase 3 — Placement_Test_System.md §5.8 / §12.3)
-- Championship gate di Level 9: siswa wajib mengalahkan boss
-- (9 hit x 3 fase = 27 pukulan, tiap hit wajib benar + ≤6 detik)
-- sebelum boleh akses Level 10+.
-- Idempotent: aman dijalankan berulang.

CREATE TABLE IF NOT EXISTS boss_battles (
  id VARCHAR(50) PRIMARY KEY,
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  level INT NOT NULL DEFAULT 9,
  boss_hp INT NOT NULL DEFAULT 27,
  boss_hp_max INT NOT NULL DEFAULT 27,
  phase INT NOT NULL DEFAULT 1,
  total_phases INT NOT NULL DEFAULT 3,
  hits_landed INT NOT NULL DEFAULT 0,
  hits_needed INT NOT NULL DEFAULT 27,
  player_lives INT NOT NULL DEFAULT 3,
  player_lives_max INT NOT NULL DEFAULT 3,
  streak INT NOT NULL DEFAULT 0,
  best_streak INT NOT NULL DEFAULT 0,
  avg_hit_time_ms INT,
  best_hit_time_ms INT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  result VARCHAR(20),
  hit_log JSONB
);

CREATE INDEX IF NOT EXISTS idx_boss_battles_student ON boss_battles(student_id);
CREATE INDEX IF NOT EXISTS idx_boss_battles_status ON boss_battles(status);

-- Status championship gate per siswa (durasi pendek, bisa di-set manual)
CREATE TABLE IF NOT EXISTS boss_gate_status (
  student_id UUID PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
  boss_level INT NOT NULL DEFAULT 9,
  defeated BOOLEAN NOT NULL DEFAULT FALSE,
  attempts INT NOT NULL DEFAULT 0,
  last_result VARCHAR(20),
  best_time_ms INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
