'use strict';

/**
 * soal-cerita.js — Ekstrak dan deteksi operasi matematika dari soal cerita.
 *
 * Layer A: Regex pattern matching (primary, confidence 0.85–0.95)
 * Layer B: Sastrawijs stem fallback (secondary, confidence 0.70)
 *
 * init() dipanggil saat startup setelah buildEnrichedSynonyms() selesai.
 */

const { OP_SYNONYMS } = require('./id-math-synonyms');

// State runtime — diisi via init()
let _enrichedOps = null;
let _stemmer     = null;

// Coba load sastrawijs untuk Layer B
try {
  const _sastrawi = require('sastrawijs');
  const StemmerCls = _sastrawi.Stemmer || _sastrawi.StemmerID;
  if (StemmerCls) _stemmer = new StemmerCls();
  else console.warn('[SoalCerita] sastrawijs tanpa export Stemmer — Layer B stem fallback dinonaktifkan');
} catch {
  console.warn('[SoalCerita] sastrawijs tidak tersedia — Layer B stem fallback dinonaktifkan');
}

/**
 * init(enrichedOps, stemmer)
 * Inject enriched ops dan stemmer dari startup.
 */
function init(enrichedOps, stemmer) {
  _enrichedOps = enrichedOps;
  if (stemmer) _stemmer = stemmer;
}

// ── Fraction Detection Helpers ──────────────────────────────

const FRAC_KEYWORDS_RE = /(setengah|setengahnya|seperempat|seperempatnya|sepertiga|sepertiganya|persen|persenya|bagian|bagiannya|dari|pecahan|desimal)/gi;

function detectFractionKeywords(text) {
  const results = [];
  FRAC_KEYWORDS_RE.lastIndex = 0;
  let m;
  while ((m = FRAC_KEYWORDS_RE.exec(text)) !== null) {
    results.push({ keyword: m[0], index: m.index, end: m.index + m[0].length });
  }
  return results;
}

function isFractionContext(text, start, end, radius = 40) {
  const ctx = text.slice(Math.max(0, start - radius), Math.min(text.length, end + radius));
  return /(?:setengah|setengahnya|seperempat|seperempatnya|sepertiga|sepertiganya|persen|persenya|bagian|bagiannya|dari|pecahan|desimal)/i.test(ctx);
}

function extractFractionParts(fracStr) {
  const simple = fracStr.match(/^(\d+)\/(\d+)$/);
  if (simple) return { numerator: parseInt(simple[1]), denominator: parseInt(simple[2]) };
  const mixed = fracStr.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixed) return { wholes: parseInt(mixed[1]), numerator: parseInt(mixed[2]), denominator: parseInt(mixed[3]) };
  return null;
}

function fractionValue({ numerator, denominator, wholes = 0 }) {
  if (denominator === 0) return null;
  return wholes + numerator / denominator;
}

function gcd(a, b) {
  a = Math.abs(Math.round(a));
  b = Math.abs(Math.round(b));
  while (b !== 0) { const t = b; b = a % b; a = t; }
  return a || 1;
}

function simFraction(aNum, aDen, bNum, bDen, op) {
  switch (op) {
    case '+': return { n: aNum * bDen + bNum * aDen, d: aDen * bDen };
    case '-': return { n: aNum * bDen - bNum * aDen, d: aDen * bDen };
    case '*': return { n: aNum * bNum, d: aDen * bDen };
    case '/': return { n: aNum * bDen, d: aDen * bNum };
    default: return null;
  }
}

// ── Utilities ─────────────────────────────────────────────────

function extractNumbers(text) {
  const matches = text.match(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\b|\b\d+\b/g) || [];
  return matches
    .map(s => {
      if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))
        return parseFloat(s.replace(/\./g, '').replace(',', '.'));
      if (/^\d+(,\d+)?$/.test(s))
        return parseFloat(s.replace(',', '.'));
      return parseFloat(s);
    })
    .filter(n => !isNaN(n) && isFinite(n) && n >= 0);
}

function safeCalc(a, op, b) {
  try {
    if (op === '+') return a + b;
    if (op === '-') return a - b;
    if (op === '*') return a * b;
    if (op === '/' && b !== 0) return a / b;
  } catch { return null; }
  return null;
}

function isWordProblem(text) {
  return /[a-z]{3}/i.test(text) && /\d/.test(text);
}


// ── Layer A: Regex Pattern Matching (Fraction-Aware) ─────────

