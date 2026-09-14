/**
 * build-rag-corpus.js — Bangun corpus embedding BGE-M3 1024-dim
 *
 * Corpus yang diindex (~16.276 chunks):
 *   exercises.hint_text    → ~5.446 chunks  (konteks konsep)
 *   exercises.quick_trick  → ~5.446 chunks  (cara cepat GASING)
 *   exercises.speech_text  → ~5.298 chunks  (penjelasan natural)
 *   explanations.content   → ~15 chunks     (penjelasan per level)
 *   explanations.variants  → ~30 chunks     (gasing/pmri/quick)
 *
 * Jalankan: node scripts/build-rag-corpus.js
 * Estimasi waktu: ~3-5 jam (16K calls ke Ollama localhost, ~12-27 doc/menit)
 * RAM: BGE-M3 ~1.2GB model weight. Proses Node: ~200MB tambahan.
 *
 * Fitur:
 *   - Batch insert (200 chunks per commit) → tidak lock DB
 *   - Resume-safe: skip chunk yang sudah ada (ON CONFLICT DO NOTHING)
 *   - Progress bar sederhana ke stdout
 *   - Retry otomatis 3x per chunk jika Ollama timeout
 *   - Dry-run mode: --dry-run → hanya print stats, tidak embed/insert
 */

'use strict';

const http  = require('http');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

// ── Konfigurasi ───────────────────────────────────────────────────────────────
const OLLAMA_HOST    = process.env.OLLAMA_HOST    || 'localhost';
const OLLAMA_PORT    = parseInt(process.env.OLLAMA_PORT || '11434', 10);
const OLLAMA_MODEL   = process.env.OLLAMA_EMBED_MODEL || 'bge-m3';
const EMBED_DIM      = 1024;
const BATCH_SIZE     = 200;   // rows per DB commit
const OLLAMA_TIMEOUT = parseInt(process.env.OLLAMA_TIMEOUT_MS || '60000', 10);
const MAX_RETRY      = 3;
const DRY_RUN        = process.argv.includes('--dry-run');

// Panjang teks maksimum per chunk (BGE-M3 context window 8192 token,
// tapi teks panjang memperlambat embed). Potong di 512 char.
const MAX_CHUNK_CHARS = 512;

// ── DB Pool ───────────────────────────────────────────────────────────────────
const pool = new Pool({
  host:     process.env.DB_HOST     || 'localhost',
  port:     parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME     || 'cadas_app_dev',
  user:     process.env.DB_USER     || 'postgres',
  password: process.env.DB_PASSWORD || '',
  max: 5,
});

// ── Ollama embed ──────────────────────────────────────────────────────────────
/**
 * Kirim satu teks ke Ollama /api/embeddings, return Float64Array 1024-dim.
 * Retry MAX_RETRY kali jika gagal.
 */
async function embedText(text) {
  const truncated = String(text || '').slice(0, MAX_CHUNK_CHARS).trim();
  if (!truncated) return null;

  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    try {
      const vec = await ollamaEmbedRaw(truncated);
      if (!vec || vec.length !== EMBED_DIM) {
        throw new Error(`Dimensi salah: dapat ${vec?.length}, harap ${EMBED_DIM}`);
      }
      return vec;
    } catch (err) {
      if (attempt === MAX_RETRY) {
        console.error(`  [EMBED ERROR] "${truncated.slice(0, 60)}…": ${err.message}`);
        return null;  // skip chunk ini, jangan crash seluruh build
      }
      await sleep(2000 * attempt);
    }
  }
  return null;
}

