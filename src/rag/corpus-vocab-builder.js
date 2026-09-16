'use strict';

/**
 * corpus-vocab-builder.js
 * Dijalankan SEKALI saat server startup. Membaca ~5.446 soal dari DB,
 * mengekstrak kata-kata unik, lalu memperkaya synonym map runtime.
 *
 * Output: enrichedSynonyms (Map) yang dipakai query-processor.js dan soal-cerita.js
 *
 * Dependensi: db.js, sastrawijs (graceful fallback jika tidak ada)
 * Estimasi waktu: ~50-200ms (query + tokenize 5446 soal)
 */

const db = require('../database/db');
const { OP_SYNONYMS, NAMA_ORANG, BENDA_UMUM } = require('./id-math-synonyms');

// Coba load sastrawijs — graceful jika tidak ada
// (sastrawijs@1.1.0 export: { Stemmer, Tokenizer }; dukung juga alias lama StemmerID)
let StemmerID = null;
try {
  const _sastrawi = require('sastrawijs');
  StemmerID = _sastrawi.Stemmer || _sastrawi.StemmerID || null;
  if (!StemmerID) console.warn('[VocabBuilder] sastrawijs tanpa export Stemmer — stem fallback ke kata asli');
} catch {
  console.warn('[VocabBuilder] sastrawijs tidak tersedia — stem fallback ke kata asli');
}

// Custom dict matematika — kata yang TIDAK boleh di-stem (prefix "se-" bermakna)
const MATH_CUSTOM_DICT = [
  'setengah','seperempat','sepertiga','persen','diskon','pajak','bunga',
  'sisa','hasil','jumlah','total','selisih','kuadrat','akar','bulat',
  'pecahan','desimal','bilangan','kelipatan','faktor','prima',
  'kelereng','permen','pensil','krayon','roti','kue','ember','keranjang',
];

const SKIP_WORDS = new Set([
  'yang','dan','di','ke','dari','dengan','untuk','pada','adalah','ini',
  'itu','ada','tidak','bisa','akan','sudah','juga','atau','oleh','karena',
  'jika','maka','agar','saja','hanya','telah','sedang','masih','belum',
  'lebih','sama','ber','ter','me','pe','se','kan','nya','lah','kah','pun',
  'satu','dua','tiga','empat','lima','enam','tujuh','delapan','sembilan',
  'sepuluh','sebelas','belas','puluh','ratus','ribu','juta',
]);

// Prefix kata kerja BI
const VERB_PREFIX_RE = /^(?:me(?:ng|ny|m|n)?|di|ber|ter|ke|pe(?:ng|ny|m|n|r)?)/;

function createStemmer() {
  if (!StemmerID) return { stem: w => w };
  try {
    return new StemmerID(MATH_CUSTOM_DICT);
  } catch {
    try { return new StemmerID(); } catch { return { stem: w => w }; }
  }
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !/^\d+$/.test(w) && !SKIP_WORDS.has(w));
}

function stemSafe(stemmer, word) {
  try { return stemmer.stem(word); } catch { return word; }
}

/**
 * extractVocabFromExercises() → VocabResult
 * Query semua exercises dari DB, ekstrak vocab baru.
 */
