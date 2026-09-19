/**
 * routes/card.js — Generate PDF Kartu Identitas Siswa
 * GET  /api/card/student/:studentId   → PDF (auth: student atau parent)
 * GET  /api/card/my                   → PDF milik student yang sedang login
 *
 * FIX 2026-09-18:
 *  - P0-1: requireAuth kini verifikasi token sendiri (lihat middleware).
 *  - P0-4: dukung ?token= khusus endpoint ini (allowQueryToken) agar
 *    PlacementCardModal bisa buka PDF via Linking tanpa header.
 *    Catatan keamanan: token tetap JWT penuh; risiko bocor via URL history
 *    diterima utk MVP; upgrade ke one-time ticket bila perlu.
 *  - P1-5: PDF generator hanya html-pdf-node (sudah di package.json).
 *    Hapus jalur puppeteer agar tidak ada log error menyesatkan.
 *  - D1/A1: SELECT pakai COALESCE agar baris lama tetap jalan.
 *  - D4: APP_BASE_URL default https://cadasmatematika.web.id.
 */

const express  = require('express');
const db       = require('../database/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://cadasmatematika.web.id';

// Aktifkan dukungan ?token= hanya untuk router ini (lihat middleware/auth.js).
router.use((req, res, next) => { req.allowQueryToken = true; next(); });

// ── Level name map ─────────────────────────────────────────────────────────────
const LEVEL_NAMES = {
  1: 'Penjumlahan & Pengurangan',
  2: 'Perkalian Awal', 3: 'Perkalian Dasar',
  4: 'Pembagian Awal', 5: 'Pecahan Dasar',
  6: 'Desimal',        7: 'Operasi Campuran',
  8: 'Kecepatan Hitung',9: 'Master Kecepatan',
  10:'Pecahan Lanjut', 11:'Desimal & Persen',
  12:'Rasio & Proporsi',13:'Aljabar Dasar',
  14:'Persamaan',      15:'Matematika Terapan',
};

// ── HTML template kartu ────────────────────────────────────────────────────────
function buildCardHtml(student) {
  const { name, kelas, display_id, current_level } = student;
  const levelName  = LEVEL_NAMES[current_level] || `Level ${current_level}`;
  const parentLink = `${APP_BASE_URL}/parent/join?ref=${display_id}`;
  // Tampilkan ID dengan spasi antar karakter
  const idSpaced   = (display_id || "").split('').join('  ');
  // Fonetik sederhana (huruf dibaca nama, angka dibaca angka)
  const phoneticMap = {
    A:'A',B:'Be',C:'Ce',D:'De',E:'E',F:'Ef',G:'Ge',H:'Ha',
    J:'Je',K:'Ka',L:'El',M:'Em',N:'En',P:'Pe',Q:'Ki',R:'Er',
    S:'Es',T:'Te',U:'U',V:'Ve',W:'We',X:'Eks',Y:'Ye',Z:'Zet',
    2:'dua',3:'tiga',4:'empat',5:'lima',6:'enam',7:'tujuh',8:'delapan',9:'sembilan',
  };
  const phonetic = (display_id || "").split('').map(c => phoneticMap[c] || c).join(' ');

  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="UTF-8"/>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif;
    background: #0A0A12;
    width: 600px; height: 380px;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    background: #13131F;
    border: 2px solid #00F0FF44;
    border-radius: 20px;
    padding: 28px 32px;
    width: 100%;
    color: #fff;
  }
  .header {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 20px;
  }
  .logo { color: #00F0FF; font-size: 22px; font-weight: 900; letter-spacing: 3px; }
  .logo span { color: #fff; }
  .badge {
    background: #00F0FF22; border: 1px solid #00F0FF66;
    border-radius: 20px; padding: 4px 14px;
    color: #00F0FF; font-size: 12px; font-weight: 700;
  }
  .name { font-size: 24px; font-weight: 800; margin-bottom: 4px; }
  .sub  { color: #888899; font-size: 13px; margin-bottom: 20px; }
  .row  { display: flex; gap: 16px; margin-bottom: 20px; }
  .info-box {
    flex: 1; background: #1A1A2E; border-radius: 12px;
    padding: 12px 16px;
  }
  .info-label { color: #888899; font-size: 10px; font-weight: 700;
    letter-spacing: 1px; text-transform: uppercase; margin-bottom: 4px; }
  .info-value { color: #fff; font-size: 15px; font-weight: 700; }
  .id-box {
    background: #0A0A12; border: 2px solid #00F0FF;
    border-radius: 14px; padding: 16px 20px; margin-bottom: 16px;
  }
  .id-label { color: #00F0FF; font-size: 10px; font-weight: 700;
    letter-spacing: 2px; text-transform: uppercase; margin-bottom: 8px; }
  .id-chars  { color: #00F0FF; font-size: 36px; font-weight: 900;
    letter-spacing: 14px; font-family: monospace; }
  .id-phonetic { color: #888899; font-size: 11px; margin-top: 4px; }
  .link-row { display: flex; align-items: center; gap: 8px; }
  .link-label { color: #888899; font-size: 11px; }
  .link-val { color: #00F0FF; font-size: 11px; word-break: break-all; }
  .footer { color: #444; font-size: 10px; text-align: center; margin-top: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="header">
    <div class="logo">C<span>ADA</span>S</div>
    <div class="badge">🎓 Kartu Identitas</div>
  </div>
  <div class="name">${name}</div>
  <div class="sub">Siswa Cadas Matematika</div>
  <div class="row">
    <div class="info-box">
      <div class="info-label">Kelas</div>
      <div class="info-value">${kelas}</div>
    </div>
    <div class="info-box">
      <div class="info-label">Level Saat Ini</div>
      <div class="info-value">${current_level} — ${levelName}</div>
    </div>
  </div>
  <div class="id-box">
    <div class="id-label">ID Masuk</div>
    <div class="id-chars">${idSpaced}</div>
    <div class="id-phonetic">${phonetic}</div>
  </div>
  <div class="link-row">
    <div class="link-label">Link orang tua:</div>
    <div class="link-val">${parentLink}</div>
  </div>
  <div class="footer">Cadas Matematika · ${APP_BASE_URL}</div>
</div>
</body>
</html>`;
}

// ── PDF generator (html-pdf-node — paling ringan, tidak butuh Chromium) ───────
async function generatePdf(html) {
  const htmlPdf = require('html-pdf-node');
  const file    = { content: html };
  const options = {
    format: 'A6',
    landscape: true,
    margin: { top: 0, right: 0, bottom: 0, left: 0 },
    printBackground: true,
  };
  return await htmlPdf.generatePdf(file, options);
}

router.get('/my', requireAuth, async (req, res) => {
  if (req.user.role !== 'student')
    return res.status(403).json({ error: 'Hanya untuk student.' });
  try {
    const r = await db.query(
      `SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level
       FROM students WHERE id = $1`, [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Tidak ditemukan.' });

    const html = buildCardHtml(r.rows[0]);
    const pdf  = await generatePdf(html);

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="kartu-cadas-${r.rows[0].display_id}.pdf"`,
      'Content-Length':      pdf.length,
      'Cache-Control':       'no-cache',
    });
    return res.end(pdf);
  } catch (err) {
    console.error('[card/my]', err);
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
});

// ── GET /api/card/student/:displayId — PDF by display_id ──────────────────────
// Bisa diakses parent (requireAuth saja, cek kepemilikan di bawah)
router.get('/student/:displayId', requireAuth, async (req, res) => {
  try {
    const { displayId } = req.params;
    const r = await db.query(
      `SELECT id, COALESCE(name, display_name) AS name, COALESCE(kelas, grade_level) AS kelas, display_id, current_level
       FROM students WHERE display_id = $1`,
      [displayId.toUpperCase()]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Siswa tidak ditemukan.' });

    const student = r.rows[0];

    // Otorisasi: hanya student itu sendiri atau parent yang link
    if (req.user.role === 'student' && req.user.id !== student.id)
      return res.status(403).json({ error: 'Tidak boleh akses kartu siswa lain.' });

    if (req.user.role === 'parent') {
      const linkCheck = await db.query(
        `SELECT 1 FROM parent_children
         WHERE parent_id = $1 AND student_id = $2`,
        [req.user.id, student.id]
      );
      if (linkCheck.rowCount === 0)
        return res.status(403).json({ error: 'Siswa ini bukan anak Anda.' });
    }

    const html = buildCardHtml(student);
    const pdf  = await generatePdf(html);

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `inline; filename="kartu-cadas-${student.display_id}.pdf"`,
      'Content-Length':      pdf.length,
      'Cache-Control':       'no-cache',
    });
    return res.end(pdf);
  } catch (err) {
    console.error('[card/student]', err);
    return res.status(500).json({ error: err.message || 'Server error.' });
  }
});


module.exports = router;
