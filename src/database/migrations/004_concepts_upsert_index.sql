-- ============================================================
-- 004 — Idempotensi ETL: concepts bisa di-upsert (bukan delete-insert)
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_concepts_level_code
    ON concepts(level_id, code);
