/**
 * Migration runner untuk cadas_app_dev.
 *
 * - 001_initial_schema.sql : selalu dijalankan (idempotent).
 * - 002_pgvector.sql       : dijalankan HANYA bila extension 'vector'
 *   tersedia. Bila tidak, dilewati dengan WARNING (dev DB pakai
 *   image postgres:16 polos; production pakai pgvector/pgvector:pg16).
 *
 * Status migrasi dicatat di tabel _migrations.
 */
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function hasPgvector() {
  const r = await db.query(
    "SELECT 1 FROM pg_available_extensions WHERE name = 'vector'"
  );
  return r.rowCount > 0;
}

async function ensureMigrationsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function isApplied(name) {
  const r = await db.query('SELECT 1 FROM _migrations WHERE name = $1', [name]);
  return r.rowCount > 0;
}

async function markApplied(name) {
  await db.query('INSERT INTO _migrations (name) VALUES ($1) ON CONFLICT DO NOTHING', [name]);
}

async function run() {
  await ensureMigrationsTable();

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (await isApplied(file)) {
      console.log(`= ${file} — sudah diterapkan, dilewati`);
      continue;
    }

    if (file === '002_pgvector.sql' && !(await hasPgvector())) {
      console.log(
        `! ${file} — extension 'vector' TIDAK tersedia di instance Postgres ini.` +
          `\n  -> Dilewati. Layer semantic (pgvector) belum aktif; lexical search tetap jalan.` +
          `\n  -> Untuk mengaktifkan: jalankan Postgres via image 'pgvector/pgvector:pg16' lalu jalankan ulang migrate.`
      );
      continue; // tidak ditandai applied — akan dicoba lagi nanti
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    try {
      await db.query(sql);
      await markApplied(file);
      console.log(`+ ${file} — diterapkan`);
    } catch (err) {
      console.error(`x ${file} — GAGAL: ${err.message}`);
      process.exitCode = 1;
      break;
    }
  }
}

if (require.main === module) {
  run()
    .then(() => db.pool.end())
    .catch((err) => {
      console.error('Migration runner error:', err);
      db.pool.end();
      process.exit(1);
    });
}

module.exports = { run };
