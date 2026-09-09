-- Upgrade Test Tables (from speed-math-master)
-- Stores upgrade test configurations and problems

CREATE TABLE IF NOT EXISTS upgrade_tests (
  id VARCHAR(50) PRIMARY KEY,
  level INT NOT NULL,
  level_to INT NOT NULL,
  test_type VARCHAR(10) NOT NULL, -- 'A', 'B', 'C'
  num_problems INT NOT NULL,
  time_limit_ms INT, -- NULL for Type A (untimed)
  pass_accuracy_threshold NUMERIC(3,2) DEFAULT 0.90,
  problems JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_upgrade_tests_level ON upgrade_tests(level);
CREATE INDEX IF NOT EXISTS idx_upgrade_tests_type ON upgrade_tests(test_type);