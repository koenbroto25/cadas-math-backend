/**
 * Deterministic speech normalizer — written math notation → Indonesian spoken form.
 * Implements Layer 6 of docs/PRIMING_STRUKTUR_BOT_TUTOR_MATEMATIKA_SD.md.
 * Pure rule-based; used both offline (post-LLM) and at runtime (pre-TTS safety net).
 */

const ONES = ['nol', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan',
  'sepuluh', 'sebelas'];
function numToWords(n) {
  n = Math.round(n);
  if (n < 0) return 'minus ' + numToWords(-n);
  if (n < 12) return ONES[n];
  if (n < 20) return numToWords(n - 10) + ' belas';
  if (n < 100) {
    const r = n % 10;
    return numToWords(Math.floor(n / 10)) + ' puluh' + (r ? ' ' + numToWords(r) : '');
  }
  if (n < 200) return 'seratus' + (n % 100 ? ' ' + numToWords(n % 100) : '');
  if (n < 1000) {
    const r = n % 100;
    return numToWords(Math.floor(n / 100)) + ' ratus' + (r ? ' ' + numToWords(r) : '');
  }
  if (n < 2000) return 'seribu' + (n % 1000 ? ' ' + numToWords(n % 1000) : '');
  if (n < 1000000) {
    const r = n % 1000;
    return numToWords(Math.floor(n / 1000)) + ' ribu' + (r ? ' ' + numToWords(r) : '');
  }
  if (n < 1000000000) {
    const r = n % 1000000;
    return numToWords(Math.floor(n / 1000000)) + ' juta' + (r ? ' ' + numToWords(r) : '');
  }
  return String(n);
}

const UNITS = [
  [/\bcm\b/g, 'sentimeter'],
  [/\bcm2\b/gi, 'sentimeter persegi'],
  [/\bkm\b/g, 'kilometer'],
  [/\bkg\b/g, 'kilogram'],
  [/\bgram\b/gi, 'gram'],
  [/\bml\b/gi, 'mililiter'],
  [/\bliter\b/gi, 'liter'],
];

/**
 * Convert math notation in an Indonesian text into its spoken form.
 * @param {string} text
 * @returns {string} spoken text
 */
function normalizeSpeech(text) {
  if (!text) return text;
  let t = String(text);

  // 0. strip markdown artifacts
  t = t.replace(/`/g, '').replace(/\*\*/g, '');

  // 1. money: "Rp 50.000" / "Rp50.000" → "lima puluh ribu rupiah"
  t = t.replace(/(?:Rp\.?\s*)(\d{1,3}(?:\.\d{3})+|\d+)/gi, (m, num) => {
    const val = parseInt(num.replace(/\./g, ''), 10);
    return numToWords(val) + ' rupiah';
  });

  // 2. thousands: digit groups with dot + exactly 3 digits
  t = t.replace(/\b(\d{1,3}(?:\.\d{3})+)\b/g, (m, num) => {
    const val = parseInt(num.replace(/\./g, ''), 10);
    return numToWords(val);
  });

  // 3. decimals: "2.5" / "0.75" → "dua koma lima" / "nol koma tujuh lima"
  t = t.replace(/\b(\d+)\.(\d+)\b/g, (m, int, frac) =>
    `${numToWords(parseInt(int, 10))} koma ${frac.split('').map((d) => ONES[+d]).join(' ')}`);

  // 4. fractions: "3/4" → "tiga per empat"
  t = t.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, (m, a, b) =>
    `${numToWords(parseInt(a, 10))} per ${numToWords(parseInt(b, 10))}`);

  // 5. division ":" between digits → "dibagi"
  t = t.replace(/(\d)\s*:\s*(\d)/g, '$1 dibagi $2');

  // 6. operators
  t = t.replace(/\s*[×x✕*]\s*/gi, ' dikali ');
  t = t.replace(/\s*÷\s*/g, ' dibagi ');
  t = t.replace(/\s*=\s*/g, ' sama dengan ');
  t = t.replace(/\s*\+\s*/g, ' tambah ');
  t = t.replace(/(\d|\))\s*-\s*(\d|\()/g, '$1 dikurang $2');

  // 7. leftover parentheses
  t = t.replace(/[(){}]/g, ' ');

  // 8. units → spoken full
  for (const [re, spoken] of UNITS) t = t.replace(re, spoken);

  // 9. Malay watchlist
  t = t.replace(/\bkerana\b/gi, 'karena')
    .replace(/\btolak\b/gi, 'dikurang')
    .replace(/\bbahagi\b/gi, 'dibagi')
    .replace(/\bawak\b/gi, 'kamu')
    .replace(/\bhendak\b/gi, 'mau');

  // 10. tidy whitespace & stray punctuation
  t = t.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  return t;
}

function normalizeExerciseSpeech(problemText) {
  return normalizeSpeech(problemText);
}

module.exports = { normalizeSpeech, normalizeExerciseSpeech, numToWords };
