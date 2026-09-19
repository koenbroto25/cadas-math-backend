/**
 * Middleware & helper JWT.
 *
 * Role yang diakui: 'student' | 'parent' | 'teacher' | 'admin' | 'demo'
 * Token dibuat saat login/register (lihat routes/auth.js).
 *
 * FIX P0-1 (2026-09-18): requireAuth sekarang verifikasi token sendiri
 * (bukan cuma cek req.auth), sehingga route yg memakai requireAuth SAJA
 * tetap aman. Mendukung ?token= untuk GET /api/card/* (download PDF dari
 * WebView/Linking yg tak bisa set header Authorization).
 */
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  // Fail-fast di production agar token tidak ditandatangani dgn secret dev.
  throw new Error('JWT_SECRET wajib diisi di production (.env).');
}
const TOKEN_TTL = '30d';

function signToken(payload, ttl) {
  return jwt.sign(payload, SECRET, { expiresIn: ttl || TOKEN_TTL });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const queryToken = (req.allowQueryToken && typeof req.query?.token === 'string')
    ? req.query.token
    : null;
  const token = header.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) return res.status(401).json({ error: 'token tidak ada' });
  try {
    req.auth = jwt.verify(token, SECRET);
    // Unifikasi: req.user selalu mirror req.auth agar route lama/baru cocok.
    req.user = req.auth;
    next();
  } catch {
    return res.status(401).json({ error: 'token tidak valid / kedaluwarsa' });
  }
}

// Gate per role: requireRole('parent') → token harus punya role 'parent'
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return res.status(403).json({ error: `akses hanya untuk role: ${roles.join(', ')}` });
    }
    next();
  };
}

// requireAuth: verifikasi token (verifyToken) lalu mapping req.auth → req.user.
// FIX P0-1: sekarang verifikasi sendiri — route cukup pakai requireAuth saja.
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const queryToken = (req.allowQueryToken && typeof req.query?.token === 'string')
    ? req.query.token
    : null;
  const token = header.startsWith('Bearer ') ? header.slice(7) : queryToken;
  if (!token) {
    return res.status(401).json({ error: 'token tidak ada atau tidak valid' });
  }
  try {
    req.auth = jwt.verify(token, SECRET);
    req.user = req.auth;
    next();
  } catch {
    return res.status(401).json({ error: 'token tidak ada atau tidak valid' });
  }
}

// requireParent: role harus 'parent' (asumsi token sudah diverifikasi via
// requireAuth/verifyToken yg jalan lebih dulu dalam chain).
function requireParent(req, res, next) {
  if (!req.auth || req.auth.role !== 'parent') {
    return res.status(403).json({ error: 'akses hanya untuk role parent' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireRole, requireAuth, requireParent };