function extractWordProblem(text) {
  if (!text || !isWordProblem(text)) return { found: false };

  const fracKeywords = detectFractionKeywords(text);
  const hasAnyFracKeyword = fracKeywords.length > 0;

  // Fraction operation patterns (dua fraction + operator)
  const FRAC_OP_PATTERNS = [
    { re: /(\d+)\s*\/\s*(\d+)\s*(?:ditambah|\+)\s*(\d+)\s*\/\s*(\d+)/i, op: '+' },
    { re: /(\d+)\s*\/\s*(\d+)\s*(?:dikurang(?:i)?|-)\s*(\d+)\s*\/\s*(\d+)/i, op: '-' },
    { re: /(\d+)\s*\/\s*(\d+)\s*(?:dikali|×|x)\s*(\d+)\s*\/\s*(\d+)/i, op: '*' },
    { re: /(\d+)\s*\/\s*(\d+)\s*(?:dibagi|÷|\/)\s*(\d+)\s*\/\s*(\d+)/i, op: '/' },
  ];
  for (const { re, op } of FRAC_OP_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const aNum = parseInt(m[1]), aDen = parseInt(m[2]);
    const bNum = parseInt(m[3]), bDen = parseInt(m[4]);
    if (aDen === 0 || bDen === 0) continue;
    const simResult = simFraction(aNum, aDen, bNum, bDen, op);
    if (!simResult) continue;
    const g = gcd(simResult.n, simResult.d);
    const simplifiedN = simResult.n / g;
    const simplifiedD = simResult.d / g;
    const answer = simplifiedD === 1 ? simplifiedN : simplifiedN / simplifiedD;
    const expr = `${aNum}/${aDen} ${op} ${bNum}/${bDen}`;
    return { found: true, tier: 'frac_op', op, operands: [aNum / aDen, bNum / bDen], expr, answer: Math.round(answer * 10000) / 10000, confidence: 0.95 };
  }

  // Fraction × number: "2/6 dari 10"
  const fracMulMatch = text.match(/(\d+)\s*\/\s*(\d+)\s*(?:dari)\s*(\d+)/i);
  if (fracMulMatch) {
    const aNum = parseInt(fracMulMatch[1]), aDen = parseInt(fracMulMatch[2]);
    const num = parseInt(fracMulMatch[3]);
    if (aDen !== 0) {
      const answer = (aNum * num) / aDen;
      return { found: true, tier: 'frac_mul', op: '*', operands: [aNum / aDen, num], expr: `${aNum}/${aDen} * ${num}`, answer: Math.round(answer * 10000) / 10000, confidence: 0.95 };
    }
  }

  // "setengah dari 8"
  const keywordFracMatch = text.match(/(setengah|seperempat|sepertiga)\s*(?:dari)\s*(\d+)/i);
  if (keywordFracMatch) {
    const fracWords = { 'setengah': 0.5, 'seperempat': 0.25, 'sepertiga': 1/3 };
    const fracVal = fracWords[keywordFracMatch[1].toLowerCase()];
    const num = parseInt(keywordFracMatch[2]);
    return { found: true, tier: 'frac_mul', op: '*', operands: [fracVal, num], expr: `${keywordFracMatch[1]} * ${num}`, answer: Math.round(fracVal * num * 10000) / 10000, confidence: 0.95 };
  }

  // Tier 1: Ekspresi eksplisit dengan operator symbol/kata.
  const PATTERNS = [
    { re: /(\d+[\d.,]*)\s*(?:dibagi|÷|:)\s*(\d+[\d.,]*)/i,         op: '/' },
    { re: /(\d+[\d.,]*)\s*(?:dikali|×|x)\s*(\d+[\d.,]*)/i,          op: '*' },
    { re: /(\d+[\d.,]*)\s*(?:ditambah|\+)\s*(\d+[\d.,]*)/i,          op: '+' },
    { re: /(\d+[\d.,]*)\s*(?:dikurang(?:i)?|-)\s*(\d+[\d.,]*)/i,     op: '-' },
    { re: /(\d+[\d.,]*)\s*%\s*dari\s*(\d+[\d.,]*)/i,                 op: 'pct' },
    { re: /(\d+[\d.,]*)\s*(?:per)\s*(\d+[\d.,]*)/i,                  op: '/' },
  ];

  for (const { re, op } of PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const matchEnd = m.index + m[0].length;
    if ((op === '/' || op === ':') && hasAnyFracKeyword) {
      if (isFractionContext(text, m.index, matchEnd, 40)) continue;
    }
    const parseNum = s => {
      if (/^\d+\.\d+$/.test(s)) return parseFloat(s);
      return parseFloat(s.replace(/\./g, '').replace(',', '.'));
    };
    const a = parseNum(m[1]);
    const b = parseNum(m[2]);
    if (isNaN(a) || isNaN(b)) continue;
    if (op === 'pct') {
      return { found: true, tier: 'regex', op, operands: [a, b], expr: `${a}% dari ${b}`, answer: Math.round(b * a / 100 * 10000) / 10000, confidence: 0.95 };
    }
    const answer = safeCalc(a, op, b);
    if (answer === null || (op === '/' && b === 0)) continue;
    return { found: true, tier: 'regex', op, operands: [a, b], expr: `${a} ${op} ${b}`, answer: Math.round(answer * 10000) / 10000, confidence: 0.95 };
  }

  // Tier 2: Pola kata sinyal → operator.
  const WORD_PATTERNS = [
    { re: /\b(sisa|sisanya|tersisa|tinggal|diberikan|dimakan|hilang|habis|diambil|dikurangi)\b/i, op: '-' },
    { re: /\b(dibagi\s+rata|sama\s+rata|rata.rata|tiap\s+anak|per\s+orang|per\s+anak|dibagikan)\b/i, op: '/' },
    { re: /\b(berlipat|kali\s+lipat)\b/i, op: '*' },
    { re: /\b(pasang\b|pasangan\b|lusin\b|kodi\b)\b/i, op: '*', needsPairCalc: true },
    { re: /\b(tiap\b|setiap\b|masing.masing|isi\b|berisi\b|per\s+\w+)\b/i, op: '*', needsDisambig: true },
    { re: /\b(sebanyak)\b/i, op: '*', needsBagiCheck: true },
    { re: /\b(diberi|diberikan|mendapat|mendapatkan|menaruh|memasukkan|dimasukkan|membawa|lagi)\b/i, op: '+' },
    { re: /\b(jumlah|total|seluruh|semua|gabungan|bersama)\b/i, op: '+' },
  ];

  for (const { re, op, needsDisambig, needsBagiCheck, needsPairCalc } of WORD_PATTERNS) {
    if (!re.test(text)) continue;
    const nums = extractNumbers(text);
    if (nums.length < 2) continue;
    let finalOp = op;
    if (needsBagiCheck) {
      if (/\b(sisa|sisanya|tersisa|diberikan|dimakan|diambil|dikurangi|hilang|habis|kurang)\b/i.test(text)) finalOp = '-';
    }
    if (needsDisambig) {
      finalOp = /\b(bagi|dibagi|dibagikan|membagi|membagikan|bagi\s+rata|sama\s+rata)\b/i.test(text) ? '/' : '*';
    }
    const [a, b] = nums;
    if (finalOp === '/' && b === 0) continue;
    const answer = safeCalc(a, finalOp, b);
    if (answer === null) continue;
    return { found: true, tier: 'word_pattern', op: finalOp, operands: [a, b], expr: `${a} ${finalOp} ${b}`, answer: Math.round(answer * 10000) / 10000, confidence: 0.85 };
  }

  return { found: false };
}


