const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

const SPEED_MASTER = path.join('D:', 'local-rag-voice-bot', 'speed-math-master');

app.use(cors());
app.use(express.json());

// Static assets
app.use('/exercises', express.static(path.join(SPEED_MASTER, 'output', 'exercises')));
app.use('/audio',     express.static(path.join(SPEED_MASTER, 'audio')));

// Routes
app.use('/api/auth',         require('./routes/auth'));
app.use('/api/exercises',    require('./routes/exercises'));
app.use('/api/progress',     require('./routes/progress'));
app.use('/api/placement',    require('./routes/placement'));
app.use('/api/upgrade-test', require('./routes/upgrade-test'));
app.use('/api/rag',          require('./routes/rag'));
app.use('/api/payment',      require('./routes/payment'));
app.use('/api/admin',        require('./routes/admin'));       // Sprint D.4 - admin dashboard
app.use('/api/referrer',     require('./routes/referrer'));    // Sprint D.3+D.5 - referrer auth+dashboard
app.use('/api/teacher',      require('./routes/teacher'));     // Sprint F
app.use('/api/parent',       require('./routes/parent'));      // Sprint E
app.use('/api/xendit',       require('./routes/xendit'));      // Sprint D.2 - xendit gateway

// Sprint D.6 - /d/:token redirect (download link tracker)
app.get('/d/:token', async (req, res) => {
  const { token } = req.params;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return res.status(400).send('Token tidak valid');

  const STORE_URL = process.env.APP_STORE_URL || 'https://play.google.com/store/apps/details?id=com.cadasapp';

  try {
    const r = await db.query(
      'SELECT id FROM referrers WHERE referral_token = $1', [token]);

    const referrerId = r.rowCount > 0 ? r.rows[0].id : null;

    // Log klik
    const ipRaw = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip    = ipRaw.split(',')[0].trim();
    // Hash IP sederhana (privacy)
    const crypto = require('crypto');
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').slice(0, 16);

    await db.query(`
      INSERT INTO download_clicks (referral_token, referrer_id, ip_hash, user_agent)
      VALUES ($1, $2, $3, $4)
    `, [token, referrerId, ipHash, req.headers['user-agent'] || '']);

    if (referrerId) {
      await db.query(
        'UPDATE referrers SET total_clicks = total_clicks + 1 WHERE id = $1',
        [referrerId]);
    }
  } catch (err) {
    console.error('Download click tracking error:', err.message);
    // Tetap redirect meski tracking gagal
  }

  res.redirect(302, STORE_URL);
});

// TTS per-soal cache
app.get('/api/tts/:id', (req, res) => {
  const type = ['hint', 'trick'].includes(req.query.type) ? req.query.type : 'hint';
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id tidak valid' });
  }
  const file = path.join(SPEED_MASTER, 'audio', 'speech', 'cache', `${req.params.id}_${type}.wav`);
  if (fs.existsSync(file)) return res.sendFile(file);
  res.status(404).json({ error: 'audio belum tersedia (fallback teks di app)' });
});

// Health check
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
    res.status(500).json({ status: 'ERROR', database: 'disconnected', error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Cadas backend running on port ${PORT}`);
});

module.exports = app;
