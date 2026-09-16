/**
 * math-validator.js — Post-LLM Math Verifier (Sprint K)
 *
 * Tugasnya: setelah LLM menjawab, ekstrak soal matematika dari konteks,
 * hitung jawaban yang benar, lalu bandingkan dengan angka di jawaban LLM.
 * Kalau salah → koreksi otomatis atau flag.
 *
 * Dependensi: mathjs (npm install mathjs)
 * Tidak ada network call — 100% offline, deterministik.
 */

const { evaluate, fraction, format, number } = require('mathjs');

// ─── Konfigurasi ────────────────────────────────────────────────────────────

// Toleransi untuk perbandingan float (misal: 0.333 vs 0.3333...)
const FLOAT_TOLERANCE = 0.01;

// Pattern soal matematika SD yang bisa dihitung otomatis
// Urutan: dari yang paling spesifik ke paling umum
const MATH_PATTERNS = [
  // "24 dibagi 6", "24 / 6", "24:6"
  { pattern: /(\d+[\d.,]*)\s*(?:dibagi|:|\÷|\/)\s*(\d+[\d.,]*)/i,    op: '/' },
  // "6 dikali 7", "6 x 7", "6 × 7", "6 * 7"
  { pattern: /(\d+[\d.,]*)\s*(?:dikali|x|×|\*)\s*(\d+[\d.,]*)/i,     op: '*' },
  // "15 ditambah 27", "15 + 27"
  { pattern: /(\d+[\d.,]*)\s*(?:ditambah|\+)\s*(\d+[\d.,]*)/i,        op: '+' },
  // "50 dikurang 18", "50 - 18"
  { pattern: /(\d+[\d.,]*)\s*(?:dikurang(?:i)?|\-)\s*(\d+[\d.,]*)/i, op: '-' },
  // "25% dari 80"
  { pattern: /(\d+[\d.,]*)\s*%\s*dari\s*(\d+[\d.,]*)/i,              op: 'pct' },
  // ekspresi langsung: "2 + 3 × 4", "(10 + 5) / 3"
  { pattern: /^[\d\s\+\-\*\/\(\)\.\,×÷\^]+$/, op: 'expr' },
];

// ─── Utilitas ────────────────────────────────────────────────────────────────

/**
 * Bersihkan string angka Indonesia → number JS.
 * "1.200" → 1200, "3,14" → 3.14
 */
function parseIndonesianNumber(str) {
  if (!str) return NaN;
  const s = String(str).trim();
  // Kalau ada titik ribuan (1.200.000) atau koma desimal (3,14)
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) {
    // Format ribuan: 1.200 → 1200
    return parseFloat(s.replace(/\./g, '').replace(',', '.'));
  }
  if (/^\d+(,\d+)?$/.test(s)) {
    // Koma desimal: 3,14 → 3.14
    return parseFloat(s.replace(',', '.'));
  }
  return parseFloat(s);
}

/**
 * Format angka hasil kalkulasi untuk ditampilkan.
 * Bilangan bulat → tanpa desimal. Desimal → max 4 digit.
 */
function formatResult(val) {
  if (typeof val !== 'number' || !isFinite(val)) return String(val);
  if (Number.isInteger(val)) return String(val);
  // Coba bulatkan ke 2 desimal — kalau sama, tampilkan 2 desimal
  const r2 = Math.round(val * 100) / 100;
  return r2 === val ? r2.toFixed(2) : val.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * Hitung ekspresi matematika dengan mathjs.
 * Return { result: number|null, error: string|null }
 */
function calcExpression(expr) {
  try {
    // Normalize: ganti × → *, ÷ → /, koma desimal → titik
    const normalized = expr
      .replace(/×/g, '*')
      .replace(/÷/g, '/')
      .replace(/,(\d)/g, '.$1'); // "3,14" → "3.14"
    const result = evaluate(normalized);
    if (typeof result === 'number' && isFinite(result)) {
      return { result, error: null };
    }
    // mathjs bisa return Fraction, BigNumber, dll
    return { result: number(result), error: null };
  } catch (e) {
    return { result: null, error: e.message };
  }
}

// ─── Fungsi Utama ────────────────────────────────────────────────────────────

/**
 * Ekstrak soal matematika dari teks pertanyaan/konteks.
 * Return: { found: bool, expr: string, correct: number|null, op: string }
 */
function extractMathFromQuestion(questionText) {
  if (!questionText) return { found: false };
  const text = questionText.trim();

  for (const { pattern, op } of MATH_PATTERNS) {
    const m = text.match(pattern);
    if (!m) continue;

    if (op === 'expr') {
      // Ekspresi langsung
      const { result, error } = calcExpression(text);
      if (error) continue;
      return { found: true, expr: text, correct: result, op };
    }

    if (op === 'pct') {
      // "25% dari 80" → 80 * 25 / 100
      const pct  = parseIndonesianNumber(m[1]);
      const base = parseIndonesianNumber(m[2]);
      if (isNaN(pct) || isNaN(base)) continue;
      return { found: true, expr: `${pct}% dari ${base}`, correct: base * pct / 100, op };
    }

    // Operasi 2 operand
    const a = parseIndonesianNumber(m[1]);
    const b = parseIndonesianNumber(m[2]);
    if (isNaN(a) || isNaN(b)) continue;

    const exprStr = `${a} ${op} ${b}`;
    const { result, error } = calcExpression(exprStr);
    if (error || result === null) continue;

    return { found: true, expr: exprStr, correct: result, op };
  }

  return { found: false };
}

/**
 * Ekstrak semua angka dari teks jawaban LLM.
 * Return: number[]
 */
function extractNumbersFromText(text) {
  if (!text) return [];
  // Match: angka dengan opsional titik ribuan / koma desimal
  const matches = text.match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\b|\b\d+(?:[.,]\d+)?\b/g) || [];
  return matches
    .map(parseIndonesianNumber)
    .filter(n => !isNaN(n) && isFinite(n));
}

