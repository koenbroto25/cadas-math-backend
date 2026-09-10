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
// /api/admin/* → payment.js di-mount di /api/payment; /billing/* sudah reachable via /api/payment/billing/*
// Double-mount dihapus untuk menghindari route conflict.


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

app.listen(PORT, () => {
  console.log(`Cadas backend running on port ${PORT}`);
});

module.exports = app;
