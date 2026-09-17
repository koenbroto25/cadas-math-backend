const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const db = require('./database/db');

const app = express();
const PORT = process.env.PORT || 3000;

const SPEED_MASTER = process.env.ASSET_ROOT || (process.platform === 'win32'
  ? path.join('D:', 'local-rag-voice-bot', 'speed-math-master')
  : path.join(__dirname, '..', 'data'));
app.set('trust proxy', 'loopback');

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
app.use('/api/midtrans',    require('./routes/midtrans'));   // Sprint D.2 - midtrans gateway

// Sprint F.5 - /api/config: konfigurasi dinamis untuk mobile (public, tanpa auth)
// Aplikasi fetch endpoint ini saat startup, simpan ke store/AsyncStorage.
// Update nilai di sini (atau .env backend) â†’ restart backend â†’ app ikut berubah TANPA rebuild APK.
app.get('/api/config', (req, res) => {
  res.json({
    apiVersion:  '1.0.0',
    apiBase:     process.env.APP_BASE_URL || 'https://cadas.app',
    pwaUrl:      process.env.PWA_URL      || 'https://cadasmatematika.id',
    r2PublicUrl: process.env.R2_PUBLIC_URL || null,
    adminWhatsapp: process.env.ADMIN_WHATSAPP || null,
    // Flag kontrol fitur â€” tambahkan sesuai kebutuhan:
    // maintenanceMode, minSupportedVersion, ttsEnabled, dsb.
  });
});

// Sprint D.6 - /d/:token redirect (download link tracker + referral attach)
// Alur: sekolah/marketing share link /d/:token ke WA grup
// Siswa klik -> tracking click -> redirect ke PWA dengan ?ref=REFERRAL_CODE
// Frontend PWA simpan ?ref ke localStorage -> kirim saat register
app.get('/d/:token', async (req, res) => {
  const { token } = req.params;
  if (!/^[A-Za-z0-9_-]+$/.test(token)) return res.status(400).send('Token tidak valid');
  let referralCode = null;
  try {
    const r = await db.query(
      "SELECT id, referral_code, is_active FROM referrers WHERE referral_token = $1 AND status = 'approved'",
      [token]);
    const referrer   = r.rowCount > 0 ? r.rows[0] : null;
    const referrerId = referrer ? referrer.id : null;
    referralCode     = referrer ? referrer.referral_code : null;
    const crypto = require('crypto');
    const ipRaw  = (req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '';
    const ipHash = crypto.createHash('sha256').update(ipRaw).digest('hex');
    await db.query(
      'INSERT INTO download_clicks (referral_token, referrer_id, ip_hash, user_agent) VALUES ($1, $2, $3, $4)',
      [token, referrerId, ipHash, req.headers['user-agent'] || '']);
    if (referrerId && referrer.is_active) {
      await db.query('UPDATE referrers SET total_clicks = total_clicks + 1 WHERE id = $1', [referrerId]);
    }
  } catch (err) {
    console.error('Download click tracking error:', err.message);
  }
  const pwaUrl = process.env.PWA_URL || 'https://cadasmatematika.id';
  const dest   = referralCode ? (pwaUrl + '?ref=' + encodeURIComponent(referralCode)) : pwaUrl;
  res.redirect(302, dest);
});

// Sprint H.4 - Asset serving (VM-local)
// Prioritas: file lokal di ASSETS_ROOT (layout mirror bucket R2) ->
// fallback layout legacy speed-master -> R2 redirect (HANYA bila
// R2_PUBLIC_URL diisi). Untuk 100% lokal VM: hapus/kosongkan R2_PUBLIC_URL.
const ASSETS_ROOT = process.env.ASSETS_ROOT || SPEED_MASTER;
const R2_URL = process.env.R2_PUBLIC_URL || '';

function sendLocal(res, candidates) {
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      if (f.endsWith('.opus')) res.setHeader('Content-Type', 'audio/ogg');
      res.sendFile(f);
      return true;
    }
  }
  return false;
}

const localOpus = (...p) => path.join(ASSETS_ROOT, ...p);
const legacyAudio = (...p) => path.join(SPEED_MASTER, 'audio', ...p);