/**
 * Bandingkan jawaban LLM dengan hasil kalkulasi benar.
 * Return: { correct: bool, found: bool, llmAnswer: number|null, correctAnswer: number }
 */
function compareAnswers(llmNumbers, correctAnswer) {
  if (llmNumbers.length === 0) return { correct: false, found: false, llmAnswer: null, correctAnswer };

  // Cari angka LLM yang paling dekat dengan jawaban benar
  let closest = null, minDist = Infinity;
  for (const n of llmNumbers) {
    const dist = Math.abs(n - correctAnswer);
    if (dist < minDist) { minDist = dist; closest = n; }
  }

  // Toleransi: untuk bilangan bulat toleransi 0, untuk float 1%
  const isInt = Number.isInteger(correctAnswer);
  const tol   = isInt ? 0 : Math.abs(correctAnswer) * FLOAT_TOLERANCE;
  const correct = minDist <= tol;

  return { correct, found: true, llmAnswer: closest, correctAnswer };
}

/**
 * FUNGSI UTAMA — dipanggil dari pipeline.js setelah LLM menjawab.
 *
 * @param {string} llmText      - teks jawaban dari LLM
 * @param {string} questionText - pertanyaan siswa (untuk ekstrak soal)
 * @param {string} [exerciseText] - teks soal asli dari DB (opsional, lebih presisi)
 * @returns {object} validationResult
 */
function validateMathAnswer(llmText, questionText, exerciseText = '') {
  // Coba ekstrak soal dari exerciseText dulu (lebih akurat), fallback ke questionText
  let mathInfo = extractMathFromQuestion(exerciseText);
  if (!mathInfo.found) mathInfo = extractMathFromQuestion(questionText);

  // Kalau tidak ada soal matematika yang bisa dihitung → skip validasi
  if (!mathInfo.found || mathInfo.correct === null) {
    return {
      validated: false,
      reason:    'no_computable_math_found',
      llmText,
    };
  }

  const llmNumbers = extractNumbersFromText(llmText);
  const cmp        = compareAnswers(llmNumbers, mathInfo.correct);

  if (!cmp.found) {
    // LLM tidak menyebut angka sama sekali — mungkin penjelasan konseptual, OK
    return {
      validated:     true,
      hasNumbers:    false,
      correct:       null,
      correctAnswer: formatResult(mathInfo.correct),
      expr:          mathInfo.expr,
      llmText,
    };
  }

  if (cmp.correct) {
    // ✅ LLM benar
    return {
      validated:     true,
      hasNumbers:    true,
      correct:       true,
      correctAnswer: formatResult(mathInfo.correct),
      llmAnswer:     formatResult(cmp.llmAnswer),
      expr:          mathInfo.expr,
      llmText,
    };
  }

  // ❌ LLM salah — koreksi teks
  const correctStr = formatResult(mathInfo.correct);
  const wrongStr   = formatResult(cmp.llmAnswer);

  // Sisipkan koreksi di akhir teks LLM
  const correctedText = llmText.trimEnd() +
    `\n\n⚠️ Koreksi: jawaban yang benar untuk ${mathInfo.expr} adalah **${correctStr}**, bukan ${wrongStr}.`;

  console.warn(`[MathValidator] LLM salah: ${mathInfo.expr} = ${mathInfo.correct}, LLM bilang ${cmp.llmAnswer}`);

  return {
    validated:     true,
    hasNumbers:    true,
    correct:       false,
    correctAnswer: correctStr,
    llmAnswer:     wrongStr,
    expr:          mathInfo.expr,
    llmText:       correctedText,  // ← teks yang sudah dikoreksi
    originalText:  llmText,
  };
}

