// Sementara: verifikasi cepat skema + seed data uji. Hapus setelah dev stabil.
const db = require('./db');

async function main() {
  const tables = await db.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name"
  );
  console.log('Tables:', tables.rows.map((r) => r.table_name).join(', '));

  // Seed satu siswa uji (idempotent)
  await db.query(
    `INSERT INTO students (username, display_name, trial_level, current_level)
     VALUES ('test_siswa_01', 'Siswa Uji', 3, 3)
     ON CONFLICT (username) DO NOTHING`
  );

  const s = await db.query('SELECT id, username, trial_level, current_level FROM students WHERE username = $1', ['test_siswa_01']);
  console.log('Seeded student:', s.rows[0]);
}

main()
  .then(() => db.pool.end())
  .catch((e) => { console.error(e.message); db.pool.end(); process.exit(1); });
