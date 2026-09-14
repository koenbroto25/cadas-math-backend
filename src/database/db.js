/**
 * db.js — PostgreSQL connection pool untuk cadas-app-backend.
 *
 * Dual-mode: pakai DATABASE_URL (Neon/Railway, selalu SSL) atau host/port
 * terpisah (localhost dev). Cukup ganti env vars, tidak perlu edit kode lagi.
 *
 * Production / Railway (Neon):
 *   DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
 *
 * Development (localhost):
 *   DB_HOST=localhost  DB_PORT=5432  DB_USER=postgres  DB_PASSWORD=postgres
 *   DB_NAME=cadas_app_dev  DB_SSL=true
 */
const { Pool } = require('pg');
require('dotenv').config();

const useNeon = !!process.env.DATABASE_URL;

const pool = useNeon
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      // NOTE: voeg GEEN 'options': '-c search_path=public' toe — de Neon pooler
      // (poort 5432 via -pooler host) blokkeert startup parameters. Default
      // search_path op Neon is al `"$user", public`, zodat plain `FROM <table>`
      // in de public schema werkt.
    })
  : new Pool({
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME     || 'cadas_app_dev',
      user:     process.env.DB_USER     || 'postgres',
      password: process.env.DB_PASSWORD || 'postgres',
      ssl:      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 10,
    });

pool.on('connect', () => {
  const label = useNeon ? 'Neon' : (process.env.DB_NAME || 'cadas_app_dev');
  console.log('Connected to PostgreSQL database:', label);
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle PostgreSQL client', err);
  process.exit(-1);
});

module.exports = {
  query:    (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool,
};
