'use strict';

/**
 * query-processor.js
 * Proses raw query siswa → terstruktur (tokens, stems, operator, intent).
 * Menggunakan enriched synonyms dari corpus-vocab-builder.js.
 *
 * initQueryProcessor() WAJIB dipanggil saat startup sebelum processQuery() dipakai.
 * Jika belum init, tetap berfungsi dengan base synonym map (graceful degradation).
 */

const { OP_SYNONYMS } = require('./id-math-synonyms');
const { extractWordProblem, isWordProblem } = require('./soal-cerita');

// Coba load sastrawijs — graceful fallback
// (sastrawijs@1.1.0 export: { Stemmer, Tokenizer }; dukung juga alias lama StemmerID)
let _stemmerInstance = null;
try {
  const _sastrawi = require('sastrawijs');
  const StemmerCls = _sastrawi.Stemmer || _sastrawi.StemmerID;
  if (StemmerCls) _stemmerInstance = new StemmerCls();
  else console.warn('[QueryProcessor] sastrawijs tanpa export Stemmer — stem dinonaktifkan');
} catch {
  console.warn('[QueryProcessor] sastrawijs tidak tersedia — stem dinonaktifkan');
}

// Coba load stopword — graceful fallback.
// stopword@3.x export list Indonesia sebagai `sw.ind` (bukan `sw.id`).
// PROTECTED_WORDS: kata bermakna operasi/intent yang WAJIB dipertahankan
// walau ada di daftar stopword (berapa=intent answer, tambah/kurang/jumlah/
// bagi/tiap/setiap/cara/sama=operator & intent trick/explain).
let removeStopwords = null;
let idStopwords     = null;
try {
  const sw = require('stopword');
  removeStopwords = sw.removeStopwords;
  const rawList = sw.ind || sw.id || [];
const PROTECTED_WORDS = new Set([
    'berapa', 'hitung', 'hasil', 'jumlah', 'total',
    'tambah', 'kurang', 'kali', 'bagi', 'sisa',
    'diberikan', 'dimakan', 'diambil', 'mendapat', 'memberi',
    'tiap', 'setiap', 'sama',
    'cara', 'bagaimana', 'jelaskan', 'trik', 'cepat', 'rumus',
  ]);
  idStopwords = rawList.filter(w => !PROTECTED_WORDS.has(w));
  console.log(`[QueryProcessor] stopword aktif: ${rawList.length} kata ID, ${idStopwords.length} dipakai (${rawList.length - idStopwords.length} kata operasi diproteksi)`);
} catch {
  // Fallback: tidak hapus stopword
  removeStopwords = (tokens) => tokens;
  idStopwords     = [];
}

// State runtime — diisi via initQueryProcessor()
let _enriched = null;

/**
 * initQueryProcessor(enrichedSynonyms)
 * Dipanggil SEKALI saat server start, setelah buildEnrichedSynonyms() selesai.
 * @param {object} enrichedSynonyms - return value dari buildEnrichedSynonyms()
 */
