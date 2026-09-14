/**
 * backtest-rag.js — Backtest semantic search BGE-M3 1024-dim
 *
 * Strategi ground-truth: SYNTHETIC SELF-CONSISTENCY
 *   - Ambil N chunk acak dari explanations_embedding (stratified per level)
 *   - Untuk setiap chunk, embed chunk_text-nya → gunakan sebagai query
 *   - Cek apakah chunk asal muncul di top-K hasil semantic search
 *   - Hitung MRR@K, Recall@K, Precision@K, dan distribusi similarity score
 *
 * Tambahan: CROSS-TYPE RETRIEVAL TEST
 *   - Embed quick_trick → cari hint_text dari exercise yang sama
 *   - Ukur apakah chunk dari exercise_id yang sama muncul di top-K
 *   - Ini ukur seberapa baik BGE-M3 mengenali "konsep yang sama, teks berbeda"
 *
 * Output: tabel ringkasan + rekomendasi threshold final
 *
 * Jalankan: node scripts/backtest-rag.js
 * Opsi:
 *   --samples=200    jumlah sample per level (default: 100)
 *   --top-k=10       K untuk Recall@K dan MRR@K (default: 10)
 *   --levels=1,2,3   filter level (default: semua)
 *   --cross-type     tambahkan cross-type retrieval test
 *   --full           --samples=300 --top-k=10 --cross-type sekaligus
 */

'use strict';

const http = require('http');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ── Config ─────────────────────────────────────────────────────────────────────
const OLLAMA_HOST   = process.env.OLLAMA_HOST        || 'localhost';
const OLLAMA_PORT   = parseInt(process.env.OLLAMA_PORT   || '11434', 10);
const OLLAMA_MODEL  = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_DIM     = 1024;
const EMBED_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '30000', 10);

// Parse CLI args
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => { const [k, v] = a.slice(2).split('='); return [k, v ?? true]; })
);
const IS_FULL       = args['full']       === true;
const SAMPLES_PER_LEVEL = parseInt(args['samples'] || (IS_FULL ? '300' : '100'), 10);
const TOP_K         = parseInt(args['top-k']   || '10', 10);
const LEVEL_FILTER  = args['levels'] ? args['levels'].split(',').map(Number) : null;
const DO_CROSS_TYPE = args['cross-type'] === true || IS_FULL;

// Threshold sweep yang akan diuji
const THRESHOLD_SWEEP = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];

// ── DB ─────────────────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'cadas_app_dev',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 3,
});