function ollamaEmbedRaw(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: OLLAMA_MODEL, prompt: text });
    const req  = http.request(
      {
        hostname: OLLAMA_HOST,
        port:     OLLAMA_PORT,
        path:     '/api/embeddings',
        method:   'POST',
        headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout:  OLLAMA_TIMEOUT,
      },
      res => {
        let raw = '';
        res.on('data', c => (raw += c));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(raw);
            if (!parsed.embedding) return reject(new Error('Ollama: tidak ada field embedding'));
            resolve(parsed.embedding);
          } catch (e) {
            reject(new Error(`Ollama JSON parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Ollama timeout')); });
    req.on('error',   e  => reject(e));
    req.write(body);
    req.end();
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function formatVec(vec) {
  // PostgreSQL vector literal: '[0.1,0.2,...]'
  return '[' + Array.from(vec).map(v => v.toFixed(8)).join(',') + ']';
}

function progress(done, total, label) {
  const pct  = Math.round((done / total) * 100);
  const bar  = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
  process.stdout.write(`\r  [${bar}] ${pct}% (${done}/${total}) ${label}    `);
}

// ── Ambil data dari DB ────────────────────────────────────────────────────────

async function fetchExerciseChunks(client) {
  // Ambil hint_text, quick_trick, speech_text dari exercises.
  // Hanya ambil yang tidak null dan tidak kosong.
  const { rows } = await client.query(`
    SELECT
      e.id          AS exercise_id,
      e.concept_id,
      c.level_id,
      e.hint_text,
      e.quick_trick,
      e.speech_text
    FROM exercises e
    JOIN concepts c ON c.id = e.concept_id
    WHERE c.level_id IS NOT NULL
    ORDER BY c.level_id, e.id
  `);

  const chunks = [];
  for (const row of rows) {
    const base = {
      exercise_id: row.exercise_id,
      concept_id:  row.concept_id,
      level_id:    row.level_id,
      explanation_id: null,
      source_table: 'exercises',
    };

    if (row.hint_text && row.hint_text.trim()) {
      chunks.push({ ...base, chunk_type: 'hint_text',   chunk_text: row.hint_text.trim() });
    }
    if (row.quick_trick && row.quick_trick.trim()) {
      chunks.push({ ...base, chunk_type: 'quick_trick', chunk_text: row.quick_trick.trim() });
    }
    if (row.speech_text && row.speech_text.trim()) {
      chunks.push({ ...base, chunk_type: 'speech_text', chunk_text: row.speech_text.trim() });
    }
  }
  return chunks;
}

async function fetchExplanationChunks(client) {
  const { rows } = await client.query(`
    SELECT id, concept_id, level_id, content, variants
    FROM explanations
    WHERE content IS NOT NULL
    ORDER BY level_id, id
  `);

  const chunks = [];
  for (const row of rows) {
    const base = {
      exercise_id:    null,
      concept_id:     row.concept_id,
      level_id:       row.level_id,
      explanation_id: row.id,
      source_table:   'explanations',
    };

    // Teks utama
    if (row.content && row.content.trim()) {
      chunks.push({ ...base, chunk_type: 'explanation', chunk_text: row.content.trim() });
    }

    // Variants (JSON array: [{content, approach_name, explanation_style}])
    if (row.variants) {
      try {
        const arr = typeof row.variants === 'string' ? JSON.parse(row.variants) : row.variants;
        if (Array.isArray(arr)) {
          for (const v of arr) {
            const vtext = (v.content || '').trim();
            if (!vtext) continue;
            const style = v.explanation_style || v.approach_name || 'variant';
            chunks.push({
              ...base,
              chunk_type:     `explanation_${style}`,
              chunk_text:     vtext,
              explanation_id: row.id,  // tetap link ke explanation induk
            });
          }
        }
      } catch (_) { /* skip malformed variants */ }
    }
  }
  return chunks;
}

// ── Cek chunk yang sudah ada di DB ───────────────────────────────────────────

async function fetchExistingKeys(client) {
  // Kumpulkan set unik key: "exercise_id:chunk_type" atau "explanation_id"
  // untuk skip chunk yang sudah diembed.
  const { rows } = await client.query(`
    SELECT
      exercise_id::text,
      explanation_id::text,
      chunk_type
    FROM explanations_embedding
    WHERE embedding_ready = true
  `);

  const keys = new Set();
  for (const r of rows) {
    if (r.exercise_id) {
      keys.add(`ex:${r.exercise_id}:${r.chunk_type}`);
    } else if (r.explanation_id) {
      keys.add(`expl:${r.explanation_id}:${r.chunk_type}`);
    }
  }
  return keys;
}

function chunkKey(chunk) {
  if (chunk.exercise_id) return `ex:${chunk.exercise_id}:${chunk.chunk_type}`;
  return `expl:${chunk.explanation_id}:${chunk.chunk_type}`;
}

// ── Insert batch ──────────────────────────────────────────────────────────────

async function insertBatch(client, batch) {
  if (batch.length === 0) return;

  // Karena pgvector membutuhkan cast ::vector(1024) yang tidak bisa diparameterisasi
  // secara langsung di multi-row insert, kita build query per-row tapi dalam
  // satu transaksi untuk efisiensi.
  //
  // Pendekatan: satu INSERT per row, tapi dalam BEGIN..COMMIT satu blok.
  // Untuk 200 rows ini tetap jauh lebih cepat dari 200 koneksi terpisah.
  await client.query('BEGIN');
  try {
    const stmt = `
      INSERT INTO explanations_embedding
        (level_id, concept_id, explanation_id, exercise_id,
         chunk_type, chunk_text, source_table, embedding, embedding_ready, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector(1024), true, NOW())
      ON CONFLICT DO NOTHING`;

    for (const { chunk, vec } of batch) {
      await client.query(stmt, [
        chunk.level_id,
        chunk.concept_id     || null,
        chunk.explanation_id || null,
        chunk.exercise_id    || null,
        chunk.chunk_type,
        chunk.chunk_text.slice(0, MAX_CHUNK_CHARS),
        chunk.source_table,
        formatVec(vec),
      ]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('═══════════════════════════════════════════════════');
  console.log('  build-rag-corpus.js — BGE-M3 1024-dim           ');
  console.log(`  Ollama: ${OLLAMA_HOST}:${OLLAMA_PORT} / ${OLLAMA_MODEL}`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (tidak ada embed/insert)' : 'LIVE'}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('');

  // 1. Test koneksi Ollama
  console.log('▶ Cek Ollama...');
  try {
    const testVec = await embedText('tes koneksi');
    if (!testVec || testVec.length !== EMBED_DIM) throw new Error('Dimensi tidak sesuai');
    console.log(`  ✓ Ollama OK — BGE-M3 dim=${testVec.length}`);
  } catch (err) {
    console.error(`  ✗ Ollama gagal: ${err.message}`);
    console.error('  Pastikan Ollama berjalan: ollama serve');
    process.exit(1);
  }

  // 2. Test koneksi DB
  console.log('▶ Cek database...');
  const client = await pool.connect();
  try {
    const { rows } = await client.query('SELECT COUNT(*) FROM exercises');
    console.log(`  ✓ DB OK — ${rows[0].count} exercises`);
  } catch (err) {
    console.error(`  ✗ DB gagal: ${err.message}`);
    process.exit(1);
  }

  // 3. Ambil semua chunks
  console.log('▶ Mengambil chunks dari database...');
  const exerciseChunks    = await fetchExerciseChunks(client);
  const explanationChunks = await fetchExplanationChunks(client);
  const allChunks         = [...explanationChunks, ...exerciseChunks];
  // explanations dulu agar yang pertama diembed adalah data paling penting

  console.log(`  Explanation chunks : ${explanationChunks.length}`);
  console.log(`  Exercise chunks    : ${exerciseChunks.length}`);
  console.log(`  Total              : ${allChunks.length}`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Selesai. Tidak ada data yang diinsert.');
    await pool.end();
    return;
  }

  // 4. Cek yang sudah ada (resume support)
  console.log('▶ Cek chunks yang sudah ada di DB (resume)...');
  const existingKeys = await fetchExistingKeys(client);
  const pending      = allChunks.filter(c => !existingKeys.has(chunkKey(c)));
  console.log(`  Sudah ada: ${existingKeys.size} | Perlu diembed: ${pending.length}`);

  if (pending.length === 0) {
    console.log('\n✓ Semua chunks sudah diembed. Tidak ada pekerjaan.');
    client.release();
    await pool.end();
    return;
  }

  // 5. Embed + insert loop
  console.log(`\n▶ Mulai embed (batch=${BATCH_SIZE})...\n`);
  const startTime = Date.now();
  let   done      = 0;
  let   skipped   = 0;
  let   batch     = [];

  for (const chunk of pending) {
    const vec = await embedText(chunk.chunk_text);
    if (!vec) { skipped++; done++; progress(done, pending.length, chunk.chunk_type); continue; }

    batch.push({ chunk, vec });

    if (batch.length >= BATCH_SIZE) {
      await insertBatch(client, batch);
      batch = [];
    }

    done++;
    progress(done, pending.length, chunk.chunk_type);
  }

  // Flush sisa batch
  if (batch.length > 0) {
    await insertBatch(client, batch);
  }

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins    = Math.floor(elapsed / 60);
  const secs    = elapsed % 60;

  console.log('\n');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  ✓ Selesai dalam ${mins}m ${secs}s`);
  console.log(`  Diembed : ${done - skipped} chunks`);
  console.log(`  Gagal   : ${skipped} chunks (lihat error di atas)`);
  console.log('═══════════════════════════════════════════════════');

  // 6. Verifikasi final
  const { rows: countRows } = await client.query(
    'SELECT chunk_type, COUNT(*) FROM explanations_embedding WHERE embedding_ready=true GROUP BY chunk_type ORDER BY chunk_type'
  );
  console.log('\n  Distribusi corpus:');
  for (const r of countRows) {
    console.log(`    ${r.chunk_type.padEnd(20)} : ${r.count}`);
  }

  client.release();
  await pool.end();
}

main().catch(err => {
  console.error('\n[FATAL]', err.message);
  process.exit(1);
});