// ── Layer B: Stem Fallback ────────────────────────────────────

function extractWordProblemWithStemFallback(text, enrichedOps) {
  if (!text || !isWordProblem(text)) return { found: false };

  const ops = enrichedOps || _enrichedOps;
  if (!ops) return { found: false };

  const stemFn = _stemmer
    ? w => { try { return _stemmer.stem(w); } catch { return w; } }
    : w => w;

  const tokens = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w));

  const stemmed = tokens.map(t => ({ original: t, stem: stemFn(t) }));

  let detectedOp = null;
  for (const { original, stem } of stemmed) {
    const op = ops.get(stem) || ops.get(original);
    if (op && op !== 'frac' && op !== 'pct') { detectedOp = op; break; }
  }

  if (!detectedOp) {
    if (/\b(?:sisa|sisanya|tinggal|masih|tersisa)\b/i.test(text)) detectedOp = '-';
    if (/\b(?:jumlah|total|seluruh|semua)\b/i.test(text))         detectedOp = '+';
  }

  if (!detectedOp) return { found: false };

  const nums = extractNumbers(text);
  if (nums.length < 2) return { found: false };
  const [a, b] = nums;
  if (detectedOp === '/' && b === 0) return { found: false };

  const answer = safeCalc(a, detectedOp, b);
  if (answer === null) return { found: false };

  return {
    found: true, tier: 'stem_fallback',
    op: detectedOp, operands: [a, b],
    expr: `${a} ${detectedOp} ${b}`,
    answer: Math.round(answer * 10000) / 10000,
    confidence: 0.70,
  };
}

module.exports = {
  extractWordProblem,
  extractWordProblemWithStemFallback,
  extractNumbers,
  isWordProblem,
  init,
};