app.get('/api/tts/:id', (req, res) => {
  const type = ['hint', 'trick'].includes(req.query.type) ? req.query.type : 'hint';
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('speech', 'cache', 'opus', req.params.id + '_' + type + '.opus'),
    legacyAudio('speech', 'cache', req.params.id + '_' + type + '.wav'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/speech/cache/opus/' + req.params.id + '_' + type + '.opus');
  res.status(404).json({ error: 'audio belum tersedia' });
});

app.get('/api/viseme/:id', (req, res) => {
  const type = ['hint', 'trick'].includes(req.query.type) ? req.query.type : 'hint';
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.id)) {
    return res.status(400).json({ error: 'id tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('speech', 'cache', 'visemes', req.params.id + '_' + type + '.json'),
    legacyAudio('speech', 'cache', 'visemes', req.params.id + '_' + type + '.json'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/speech/cache/visemes/' + req.params.id + '_' + type + '.json');
  res.status(404).json({ error: 'viseme belum tersedia' });
});

app.get('/api/bot-audio/:file', (req, res) => {
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.file)) {
    return res.status(400).json({ error: 'file tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('bot', 'speech', 'opus', req.params.file + '.opus'),
    legacyAudio('bot', 'speech', 'opus', req.params.file + '.opus'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/bot/speech/opus/' + req.params.file + '.opus');
  res.status(404).json({ error: 'bot audio tidak tersedia' });
});

// Sprint H.7 - Bot viseme endpoint (/bot/speech/visemes/)
app.get('/api/bot-viseme/:file', (req, res) => {
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.file)) {
    return res.status(400).json({ error: 'file tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('bot', 'speech', 'visemes', req.params.file + '.json'),
    legacyAudio('bot', 'speech', 'visemes', req.params.file + '.json'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/bot/speech/visemes/' + req.params.file + '.json');
  res.status(404).json({ error: 'bot viseme tidak tersedia' });
});

// Sprint Audio - BGM & SFX paket cadas-audio (cadas-sounds.md Bagian 4)
// Primary: file lokal Opus. Fallback: R2 redirect (bila R2_PUBLIC_URL diisi).
app.get('/api/bgm/:file', (req, res) => {
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.file)) {
    return res.status(400).json({ error: 'file tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('audio', 'bgm', req.params.file + '.opus'),
    legacyAudio('bgm', req.params.file + '.opus'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/audio/bgm/' + req.params.file + '.opus');
  res.status(404).json({ error: 'bgm belum tersedia' });
});

app.get('/api/sfx/:file', (req, res) => {
  if (!/^[A-Za-z0-9_\-]+$/.test(req.params.file)) {
    return res.status(400).json({ error: 'file tidak valid' });
  }
  if (sendLocal(res, [
    localOpus('audio', 'sfx', req.params.file + '.opus'),
    legacyAudio('sfx', req.params.file + '.opus'),
  ])) return;
  if (R2_URL) return res.redirect(302, R2_URL + '/audio/sfx/' + req.params.file + '.opus');
  res.status(404).json({ error: 'sfx belum tersedia' });
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

// Startup: build enriched vocabulary dari DB exercises (sekali saat server start).
// Graceful: jika gagal, semua modul tetap jalan dengan base hardcode id-math-synonyms.js.
const { buildEnrichedSynonyms } = require('./rag/corpus-vocab-builder');
const { init: initSoalCerita }  = require('./rag/soal-cerita');
const { initQueryProcessor }    = require('./rag/query-processor');
const { setEnrichedOps }        = require('./rag/math-validator');

(async () => {
  try {
    const enriched = await buildEnrichedSynonyms();
    initSoalCerita(enriched.opSynonyms, null);   // Layer B deteksi operasi soal cerita
    setEnrichedOps(enriched.opSynonyms);         // Layer B koreksi math-validator
    initQueryProcessor(enriched);                // enriched synonyms query-processor
    console.log('[Startup] âœ… Enriched vocab siap:', enriched.stats);
  } catch (err) {
    console.warn('[Startup] âš ï¸ Vocab enrichment gagal â€” pakai base hardcode:', err.message);
  }
})();

app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`Cadas backend running on port ${PORT}`);
});

module.exports = app;

