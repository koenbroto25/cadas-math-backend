-- Placement Test v2 (speed-first redesign, see Placement_Test_System.md §5-6)
-- Adds early-stop tracking and per-level breakdown to placement_tests.

ALTER TABLE placement_tests ADD COLUMN IF NOT EXISTS early_stop_reason VARCHAR(50);
ALTER TABLE placement_tests ADD COLUMN IF NOT EXISTS level_breakdown JSONB;
ALTER TABLE placement_tests ADD COLUMN IF NOT EXISTS total_questions INT;