async function extractVocabFromExercises() {
  console.log('[VocabBuilder] Mulai ekstraksi vocab dari DB exercises...');
  const t0 = Date.now();

  const stemmer = createStemmer();

  // Kolom yang ada di schema aktual: hint_text, speech_text, quick_trick, level_id
  const { rows } = await db.query(`
    SELECT
      COALESCE(hint_text,   '') AS hint,
      COALESCE(speech_text, '') AS speech,
      COALESCE(quick_trick, '') AS trick,
      level_id
    FROM exercises
    WHERE hint_text IS NOT NULL
    ORDER BY level_id ASC
  `);

  console.log(`[VocabBuilder] ${rows.length} exercises ditemukan dari DB`);

  const newOpVerbs   = new Map();  // stem → operator
  const newNames     = new Set();  // nama orang baru
  const newObjects   = new Set();  // benda konteks baru
  const candidateOps = new Set();  // kata dekat angka, belum terklasifikasi
  const allTokens    = new Map();  // stem → { count, sample }

  for (const row of rows) {
    const fullText = [row.hint, row.speech, row.trick].join(' ');

    // Ekstrak nama orang (kapital bukan awal kalimat)
    const nameMatches = fullText.match(/(?<=[.!?,]\s*)[A-Z][a-z]{2,}/g) || [];
    for (const name of nameMatches) {
      const lc = name.toLowerCase();
      if (!SKIP_WORDS.has(lc) && lc.length >= 3 && !NAMA_ORANG.has(lc)) {
        newNames.add(lc);
      }
    }

    const tokens = tokenize(fullText);
    for (const word of tokens) {
      const stem = stemSafe(stemmer, word);

      // Akumulasi frekuensi
      if (!allTokens.has(stem)) allTokens.set(stem, { count: 0, sample: word });
      allTokens.get(stem).count++;

      // Jika sudah ada di map — skip
      if (OP_SYNONYMS[stem] || OP_SYNONYMS[word]) continue;
      if (newOpVerbs.has(stem) || newOpVerbs.has(word)) continue;

      // Kata dekat angka + prefix verba → kandidat operator.
      // Guard: kata harus benar-benar VERBA (stem mengubah bentuk ATAU ada di
      // custom dict sebagai kata kerja). Tanpa ini, kata benda seperti
      // "berapa", "permen", "kelereng" ikut ter-inferensi sebagai operator
      // hanya karena regex prefix "ber-/pe-/se-" cocok di awal kata.
      const nearNum     = new RegExp(`${word}\\s+\\d|\\d\\s+${word}`, 'i').test(fullText);
      const hasVerbPfx  = VERB_PREFIX_RE.test(word);
      // Guard ketat: kata benda ("permen", "kelereng", "pecahan") walau cocok
      // regex prefix pe-/se-/ber- TIDAK boleh jadi operator. Hanya varian
      // imbuhan dari verba yang SUDAH dikenal di OP_SYNONYMS yang boleh lolos.
      const stemKnownOp = stem && OP_SYNONYMS[stem]
        && OP_SYNONYMS[stem] !== 'frac' && OP_SYNONYMS[stem] !== 'pct';
      const isKnownVerbVariant = hasVerbPfx && !!stemKnownOp;

      if (nearNum && isKnownVerbVariant) {
        // Inferensi: ambil kata konteks yang sudah diketahui di kalimat yang sama
        const contextWords = fullText
          .toLowerCase()
          .split(/\s+/)
          .filter(w => OP_SYNONYMS[w] || OP_SYNONYMS[stemSafe(stemmer, w)]);

        if (contextWords.length > 0) {
          const ctxStem     = stemSafe(stemmer, contextWords[0]);
          const inferredOp  = OP_SYNONYMS[contextWords[0]] || OP_SYNONYMS[ctxStem];
          if (inferredOp && inferredOp !== 'frac' && inferredOp !== 'pct') {
            newOpVerbs.set(stem, inferredOp);
            if (stem !== word) newOpVerbs.set(word, inferredOp);
          } else {
            candidateOps.add(stem);
          }
        } else {
          candidateOps.add(stem);
        }
      }

      // Benda baru (kata benda yang muncul langsung setelah angka)
      if (BENDA_UMUM.has(word) || BENDA_UMUM.has(stem)) {
        newObjects.add(word);
      }
    }

    // Pattern "angka [kata benda]" — benda langsung setelah angka
    const objectMatches = fullText.match(/\d+\s+([a-z]{3,})/gi) || [];
    for (const match of objectMatches) {
      const obj = match.replace(/^\d+\s+/, '').toLowerCase();
      if (!SKIP_WORDS.has(obj) && !VERB_PREFIX_RE.test(obj) && obj.length >= 3) {
        newObjects.add(obj);
      }
    }
  }

  const elapsed = Date.now() - t0;
  const stats = {
    exercisesProcessed: rows.length,
    newOpVerbsFound:    newOpVerbs.size,
    newNamesFound:      newNames.size,
    newObjectsFound:    newObjects.size,
    candidatesFound:    candidateOps.size,
    uniqueStemsTotal:   allTokens.size,
    elapsedMs:          elapsed,
  };

  console.log(`[VocabBuilder] Ekstraksi selesai ${elapsed}ms:`, stats);
  return { newOpVerbs, newNames, newObjects, candidateOps, stats };
}

/**
 * buildEnrichedSynonyms() → EnrichedSynonyms
 *
 * Gabungkan base hardcode + hasil ekstraksi DB.
 * Return object siap pakai oleh query-processor.js dan soal-cerita.js.
 * Dipanggil SEKALI saat startup, hasilnya di-cache di memory.
 */
async function buildEnrichedSynonyms() {
  const vocab = await extractVocabFromExercises();

  // Mulai dari base hardcode
  const enrichedOps     = new Map(Object.entries(OP_SYNONYMS));
  const enrichedNames   = new Set(NAMA_ORANG);
  const enrichedObjects = new Set(BENDA_UMUM);

  // Merge dari DB — tidak timpa yang sudah ada
  for (const [stem, op] of vocab.newOpVerbs) {
    if (!enrichedOps.has(stem)) enrichedOps.set(stem, op);
  }
  for (const name   of vocab.newNames)   enrichedNames.add(name);
  for (const object of vocab.newObjects) enrichedObjects.add(object);

  const finalStats = {
    ...vocab.stats,
    totalOpSynonyms:  enrichedOps.size,
    totalNames:       enrichedNames.size,
    totalObjects:     enrichedObjects.size,
  };

  console.log(`[VocabBuilder] Enriched siap: ${enrichedOps.size} op synonyms, ` +
    `${enrichedNames.size} names, ${enrichedObjects.size} objects`);

  return {
    opSynonyms:  enrichedOps,
    namaOrang:   enrichedNames,
    bendaUmum:   enrichedObjects,
    candidates:  vocab.candidateOps,
    stats:       finalStats,
  };
}

module.exports = { buildEnrichedSynonyms, extractVocabFromExercises };
