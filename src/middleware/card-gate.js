/**
 * card-gate.js — Gate "Kartu ID wajib sebelum latihan" (A1 / OQ-3 FINAL).
 *
 * Keputusan produk (Placement_Test_System.md §7 OQ-3, opsi A):
 *   Siswa WAJIB membagikan / mengunduh kartu ID (minimal 1 aksi) sebelum
 *   masuk latihan. Ini gerbang akses orang tua — tanpa kartu, ortu tidak
 *   pernah tahu ID anak & tidak bisa memantau / membayar.
 *
 * Sumber kebenaran: kolom `students.card_shared` (+ `card_shared_at`), di-set
 * lewat PATCH /api/auth/student/card-shared (PlacementCardModal / Settings).
 *
 * Aturan:
 *   - Hanya berlaku untuk siswa yang dibuat SETELAH cutover (default
 *     2026-09-24T00:00:00Z = tanggal fitur rilis). Siswa lama (legacy)
 *     tidak dikunci mendadak — mereka tetap dapat banner ajakan, bukan blokir.
 *   - Fail-open: kalau DB error, gate TIDAK memblokir (jangan sampai siswa
 *     tidak bisa latihan karena hiccup query).
 *
 * Kill-switch / pengecualian (env):
 *   CARD_GATE_DISABLED=1              → matikan gate sepenuhnya.
 *   CARD_GATE_SINCE=2026-10-01T00:00:00Z  → geser tanggal cutover.
 *   CARD_GATE_EXEMPT_IDS=uuid,uuid    → daftar students.id yang dikecualikan
 *                                       (akun demo/QA/staf).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_SINCE = '2026-09-24T00:00:00Z';

function isDisabled() {
  const v = String(process.env.CARD_GATE_DISABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function cutoverDate() {
  const raw = process.env.CARD_GATE_SINCE || DEFAULT_SINCE;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? new Date(DEFAULT_SINCE) : d;
}

function exemptSet() {
  return new Set(
    String(process.env.CARD_GATE_EXEMPT_IDS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

/**
 * Hitung status gate untuk seorang siswa.
 *
 * @returns {Promise<{required:boolean, card_shared:boolean|null, reason:string}>}
 *   reason: disabled | no_student | invalid_student | exempt | not_found
 *           | legacy | shared | required | error
 */
async function getCardGate(db, studentId) {
  if (isDisabled()) {
    return { required: false, card_shared: null, reason: 'disabled' };
  }
  if (!studentId) {
    return { required: false, card_shared: null, reason: 'no_student' };
  }
  if (!UUID_RE.test(String(studentId))) {
    // ID non-UUID (mis. kode lama) → tidak bisa dicek, jangan blokir.
    return { required: false, card_shared: null, reason: 'invalid_student' };
  }
  if (exemptSet().has(String(studentId).toLowerCase())) {
    return { required: false, card_shared: null, reason: 'exempt' };
  }

  try {
    const r = await db.query(
      'SELECT card_shared, created_at FROM students WHERE id = $1',
      [studentId]
    );
    if (r.rowCount === 0) {
      return { required: false, card_shared: null, reason: 'not_found' };
    }
    const { card_shared: shared, created_at: createdAt } = r.rows[0];
    const sharedBool = shared === true;

    // Legacy (dibuat sebelum cutover) tidak dikunci.
    if (createdAt && new Date(createdAt) < cutoverDate()) {
      return { required: false, card_shared: sharedBool, reason: 'legacy' };
    }
    if (sharedBool) {
      return { required: false, card_shared: true, reason: 'shared' };
    }
    return { required: true, card_shared: false, reason: 'required' };
  } catch (e) {
    console.warn('[card-gate] getCardGate error (fail-open):', e.message);
    return { required: false, card_shared: null, reason: 'error' };
  }
}

/** Payload 403 standar supaya frontend bisa mengenali gate ini. */
function cardGateBlockBody() {
  return {
    error: 'CARD_NOT_SHARED',
    message: 'Bagikan / unduh Kartu ID dulu sebelum latihan — orang tua perlu ID ini untuk memantau.',
    next: 'share_id_card',
    card_shared: false,
  };
}

module.exports = { getCardGate, cardGateBlockBody, cutoverDate, isDisabled };
