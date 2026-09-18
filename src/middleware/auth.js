/**
 * Middleware & helper JWT.
 *
 * Role yang diakui: 'student' | 'parent' | 'teacher'
 * Token dibuat saat login/register (lihat routes/auth.js).
 */
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'cadas_app_secure_secret_key_2026';
const TOKEN_TTL = '30d';

function signToken(payload, ttl) {
  return jwt.sign(payload, SECRET, { expiresIn: ttl || TOKEN_TTL });
}

function verifyToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'token tidak ada' });
  try {
    req.auth = jwt.verify(token, SECRET);
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

// requireAuth: verifikasi token (via verifyToken sudah jalan), mapping req.auth → req.user
function requireAuth(req, res, next) {
  if (!req.auth) {
    return res.status(401).json({ error: 'token tidak ada atau tidak valid' });
  }
  req.user = req.auth;
  next();
}

// requireParent: role harus 'parent'
function requireParent(req, res, next) {
  if (!req.auth || req.auth.role !== 'parent') {
    return res.status(403).json({ error: 'akses hanya untuk role parent' });
  }
  next();
}

module.exports = { signToken, verifyToken, requireRole, requireAuth, requireParent };
