/**
 * utils/studentId.js — Student ID generation & normalization
 *
 * Format: 4 karakter, 32 char set (ABCDEFGHJKLMNPQRSTUVWXYZ23456789)
 *   - Tanpa O (mirip 0), I (mirip 1), 0, 1
 *   - Total variasi: 32⁴ = 1.048.576
 *   - Contoh: B7KM, X2PN, R4TW
 *
 * Phone normalization: Indonesian mobile format
 *   - 08xx → +628xx
 *   - 62xxx → +62xxx (tanpa +)
 *   - +62xxx → +62xxx (sudah benar)
 */

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 karakter

/**
 * Generate ID acak 4 karakter (tidak dijamin unik — cek DB separately).
 * @returns {string} 4-char display_id
 */
function generateRawId() {
  let id = '';
  for (let i = 0; i < 4; i++) {
    id += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return id;
}

/**
 * Generate ID unik dengan callback pengecekan ke DB.
 * @param {Function} checkExists — async(id) => boolean, true jika ID sudah ada di DB
 * @param {number} maxAttempts — maksimal percobaan (default 20)
 * @returns {Promise<string>} unique display_id
 */
async function generateDisplayId(checkExists, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const id = generateRawId();
    const exists = await checkExists(id);
    if (!exists) return id;
  }
  // Fallback: jitter berbasis timestamp jika terlalu banyak collision
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return ts.padEnd(4, CHARS[0]);
}

/**
 * Normalisasi display_id: uppercase, trim, validasi 4 karakter dari 32-char set.
 * @param {string} raw
 * @returns {string|null} normalized ID atau null jika tidak valid
 */
function normalizeDisplayId(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const id = raw.trim().toUpperCase();
  if (id.length !== 4) return null;
  for (const c of id) {
    if (!CHARS.includes(c)) return null;
  }
  return id;
}

/**
 * Normalisasi nomor HP Indonesia.
 *   - 081234567890 → +6281234567890
 *   - 6281234567890 → +6281234567890
 *   - +6281234567890 → +6281234567890 (sudah benar)
 *   - 0812-3456-7890 → +6281234567890
 * @param {string} raw
 * @returns {string|null} normalized phone atau null jika tidak valid
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.trim();
  if (!p) return null;

  // Hapus semua karakter non-digit kecuali +
  p = p.replace(/[^\d+]/g, '');

  // Hapus leading + sementara
  let plus = p.startsWith('+');
  let digits = plus ? p.slice(1) : p;

  // Jika diawali 0 → ganti dengan 62
  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  }

  // Jika diawali 8 (tanpa 62 di depan) → tambahkan 62
  // Tapi jika sudah 62xxx → biarkan
  if (!digits.startsWith('62') && digits.startsWith('8')) {
    digits = '62' + digits;
  }

  // Jika diawali angka selain 62 atau 8 → tidak valid
  if (!digits.startsWith('62')) return null;

  // Minimal 9 angka total (62 + 7 digit nomor)
  if (digits.length < 9) return null;

  return '+' + digits;
}

module.exports = { generateDisplayId, normalizeDisplayId, normalizePhone };