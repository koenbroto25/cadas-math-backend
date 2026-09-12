/**
 * GET /api/exercises/:level   — daftar soal per level
 * GET /api/exercises/item/:id — satu soal by source_id (mis. L5_P4_001)
 */
const express = require('express');
const db = require('../database/db');

const router = express.Router();

// FIELDS: tambah concept_id + concept_code untuk Selection Rule (Sprint B item 1)
const FIELDS = `
  e.source_id AS id, e.level_id AS level, e.question_text, e.answer_value,
  e.hint_text, e.quick_trick, e.speech_text, e.operation, e.num1, e.num2,
  e.visualization_type, e.concept_id, COALESCE(c.code, 'general') AS concept_code`;

router.get('/:level', async (req, res) => {
  const level = parseInt(req.params.level, 10);
  if (!Number.isInteger(level) || level < 1 || level > 15) {
    return res.status(400).json({ error: 'level harus angka 1-15' });
  }
  try {
    const r = await db.query(
      `SELECT ${FIELDS} FROM exercises e LEFT JOIN concepts c ON e.concept_id = c.id WHERE e.level_id = $1 ORDER BY e.source_id`,
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
      `SELECT ${FIELDS} FROM exercises e LEFT JOIN concepts c ON e.concept_id = c.id WHERE e.source_id = $1`,
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


// GET /api/exercises/level-info/:level_id
router.get('/level-info/:level_id', async (req, res) => {
  try {
    const r = await db.query(
      'SELECT id, name, description FROM levels WHERE id = $1',
      [parseInt(req.params.level_id)]
    );
    if (r.rowCount === 0) return res.status(404).json({ error: 'level tidak ditemukan' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
module.exports = router;
