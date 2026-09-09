/**
 * GET /api/exercises/:level   — daftar soal per level
 * GET /api/exercises/item/:id — satu soal by source_id (mis. L5_P4_001)
 */
const express = require('express');
const db = require('../database/db');

const router = express.Router();

const FIELDS = `
  source_id AS id, level_id AS level, question_text, answer_value,
  hint_text, quick_trick, speech_text, operation, num1, num2,
  visualization_type`;

router.get('/:level', async (req, res) => {
  const level = parseInt(req.params.level, 10);
  if (!Number.isInteger(level) || level < 1 || level > 15) {
    return res.status(400).json({ error: 'level harus angka 1-15' });
  }
  try {
    const r = await db.query(
      `SELECT ${FIELDS} FROM exercises WHERE level_id = $1 ORDER BY source_id`,
      [level]
    );
    res.json({ level, total: r.rowCount, exercises: r.rows });
  } catch (err) {
    console.error('GET /api/exercises/:level error:', err.message);
    res.status(500).json({ error: 'gagal memuat soal' });
  }
});

router.get('/item/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT ${FIELDS} FROM exercises WHERE source_id = $1`,
      [req.params.id]
    );
    if (r.rowCount === 0) {
      return res.status(404).json({ error: 'exercise tidak ditemukan' });
    }
    res.json(r.rows[0]);
  } catch (err) {
    console.error('GET /api/exercises/item/:id error:', err.message);
    res.status(500).json({ error: 'gagal memuat soal' });
  }
});

module.exports = router;
