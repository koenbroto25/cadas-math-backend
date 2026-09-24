-- 039: Finance scheduler audit + admin-triggerable maintenance runs.
BEGIN;
CREATE TABLE IF NOT EXISTS finance_scheduler_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  affected_count INT NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_finance_scheduler_runs_job
  ON finance_scheduler_runs(job_name, started_at DESC);

-- Audit lifecycle untuk window referrer yang berakhir otomatis.
CREATE INDEX IF NOT EXISTS idx_referrer_windows_expiry
  ON referrer_windows(status, expires_at);
INSERT INTO _migrations(name) VALUES ('039_finance_scheduler') ON CONFLICT DO NOTHING;
COMMIT;
