# cadas-app-backend

Backend Express untuk Cadas App — mengikuti `final_plan.md` (FASE 2) dengan
override dari `CADAS_APP_ADDENDUM_v1.md`.

## Status (FASE 2–3 — 8 Sep 2026)

**FASE 2 ✅ Selesai**
- [x] 2.1 Project init (`express pg dotenv jsonwebtoken bcryptjs cors`), `src/index.js`, `GET /api/health`
- [x] 2.2 Database `cadas_app_dev` dibuat di container `material_generator_db` (sama dengan speed-math-master, database terpisah)
- [x] 2.2 Skema tabel konten + siswa + parent/guru + billing + RAG (migration runner idempotent, status di tabel `_migrations`)
- [x] 2.3 **ETL konten selesai** — 15 level, 15 konsep, 15 explanations (steps+variants), 5.446 exercises, 120 segmen audio level + viseme JSON (backtest 9/9 lulus); `content_release_log` tercatat otomatis per eksekusi ETL
- [x] 2.4 **Endpoint dasar teruji** — `GET /api/exercises/:level`, `GET /api/exercises/item/:id`, `POST /api/progress/session`, `GET /api/progress/:studentId` (modul `src/routes/`); plus static `/exercises/*.html`, `/audio/*`, dan `GET /api/tts/:id?type=hint|trick` (404 → fallback teks)
- [x] Stub endpoint `GET /api/billing/status/:student_id` (respons sudah mengikuti model granular per-level)
- [x] 2.5 cadas-app: `services/api.js` sudah pakai `EXPO_PUBLIC_API_URL`; **sisa: uji manual PracticeScreen di emulator** (`npm start` di backend + `npx expo start` di cadas-app)

**FASE 3 ✅ Backend selesai (3.1), UI menyusul**
- [x] 3.1 **Backend auth** — 9 endpoint teruji 16/16 lulus: `student/register`, `parent/register|login`, `teacher/register|login`, `parent-gate/challenge|verify`, `me`
- [x] JWT middleware (`signToken(payload, ttl?)`, `verifyToken`, `requireRole`)
- [x] Skema auth: `parents.password_hash` + `parents.email` + `parents.phone` (nullable, partial unique); `teachers.password_hash`; `students.pin_hash` (migration 006, 007, 008)
- [ ] 3.2 Navigasi App.jsx (AuthStack/StudentStack/ParentStack/TeacherStack)
- [ ] 3.3 Alur onboarding (setelah FASE 4 placement test)

**Sisa FASE 2–3**
- [ ] Uji manual `PracticeScreen` di emulator/device
- [ ] Folder modul per `[V3]` §3.2 — sebagian: `routes/exercises.js`, `routes/progress.js`, `routes/auth.js` ✅; sisa fasttrack/, rag/, billing/, parent/, teacher/, referral/ (FASE 4+)

## Pendekatan migrasi: copy-with-transform (bukan copy mentah)

Kedua DB ada di instance Postgres yang sama (container `material_generator_db`),
jadi "copy paste" murni lokal dan instan (ETL penuh ≈ 4 detik). Copy mentah
(pg_dump→restore) TIDAK dipakai karena skema/format ID sumber berbeda
(ID legacy `l1_1`, tanpa tabel levels/concepts, variant milik penjelasan).

```bash
npm install
npm start           # server di PORT=3000
npm run dev         # watch mode
npm run migrate     # 001-008 (002 pgvector — otomatis dilewati bila tidak ada)
node src/database/migrate-content.js         # ETL konten (idempotent, re-run aman)
node src/database/backfill-exercise-audio.js # voice per-soal (resumable, jalankan ulang kapan pun)
node src/database/backtest-content.js        # backtest konten + voice
node src/test/test-auth.js --auto            # uji auth 16 skenario (start/stop server otomatis)
```

## Migrasi voice BERTAHAP

| Fase | Isi | Status |
|---|---|---|
| 1 | Segmen audio konsep level (`L{n}_{seg}.wav` + viseme JSON) → tabel `level_audio_segments` | ✅ 120/120, WAV & viseme tervalidasi di disk |
| 2 | Cache TTS per soal (`{source_id}_hint.wav`/`_trick.wav`) → tabel `exercise_audio` | ⚠️ ~56% (3.053/5.446 soal) — jalankan ulang `backfill-exercise-audio.js` setiap precache di speed-math-master bertambah |

Soal tanpa audio di fase 2 → fallback teks + pesan upgrade (perilaku sesuai
V3.1 §10.1), atau generate on-demand via endpoint `/api/tts/{id}` di
speed-math-master. Tidak ada biaya — semua berjalan lokal.

## Verifikasi & backtest

- `node src/database/backtest-content.js` — 9 check, termasuk **pembandingan
  penuh 5.446 soal field-per-field vs sumber** (bukan sampling). Wajib
  dijalankan ulang setiap kali ETL dijalankan ulang atau sumber berubah.
- `node src/database/verify-source-intact.js` — verifikasi SUMBER
  (material_generator_dev) tidak berubah vs baseline pra-ETL.

## Override Addendum v1 yang sudah diterapkan di skema

1. `students.is_premium` TIDAK ADA — diganti `paid_basic_up_to_level` + `paid_premium_up_to_level` (per-level, dua tingkat)
2. `student_questions.llm_model` default `'openrouter'`, `source IN ('lexical','semantic','openrouter')` — bukan ollama
3. `referrers.commission_model` default `'per_transaction'` — bukan recurring bulanan

## Catatan

- `src/database/verify-seed.js`, `check-voice-status.js`, `inspect-source.js` adalah skrip dev — hapus saat stabil.
- Kontak WA admin di response billing diambil dari `ADMIN_WHATSAPP` env.
- **pgvector (dev):** container Postgres saat ini image `postgres:16` polos,
  jadi `002_pgvector.sql` dilewati otomatis — Layer semantic belum aktif,
  Layer lexical tetap jalan. Untuk mengaktifkan: ganti image ke
  `pgvector/pgvector:pg16` (volume tetap `./pgdata`), restart container,
  lalu `npm run migrate` ulang.

## Audit voice speed-math-master (8 Sep 2026) — dasar keputusan migrasi bertahap

- ✅ Audio konsep per level: 120/120 DB↔manifest↔disk sinkron (L8 regen selesai)
- ✅ Teks: 5.446/5.446 soal punya `problem_text` + `speech_text`
- ⚠️ TTS cache per-soal: ~56% (hint 2.849/5.446, trick 2.983/5.446)

**Konsekuensi:** TIDAK blocking FASE 2.3. Audio dilayani via URL konvensi
`{base}/audio/speech/cache/{id}_hint.wav`; file belum ada → fallback teks +
pesan upgrade (perilaku sesuai V3.1 §10.1), atau generate on-demand via
endpoint `/api/tts/{id}` di speed-math-master. Menutup sisa cache:
`node scripts/precache-all-tts.js` di speed-math-master (resumable), lalu
jalankan ulang `backfill-exercise-audio.js` di sini.


