const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./database/db');
const { verifyToken, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

// Folder konten statis dari speed-math-master (same laptop, dev).
// Production nanti: salin folder ini ke server / object storage.
const SPEED_MASTER = path.join('D:', 'local-rag-voice-bot', 'speed-math-master');

app.use(cors());
app.use(express.json());

// Static: HTML exercise (dipakai WebView di PracticeScreen)
app.use('/exercises', express.static(path.join(SPEED_MASTER, 'output', 'exercises')));
// Static: audio level + cache TTS + visemes
app.use('/audio', express.static(path.join(SPEED_MASTER, 'audio')));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/exercises', require('./routes/exercises'));
app.use('/api/progress', require('./routes/progress'));
app.use('/api/placement', require('./routes/placement'));
app.use('/api/upgrade-test', require('./routes/upgrade-test'));
app.use('/api/rag', require('./routes/rag'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/admin',   require('./routes/payment'));


// TTS per-soal: layani cache yang ada (voice migrasi bertahap).
// Bila file belum ada â†’ 404; app melakukan fallback ke teks (V3.1 Â§10.1).
app.get('/api/tts/:id', (req, res) => {
  const type = ['hint', 'trick'].includes(req.query.type) ? req.query.type : 'hint';
  // sanitasi: cegah path traversal
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id tidak valid' });
  }
  const file = path.join(SPEED_MASTER, 'audio', 'speech', 'cache', `${req.params.id}_${type}.wav`);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).json({ error: 'audio belum tersedia (fallback teks di app)' });
});

// Health check endpoint
app.get('/api/health', async (req, res) => {
  try {
    const dbResult = await db.query('SELECT NOW()');
    res.json({
      status: 'OK',
      timestamp: new Date().toISOString(),
      database: 'connected',
      db_time: dbResult.rows[0].now,
    });
  } catch (err) {
    console.error('Database health check failed:', err);
    res.status(500).json({
      status: 'ERROR',
      database: 'disconnected',
      error: err.message,
    });
  }
});

// Helper for Level Access (Addendum v1 Â§1.2)
function getLevelAccess(student, level) {
  if (level <= (student.trial_level || 1)) return 'basic';
  if (level <= (student.paid_premium_up_to_level || 0)) return 'premium';
  if (level <= (student.paid_basic_up_to_level || 0)) return 'basic';
  return 'locked';
}

// Student level access check endpoint stub
app.get('/api/billing/status/:student_id', verifyToken, requireRole('admin', 'parent'), async (req, res) => {
  const { student_id } = req.params;
  try {
    // Parent hanya boleh lihat data anaknya sendiri
    if (req.auth.role === 'parent') {
      const linkCheck = await db.query(
        'SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2',
        [req.auth.sub, student_id]
      );
      if (linkCheck.rowCount === 0) {
        return res.status(403).json({ error: 'akses denied - bukan anak Anda' });
      }
    }
    const result = await db.query(
      'SELECT id, username, display_name, trial_level, paid_basic_up_to_level, paid_premium_up_to_level, premium_activated_at FROM students WHERE id = $1',
      [student_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Student not found' });
    }
    const student = result.rows[0];
    res.json({
      student_id:                student.id,
      username:                  student.username,
      display_name:              student.display_name,
      trial_level:               student.trial_level || 1,
      paid_basic_up_to_level:    student.paid_basic_up_to_level || 0,
      paid_premium_up_to_level:  student.paid_premium_up_to_level || 0,
      premium_activated_at:      student.premium_activated_at,
      whatsapp_contact:          process.env.ADMIN_WHATSAPP || '6281234567890',
    });
  } catch (err) {
    console.error('Error fetching billing status:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cadas backend running on port ${PORT}`);
});

module.exports = app;