function initQueryProcessor(enrichedSynonyms) {
  _enriched = enrichedSynonyms;
  console.log('[QueryProcessor] Initialized dengan enriched synonyms dari DB');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function stemSafe(word) {
  if (!_stemmerInstance) return word;
  try { return _stemmerInstance.stem(word); } catch { return word; }
}

/**
 * detectOperator(stems) → string | null
 * Cek enriched map dulu, fallback ke base OP_SYNONYMS.
 * Prioritas: hitung skor per operator dari SEMUA token (bukan first-match),
 * dengan bobot: verba operasi spesifik (+2) > kata umum (+1).
 * Ini mencegah kata umum "membeli/beli" mengalahkan sinyal spesifik
 * "dimakan/sisa/tiap/berisi" dalam soal cerita.
 * Pengecualian: kata distributif tiap/setiap/masing-masing/berisi/isi
 * TIDAK dihitung di sini — mereka ambigu (/ vs *) dan diputuskan oleh
 * soal-cerita.js via kata kerja bagi. Tanpa ini, "tiap kantong berisi"
 * kalah skor dari "membeli".
 */
const OP_SPECIFIC_WEIGHT = new Set([
  'sisa', 'sisanya', 'tersisa', 'tinggal', 'dimakan', 'diberikan', 'diberi',
  'hilang', 'habis', 'mendapat', 'memberi', 'beri',
  'diambil', 'dipakai', 'digunakan', 'selisih', 'kurang', 'dikurang',
  'dibagi', 'membagi', 'membagikan', 'dibagikan', 'bagi',
  'dikali', 'berlipat', 'lipat', 'sebanyak',
  'total', 'jumlah', 'tambah', 'ditambah',
]);
const OP_DISTRIBUTIVE_SKIP = new Set([
  'tiap', 'setiap', 'masing', 'berisi', 'isi', 'per',
]);
function detectOperator(stems) {
  const opMap = _enriched ? _enriched.opSynonyms : new Map(Object.entries(OP_SYNONYMS));
  const scores = {};
  for (const stem of stems) {
    if (OP_DISTRIBUTIVE_SKIP.has(stem)) continue;
    const op = opMap.get(stem);
    if (!op || op === 'frac') continue;
    scores[op] = (scores[op] || 0) + (OP_SPECIFIC_WEIGHT.has(stem) ? 2 : 1);
  }
  let best = null, bestScore = 0;
  for (const [op, s] of Object.entries(scores)) {
    if (s > bestScore) { bestScore = s; best = op; }
  }
  // Fallback: jika semua token di-skip (mis. query hanya "tiap ... berisi ..."),
  // kembalikan '*' — pola distributif default perkalian.
  if (!best && stems.some(s => OP_DISTRIBUTIVE_SKIP.has(s))) return '*';
  // Disambiguasi distributif: pola "tiap/berisi" TANPA kata kerja bagi
  // (bagi/dibagi/membagikan/sama rata) adalah perkalian — samakan dengan
  // putusan soal-cerita.js agar QP dan validator konsisten.
  const hasDistrib = stems.some(s => OP_DISTRIBUTIVE_SKIP.has(s));
  const hasBagiVerb = stems.some(s => ['bagi', 'dibagi', 'dibagikan', 'membagi', 'membagikan', 'rata'].includes(s));
  if (hasDistrib && !hasBagiVerb) return '*';
  return best;
}

/**
 * hasPropNoun(tokens) → boolean
 * Apakah query mengandung nama orang dari enriched set.
 */
function hasPropNoun(tokens) {
  if (!_enriched) return false;
  return tokens.some(t => _enriched.namaOrang.has(t.toLowerCase()));
}

/**
 * hasObjectNoun(tokens) → boolean
 * Apakah query mengandung kata benda konteks soal dari enriched set.
 */
function hasObjectNoun(tokens) {
  if (!_enriched) return false;
  return tokens.some(t => _enriched.bendaUmum.has(t.toLowerCase()));
}

// ── Intent detection ──────────────────────────────────────────────────────────

const INTENT_MAP = {
  // Answer intent
  berapa: 'answer', hitung: 'answer', temukan: 'answer', cari: 'answer',
  tentukan: 'answer', nyatakan: 'answer', hasilkan: 'answer',
  // Explain intent
  bagaimana: 'explain', jelaskan: 'explain', uraikan: 'explain',
  caranya: 'explain', langkah: 'explain', cara: 'explain',
  // Define intent
  apa: 'define', apakah: 'define', definisi: 'define', artinya: 'define',
  // Trick intent
  trik: 'trick', cepat: 'trick', rumus: 'trick', jalan: 'trick',
};

// ── Main ──────────────────────────────────────────────────────────────────────

/**
 * processQuery(rawText, level) → ProcessedQuery | null
 *
 * @returns {{
 *   original: string,
 *   normalized: string,
 *   tokens: string[],
 *   stems: string[],
 *   expanded: string[],
 *   operator: string|null,
 *   numbers: number[],
 *   intent: string,
 *   isWordProblem: boolean,
 *   levelHint: number,
 * }}
 */
function processQuery(rawText, level = 1) {
  if (!rawText) return null;

  const normalized = rawText
    .toLowerCase()
    .replace(/[""''«»]/g, '"')
    .replace(/[^\w\s\d,.?!%:/×÷+\-*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(/\s+/).filter(Boolean);
  const noStop = removeStopwords(tokens, idStopwords);

  // Stem + bentuk asli (bersih punctuation). Stemmer agresif kadang
  // menghilangkan kata operasi (sebanyak→banyak), jadi kedua bentuk dicek.
  const clean = t => t.toLowerCase().replace(/[^a-z0-9]/g, '');
  const stems = noStop
    .flatMap(t => {
      const c = clean(t);
      const s = stemSafe(c);
      return c === s ? [s] : [s, c];
    })
    .filter(s => s.length >= 2);

  // Expand stems dengan operator mapping (untuk lexical search enrichment)
  const expanded = new Set(stems);
  const opMap    = _enriched ? _enriched.opSynonyms : new Map(Object.entries(OP_SYNONYMS));
  for (const stem of stems) {
    const op = opMap.get(stem);
    if (op) expanded.add(op);
  }

  // Cek juga token asli (sebelum stem) untuk operator
  let operator = detectOperator(stems) || detectOperator(tokens.map(stemSafe));
  if (!operator) {
    try {
      const wp = extractWordProblem(rawText);
      if (wp && wp.found && wp.op) {
        operator = wp.op;
      }
    } catch { /* ignore */ }
  }

  const numbers = (normalized.match(/\b\d[\d.,]*\b/g) || [])
    .map(s => parseFloat(s.replace(/\./g, '').replace(',', '.')))
    .filter(n => !isNaN(n) && isFinite(n));

  // Intent detection — cek stems dan tokens asli
  let intent = 'unknown';
  for (const stem of [...stems, ...tokens]) {
    if (INTENT_MAP[stem]) { intent = INTENT_MAP[stem]; break; }
  }
  // Fallback intent: kalau ada angka → answer
  if (intent === 'unknown' && numbers.length > 0) intent = 'answer';

  const isWP = isWordProblem(rawText) || hasPropNoun(tokens) || hasObjectNoun(tokens);

  return {
    original:      rawText,
    normalized,
    tokens,
    stems,
    expanded:      [...expanded],
    operator,
    numbers,
    intent,
    isWordProblem: isWP,
    levelHint:     level,
  };
}

module.exports = { processQuery, initQueryProcessor };