// ─── Integrasi soal-cerita.js (Layer B) ──────────────────────────────────────

// _enrichedOps di-set saat startup via setEnrichedOps()
let _enrichedOpsForValidator = null;

/**
 * setEnrichedOps(enrichedOps)
 * Dipanggil dari startup sequence setelah buildEnrichedSynonyms() selesai.
 * @param {Map} enrichedOps
 */
function setEnrichedOps(enrichedOps) {
  _enrichedOpsForValidator = enrichedOps;
}

/**
 * validateWithWordProblem(llmText, questionText, exerciseText)
 *
 * Validasi 3 layer:
 *   Layer A — extractWordProblem() regex (confidence 0.95/0.85)
 *   Layer B — extractWordProblemWithStemFallback() (confidence 0.70)
 *   Layer C — jika keduanya gagal → skip validasi, biarkan LLM
 *
 * Threshold koreksi:
 *   confidence ≥ 0.80 → koreksi teks otomatis
 *   confidence 0.70–0.79 → log saja, tidak koreksi
 *   confidence < 0.70 → skip
 *
 * @param {string} llmText - jawaban dari LLM
 * @param {string} questionText - pertanyaan siswa
 * @param {string} [exerciseText] - teks soal dari DB (lebih presisi jika ada)
 * @returns {object} validationResult
 */
function validateWithWordProblem(llmText, questionText, exerciseText = '') {
  const { extractWordProblem, extractWordProblemWithStemFallback } = require('./soal-cerita');
  const source = exerciseText || questionText;

  // Layer A: regex pattern
  let wp = extractWordProblem(source);

  // Layer B: stem fallback (jika Layer A gagal)
  if (!wp.found && _enrichedOpsForValidator) {
    wp = extractWordProblemWithStemFallback(source, _enrichedOpsForValidator);
  }

  // Layer C: keduanya gagal → skip validasi
  if (!wp.found || wp.answer === null) {
    return { validated: false, reason: 'no_math_detected_all_layers', llmText };
  }

  const willCorrect = (wp.confidence || 0) >= 0.80;
  const llmNumbers  = extractNumbersFromText(llmText);
  const cmp         = compareAnswers(llmNumbers, wp.answer);

  if (!cmp.found) {
    return {
      validated: true, hasNumbers: false, correct: null,
      correctAnswer: formatResult(wp.answer), expr: wp.expr,
      confidence: wp.confidence, tier: wp.tier, llmText,
    };
  }

  if (cmp.correct) {
    return {
      validated: true, hasNumbers: true, correct: true,
      correctAnswer: formatResult(wp.answer), llmAnswer: formatResult(cmp.llmAnswer),
      expr: wp.expr, confidence: wp.confidence, tier: wp.tier, llmText,
    };
  }

  // LLM salah
  if (!willCorrect) {
    // confidence 0.70 (Layer B) → log saja, jangan koreksi otomatis
    console.warn(
      `[MathValidator] Kemungkinan salah (confidence ${wp.confidence}, tier ${wp.tier}):`,
      `${wp.expr} = ${wp.answer}, LLM: ${cmp.llmAnswer} — tidak dikoreksi`
    );
    return {
      validated: true, hasNumbers: true, correct: null,
      correctAnswer: formatResult(wp.answer), llmAnswer: formatResult(cmp.llmAnswer),
      expr: wp.expr, confidence: wp.confidence, tier: wp.tier,
      note: 'low_confidence_no_correction', llmText,
    };
  }

  // confidence ≥ 0.80 → koreksi teks
  const correctStr = formatResult(wp.answer);
  const wrongStr   = formatResult(cmp.llmAnswer);
  const corrected  = llmText.trimEnd() +
    `\n\n⚠️ Koreksi: jawaban yang benar untuk ${wp.expr} adalah **${correctStr}**, bukan ${wrongStr}.`;

  console.warn(
    `[MathValidator] Koreksi (confidence ${wp.confidence}, tier ${wp.tier}):`,
    `${wp.expr} = ${wp.answer}, LLM bilang ${cmp.llmAnswer}`
  );

  return {
    validated: true, hasNumbers: true, correct: false,
    correctAnswer: correctStr, llmAnswer: wrongStr,
    expr: wp.expr, confidence: wp.confidence, tier: wp.tier,
    llmText: corrected, originalText: llmText,
  };
}

module.exports = {
  validateMathAnswer,
  extractMathFromQuestion,
  extractNumbersFromText,
  compareAnswers,
  calcExpression,
  setEnrichedOps,
  validateWithWordProblem,
};