// ── Ollama embed ───────────────────────────────────────────────────────────────
async function embed(text) {
  const t = String(text || '').slice(0, 512).trim();
  if (!t) return null;

  return new Promise(resolve => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, prompt: t });
    const req  = http.request(
      {
        hostname: OLLAMA_HOST, port: OLLAMA_PORT,
        path: '/api/embeddings', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: EMBED_TIMEOUT,
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const p = JSON.parse(raw);
            resolve(p.embedding?.length === EMBED_DIM ? p.embedding : null);
          } catch { resolve(null); }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.write(body); req.end();
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtVec(vec) {
  return '[' + Array.from(vec).map(v => v.toFixed(8)).join(',') + ']';
}

function progress(done, total, label) {
  const pct = Math.round(done / total * 100);
  const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  [${bar}] ${pct}% (${done}/${total}) ${label}    `);
}

// ── Sample chunks dari DB ──────────────────────────────────────────────────────
async function sampleChunks(client) {
  // Ambil level yang tersedia
  let levelQuery = `SELECT DISTINCT level_id FROM explanations_embedding WHERE embedding_ready=true ORDER BY level_id`;
  const { rows: levelRows } = await client.query(levelQuery);
  let levels = levelRows.map(r => r.level_id);
  if (LEVEL_FILTER) levels = levels.filter(l => LEVEL_FILTER.includes(l));

  console.log(`  Level tersedia: ${levels.join(', ')}`);

  const allSamples = [];
  for (const levelId of levels) {
    // Stratified sampling: prioritas quick_trick dan hint_text (lebih informatif)
    const { rows } = await client.query(
      `SELECT id, exercise_id, explanation_id, concept_id, level_id,
              chunk_type, chunk_text
       FROM explanations_embedding
       WHERE level_id = $1
         AND embedding_ready = true
         AND chunk_type IN ('quick_trick','hint_text','speech_text','explanation')
         AND length(chunk_text) > 20
       ORDER BY RANDOM()
       LIMIT $2`,
      [levelId, SAMPLES_PER_LEVEL]
    );
    allSamples.push(...rows);
  }

  return allSamples;
}

// ── Self-consistency retrieval test ───────────────────────────────────────────
/**
 * Untuk setiap sample, embed chunk_text → query → cek apakah row.id muncul di top-K.
 * Return array of { id, level_id, chunk_type, rank, topSim, allSims }
 */
async function runSelfConsistency(client, samples) {
  const results = [];
  let done = 0;

  for (const s of samples) {
    const vec = await embed(s.chunk_text);
    if (!vec) { done++; progress(done, samples.length, 'embed err'); continue; }

    // Query semantic search — SAMA persis dengan pipeline.js
    const { rows } = await client.query(
      `SELECT id, chunk_type, 1 - (embedding <=> $1::vector(1024)) AS sim
       FROM explanations_embedding
       WHERE level_id = $2 AND embedding_ready = true
       ORDER BY embedding <=> $1::vector(1024)
       LIMIT $3`,
      [fmtVec(vec), s.level_id, TOP_K]
    );

    const rank = rows.findIndex(r => r.id === s.id);  // -1 jika tidak ditemukan
    const topSim = rows.length > 0 ? parseFloat(rows[0].sim) : 0;
    const allSims = rows.map(r => parseFloat(r.sim));

    results.push({
      id:         s.id,
      level_id:   s.level_id,
      chunk_type: s.chunk_type,
      rank:       rank,          // 0-indexed; -1 = tidak ada di top-K
      topSim,
      ownSim:     rank >= 0 ? allSims[rank] : null,
      allSims,
    });

    done++;
    progress(done, samples.length, s.chunk_type.padEnd(12));
    await sleep(50);  // throttle Ollama sedikit
  }

  console.log('');
  return results;
}

// ── Cross-type retrieval test ──────────────────────────────────────────────────
/**
 * Query: quick_trick dari exercise X → apakah hint_text dari exercise X masuk top-K?
 * Ukur seberapa baik BGE-M3 mengenali konsep yang sama dengan teks berbeda.
 */
async function runCrossType(client) {
  // Ambil pasangan quick_trick + hint_text dari exercise yang sama
  const { rows: pairs } = await client.query(
    `SELECT qt.id AS qt_id, qt.chunk_text AS qt_text,
            ht.id AS ht_id, qt.level_id,
            qt.exercise_id
     FROM explanations_embedding qt
     JOIN explanations_embedding ht
       ON qt.exercise_id = ht.exercise_id
      AND ht.chunk_type = 'hint_text'
      AND qt.embedding_ready = true
      AND ht.embedding_ready = true
     WHERE qt.chunk_type = 'quick_trick'
       AND qt.exercise_id IS NOT NULL
     ORDER BY RANDOM()
     LIMIT 200`
  );

  if (pairs.length === 0) {
    console.log('  (tidak ada pasangan quick_trick+hint_text — skip cross-type)');
    return [];
  }

  console.log(`  Pasangan quick_trick↔hint_text: ${pairs.length}`);
  const results = [];
  let done = 0;

  for (const p of pairs) {
    const vec = await embed(p.qt_text);
    if (!vec) { done++; continue; }

    const { rows } = await client.query(
      `SELECT id, 1 - (embedding <=> $1::vector(1024)) AS sim
       FROM explanations_embedding
       WHERE level_id = $2 AND embedding_ready = true AND chunk_type = 'hint_text'
       ORDER BY embedding <=> $1::vector(1024)
       LIMIT $3`,
      [fmtVec(vec), p.level_id, TOP_K]
    );

    const rank = rows.findIndex(r => r.id === p.ht_id);
    const topSim = rows.length > 0 ? parseFloat(rows[0].sim) : 0;

    results.push({ level_id: p.level_id, rank, topSim });
    done++;
    progress(done, pairs.length, 'cross-type');
    await sleep(50);
  }

  console.log('');
  return results;
}

// ── Hitung metrik ──────────────────────────────────────────────────────────────
function computeMetrics(results, k) {
  const n = results.length;
  if (n === 0) return null;

  // MRR@K
  const mrr = results.reduce((sum, r) => {
    return sum + (r.rank >= 0 && r.rank < k ? 1 / (r.rank + 1) : 0);
  }, 0) / n;

  // Recall@K (berapa % yang masuk top-K)
  const recallK = results.filter(r => r.rank >= 0 && r.rank < k).length / n;

  // Recall@1 (top-1 exact hit)
  const recall1 = results.filter(r => r.rank === 0).length / n;

  // Distribusi similarity score (topSim dari setiap query)
  const sims = results.map(r => r.topSim).sort((a, b) => a - b);
  const p25  = sims[Math.floor(n * 0.25)] || 0;
  const p50  = sims[Math.floor(n * 0.50)] || 0;
  const p75  = sims[Math.floor(n * 0.75)] || 0;
  const mean = sims.reduce((a, b) => a + b, 0) / n;

  // Distribusi ownSim (similarity chunk ke dirinya sendiri — harusnya tinggi)
  const ownSims = results.filter(r => r.ownSim !== null).map(r => r.ownSim);
  const ownMean = ownSims.length > 0 ? ownSims.reduce((a, b) => a + b, 0) / ownSims.length : null;
  const ownMin  = ownSims.length > 0 ? Math.min(...ownSims) : null;

  return { n, mrr, recallK, recall1, p25, p50, p75, mean, ownMean, ownMin };
}

// Threshold analysis — untuk setiap threshold, hitung precision/coverage tradeoff
function thresholdAnalysis(results) {
  const rows = [];
  for (const thresh of THRESHOLD_SWEEP) {
    // Strong hit: topSim >= thresh AND rank 0 (exact match di top-1)
    const strong   = results.filter(r => r.topSim >= thresh && r.rank === 0).length;
    // Partial hit: topSim >= thresh * 0.73 (simulasi SIM_PARTIAL = thresh * ~0.73)
    const partial  = results.filter(r => r.topSim >= thresh * 0.73 && r.rank >= 0 && r.rank < TOP_K).length;
    // False positive risk: topSim >= thresh tapi rank != 0 (chunk lain lebih tinggi)
    const falsePos = results.filter(r => r.topSim >= thresh && r.rank !== 0).length;
    // Miss: topSim < thresh (tidak ada hasil yang kuat)
    const miss     = results.filter(r => r.topSim < thresh).length;

    const coverage = strong / results.length;
    const fpRate   = results.filter(r => r.topSim >= thresh).length > 0
      ? falsePos / results.filter(r => r.topSim >= thresh).length : 0;

    rows.push({ thresh, strong, partial, falsePos, miss, coverage, fpRate });
  }
  return rows;
}

// ── Per-level breakdown ────────────────────────────────────────────────────────
function perLevelBreakdown(results) {
  const byLevel = {};
  for (const r of results) {
    if (!byLevel[r.level_id]) byLevel[r.level_id] = [];
    byLevel[r.level_id].push(r);
  }
  return Object.entries(byLevel)
    .sort(([a], [b]) => a - b)
    .map(([level, rows]) => ({ level, ...computeMetrics(rows, TOP_K) }));
}

// Per chunk_type breakdown
function perTypeBreakdown(results) {
  const byType = {};
  for (const r of results) {
    if (!byType[r.chunk_type]) byType[r.chunk_type] = [];
    byType[r.chunk_type].push(r);
  }
  return Object.entries(byType)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => ({ type, ...computeMetrics(rows, TOP_K) }));
}

// ── Print helpers ──────────────────────────────────────────────────────────────
const fmt = (n, d=4) => typeof n === 'number' ? n.toFixed(d) : 'N/A';
const pct = (n) => typeof n === 'number' ? (n*100).toFixed(1)+'%' : 'N/A';

function printHeader(title) {
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function printMetrics(m, label='') {
  if (!m) return;
  console.log(`  ${label ? label+': ' : ''}n=${m.n}`);
  console.log(`    MRR@${TOP_K}      : ${fmt(m.mrr)}`);
  console.log(`    Recall@${TOP_K}   : ${pct(m.recallK)}`);
  console.log(`    Recall@1    : ${pct(m.recall1)}`);
  console.log(`    topSim p25/p50/p75 : ${fmt(m.p25,3)} / ${fmt(m.p50,3)} / ${fmt(m.p75,3)}`);
  console.log(`    topSim mean : ${fmt(m.mean,3)}`);
  if (m.ownMean !== null) {
    console.log(`    ownSim mean : ${fmt(m.ownMean,3)} (min: ${fmt(m.ownMin,3)})`);
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('  backtest-rag.js — BGE-M3 1024-dim Synthetic Backtest');
  console.log(`  samples/level: ${SAMPLES_PER_LEVEL} | top-K: ${TOP_K} | cross-type: ${DO_CROSS_TYPE}`);
  console.log('════════════════════════════════════════════════════════════\n');

  // Test Ollama
  process.stdout.write('▶ Cek Ollama... ');
  const testVec = await embed('tes koneksi backtest');
  if (!testVec) { console.error('GAGAL — pastikan ollama serve berjalan'); process.exit(1); }
  console.log(`OK (dim=${testVec.length})`);

  const client = await pool.connect();

  // Verifikasi corpus
  const { rows: corpusStats } = await client.query(
    `SELECT chunk_type, COUNT(*) as n FROM explanations_embedding
     WHERE embedding_ready=true GROUP BY chunk_type ORDER BY chunk_type`
  );
  console.log('\n▶ Corpus stats:');
  corpusStats.forEach(r => console.log(`   ${r.chunk_type.padEnd(20)}: ${r.n}`));

  // ── Test 1: Self-Consistency ───────────────────────────────────────────────
  printHeader('TEST 1 — Self-Consistency Retrieval');
  console.log('▶ Sampling chunks...');
  const samples = await sampleChunks(client);
  console.log(`  Total sample: ${samples.length} chunks\n`);

  console.log('▶ Running self-consistency test...');
  const scResults = await runSelfConsistency(client, samples);
  const scMetrics = computeMetrics(scResults, TOP_K);

  printHeader('HASIL SELF-CONSISTENCY');
  printMetrics(scMetrics, 'Overall');

  // Per level
  console.log('\n  Per Level:');
  const byLevel = perLevelBreakdown(scResults);
  console.log(`  ${'Level'.padEnd(8)} ${'n'.padEnd(6)} ${'MRR@K'.padEnd(8)} ${'R@K'.padEnd(8)} ${'R@1'.padEnd(8)} ${'p50sim'}`);
  console.log('  ' + '─'.repeat(50));
  for (const l of byLevel) {
    console.log(
      `  ${String(l.level).padEnd(8)} ${String(l.n).padEnd(6)} ${fmt(l.mrr).padEnd(8)} ${pct(l.recallK).padEnd(8)} ${pct(l.recall1).padEnd(8)} ${fmt(l.p50,3)}`
    );
  }

  // Per chunk_type
  console.log('\n  Per Chunk Type:');
  const byType = perTypeBreakdown(scResults);
  console.log(`  ${'Type'.padEnd(16)} ${'n'.padEnd(6)} ${'MRR@K'.padEnd(8)} ${'R@K'.padEnd(8)} ${'R@1'}`);
  console.log('  ' + '─'.repeat(44));
  for (const t of byType) {
    console.log(
      `  ${t.type.padEnd(16)} ${String(t.n).padEnd(6)} ${fmt(t.mrr).padEnd(8)} ${pct(t.recallK).padEnd(8)} ${pct(t.recall1)}`
    );
  }

  // ── Threshold Sweep ────────────────────────────────────────────────────────
  printHeader('THRESHOLD SWEEP ANALYSIS');
  const sweep = thresholdAnalysis(scResults);
  console.log(`  ${'Thresh'.padEnd(8)} ${'Strong'.padEnd(8)} ${'Coverage'.padEnd(12)} ${'FP-Rate'.padEnd(10)} ${'Miss'}`);
  console.log('  ' + '─'.repeat(50));
  for (const s of sweep) {
    const marker = (s.thresh === 0.55 || s.thresh === 0.40) ? ' ◄ current' : '';
    console.log(
      `  ${String(s.thresh).padEnd(8)} ${String(s.strong).padEnd(8)} ${pct(s.coverage).padEnd(12)} ${pct(s.fpRate).padEnd(10)} ${s.miss}${marker}`
    );
  }

  // ── Test 2: Cross-Type ─────────────────────────────────────────────────────
  let ctMetrics = null;
  if (DO_CROSS_TYPE) {
    printHeader('TEST 2 — Cross-Type Retrieval (quick_trick → hint_text)');
    console.log('▶ Running cross-type test...');
    const ctResults = await runCrossType(client);
    ctMetrics = computeMetrics(ctResults, TOP_K);
    if (ctMetrics) printMetrics(ctMetrics, 'quick_trick → hint_text');
  }

  // ── Rekomendasi Final ──────────────────────────────────────────────────────
  printHeader('REKOMENDASI THRESHOLD FINAL');

  const { mrr, recallK, recall1, p50 } = scMetrics;

  // Cari threshold optimal: coverage >= 40% dengan FP-rate < 20%
  const bestThresh = sweep.reduce((best, s) => {
    const score = s.coverage - s.fpRate * 0.5;  // balance coverage vs precision
    return score > best.score ? { thresh: s.thresh, score } : best;
  }, { thresh: 0.55, score: -Infinity });

  const recallGood = recallK >= 0.80;
  const mrrGood    = mrr >= 0.50;
  const simLow     = p50 < 0.45;

  console.log('\n  Diagnosis:');
  console.log(`    MRR@${TOP_K}     : ${fmt(mrr)} ${mrrGood ? '✓ BAIK' : '✗ PERLU TUNING'}`);
  console.log(`    Recall@${TOP_K}  : ${pct(recallK)} ${recallGood ? '✓ BAIK' : '✗ CORPUS MUNGKIN KURANG'}`);
  console.log(`    Median sim : ${fmt(p50,3)} ${simLow ? '! Threshold terlalu tinggi?' : '✓ OK'}`);

  console.log('\n  Rekomendasi:');
  if (recallK >= 0.85 && mrr >= 0.60) {
    console.log('    ✓ Corpus dan threshold OPTIMAL. Tidak perlu perubahan.');
    console.log(`      SIM_STRONG  = 0.55 (current)`);
    console.log(`      SIM_PARTIAL = 0.40 (current)`);
  } else if (simLow) {
    const newStrong  = Math.max(0.35, p50 - 0.05).toFixed(2);
    const newPartial = Math.max(0.25, p50 - 0.15).toFixed(2);
    console.log(`    ⚠ Similarity score rendah — turunkan threshold:`);
    console.log(`      SIM_STRONG  = ${newStrong}  (dari 0.55)`);
    console.log(`      SIM_PARTIAL = ${newPartial} (dari 0.40)`);
  } else {
    console.log(`    → Threshold optimal dari sweep: ${bestThresh.thresh}`);
    console.log(`      SIM_STRONG  = ${bestThresh.thresh}`);
    console.log(`      SIM_PARTIAL = ${(bestThresh.thresh - 0.15).toFixed(2)}`);
  }

  if (ctMetrics && ctMetrics.recallK < 0.30) {
    console.log('\n  ⚠ Cross-type recall rendah — hint_text dan quick_trick');
    console.log('    semantically jauh. Pertimbangkan embedding bersama atau');
    console.log('    query expansion saat retrieval.');
  }

  // Summary untuk PROGRESS_APPEND
  printHeader('RINGKASAN UNTUK PROGRESS_APPEND');
  console.log(`  Tanggal       : ${new Date().toISOString().slice(0,10)}`);
  console.log(`  Corpus        : ${corpusStats.reduce((s,r)=>s+parseInt(r.n),0)} chunks`);
  console.log(`  Model embed   : BGE-M3 via Ollama (1024-dim)`);
  console.log(`  Test samples  : ${scResults.length} (self-consistency)`);
  console.log(`  MRR@${TOP_K}        : ${fmt(mrr)}`);
  console.log(`  Recall@${TOP_K}     : ${pct(recallK)}`);
  console.log(`  Recall@1      : ${pct(recall1)}`);
  console.log(`  Median sim    : ${fmt(p50,3)}`);
  if (ctMetrics) {
    console.log(`  Cross-type R@K: ${pct(ctMetrics.recallK)}`);
  }
  console.log(`  Threshold saat ini: SIM_STRONG=0.55 / SIM_PARTIAL=0.40`);
  console.log('\n════════════════════════════════════════════════════════════\n');

  client.release();
  await pool.end();
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
