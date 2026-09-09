-- Placement Test Tables (from speed-math-master)
-- Stores placement probe configurations and student responses

CREATE TABLE IF NOT EXISTS placement_tests (
  id VARCHAR(50) PRIMARY KEY,
  student_id VARCHAR(100) NOT NULL,
  start_level INT DEFAULT 5,
  current_level INT,
  probes JSONB,
  results JSONB,
  placed_level INT,
  prerequisite_signals JSONB,
  student_variant_bias JSONB,
  status VARCHAR(20) DEFAULT 'in_progress',
  started_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS placement_probe_results (
  id VARCHAR(50) PRIMARY KEY,
  placement_test_id VARCHAR(50) NOT NULL REFERENCES placement_tests(id),
  level INT NOT NULL,
  probe_type VARCHAR(20),
  skill_area VARCHAR(50),
  problem_id VARCHAR(50),
  student_answer VARCHAR(100),
  correct BOOLEAN,
  time_taken_ms INT,
  time_limit_ms INT,
  within_time BOOLEAN,
  attempt_number INT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_placement_tests_student ON placement_tests(student_id);
CREATE INDEX IF NOT EXISTS idx_placement_tests_status ON placement_tests(status);
CREATE INDEX IF NOT EXISTS idx_placement_probe_results_test ON placement_probe_results(placement_test_id);