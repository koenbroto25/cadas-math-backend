# LAPORAN BACKTEST: INSERTION `student_variant_bias` & REFACTORED PLACEMENT ENGINE

**Tanggal Laporan:** 9 September 2026 (revisi 5 — setelah Sprint C; live 10 September 2026)   
**Modul yang Diuji:** `src/routes/placement.js`, Tabel PostgreSQL `student_variant_bias`, `placement_tests`, dan endpoint `/status`  
**Status Pengujian:** **BERHASIL (PASSED)**

---

## 1. RINGKASAN EKSEKUTIF
Backtest dilakukan untuk memvalidasi fitur penyisipan data bias ke tabel `student_variant_bias` setelah tes penempatan (`placement`) selesai disubmit oleh siswa. Revisi 2 mencakup Sprint A yang memperbaiki tiga item terbuka dari revisi 1:
1. **Fix `correct_count` per-skill** — sebelumnya nilai dihitung dari agregat seluruh test (artefak `2/10`), kini dihitung dari `evaluatedAnswers` yang difilter per `skillArea` (hasil riil: `1/6`).
2. **Backfill `concept_id`** — 148 exercises probe set (`L8_P2_*`, `l10_*`, dll.) yang `concept_id`-nya NULL kini terisi; `variant_type` tidak lagi jatuh ke `'general'` melainkan memakai concept code asli (`ADD_SUB_2DIGIT_L8`).
3. **Verifikasi endpoint `GET /api/placement/status/:studentId`** — terbukti **sudah benar sejak awal** (memakai `started_at`/`completed_at`, bukan `created_at`); error sebelumnya berasal dari script test, bukan endpoint. Live-tested sukses.

---

## 2. SKENARIO PENGUJIAN (BACKTEST RUN — REVISI 2)

Skenario backtest dijalankan secara end-to-end melalui REST API backend (`/api/placement/start` & `/api/placement/submit`):
* **Student ID:** `8f218a1b-12e3-46fc-999a-e28ea6b5a114`
* **Jumlah Probe Soal:** 10 soal
* **Komposisi Jawaban Simulasi:**
  * 5 Soal Pertama: Dijawab **Benar** (`correct_answer` diambil langsung dari database).
  * 5 Soal Terakhir: Dijawab **Salah** (`9999`).

---

## 3. HASIL BACKTEST & VERIFIKASI DATABASE

### A. Hasil Response API `/api/placement/submit`
```json
{
  "placedLevel": 10,
  "correctAnswers": 5,
  "totalAnswers": 10,
  "prerequisiteSignals": {
    "ADD_SUB_2DIGIT_L8": 0.83
  }
}
```

### B. Verifikasi Tabel `placement_tests`
```json
{
  "placed_level": 10,
  "prerequisite_signals": {"ADD_SUB_2DIGIT_L8": 0.83},
  "status": "completed"
}
```

### C. Verifikasi Tabel `student_variant_bias` (per-skill — PERBAIKAN UTAMA REVISI 2)
```text
bias rows: 1
  ADD_SUB_2DIGIT_L8: 1/6 (17.00)
```
**Interpretasi:** dari 10 soal, 6 soal berasal dari concept `ADD_SUB_2DIGIT_L8` (level 8) dengan 1 benar / 5 salah → weakness = 5/6 = 0.83 ✓. Sisanya 4 soal level 10 (`lvl10`) semuanya benar → akurasi 100% → tidak menjadi signal (perilaku benar, karena hanya level dengan accuracy < 80% yang dihitung sebagai kelemahan). Ini konsisten dengan `correct=5/10` (1 dari level 8 + 4 dari level 10).

### D. Verifikasi Endpoint `GET /api/placement/status/:studentId` (BARU di revisi 2)
```text
STATUS OK: status=completed placedLevel=10 placementId=13244527-0a81-4bbb-8fec-6c9ab1b79343
```

---

## 4. PERBAIKAN YANG DITERAPKAN (KUMULATIF)

| # | Perbaikan | Revisi |
|---|-----------|--------|
| 1 | Query `/submit`: `e.source_id = ANY($1)` → `e.id = ANY($1)` (parameter = array UUID) | 1 |
| 2 | Perbandingan jawaban via `parseFloat()` (menangani `"126.00"` vs `"126"`) | 1 |
| 3 | `skillArea` dari `LEFT JOIN concepts` → `COALESCE(c.code, 'general') as skill_code` | 1 |
| 4 | Rumus weakness dikoreksi: `count/items.length` (fraksi salah, sebelumnya terbalik) | 1 |
| 5 | Remedial fallback (`isRemedial`) saat placedLevel=1 | 1 |
| 6 | `prerequisite_signals` ikut disimpan ke `placement_tests` | 1 |
| 7 | Insert `student_variant_bias` dengan upsert `ON CONFLICT DO UPDATE` | 1 |
| 8 | **`correct_count`/`total_attempts` per-skill** dari `evaluatedAnswers` yang difilter per skillArea | 2 |
| 9 | **Backfill `concept_id`** 148 exercises (match by `level_id` — aman karena 1 concept/level) | 2 |
| 10 | Housekeeping: hapus `upgrade-test.js.backup.20260909_141218` | 2 |

## 5. KESIMPULAN
Seluruh verifikasi revisi 2 **PASSED**. Fase 4 (Placement Test & Variant Bias) kini sepenuhnya hijau:
pipeline placement → prerequisite signals → `student_variant_bias` bekerja end-to-end dengan data
per-skill yang akurat, dan endpoint `/status` terverifikasi hidup.

---

## 6. TAMBAHAN REVISI 3 — SPRINT B: SCHEMA MISMATCH FASE 5/8

**Temuan:** kode konsumen `student_variant_bias` (selection rule + RAG pipeline) ditulis terhadap
skema spesifikasi yang tidak cocok dengan DB aktual — endpoint `select-variant`, `quota`, `ask`,
`record-shown`, `record-helpful` semuanya akan error SQL.

**Perbaikan:** rewrite `selection-rule.js` (Step 1 performance, Step 2 placement bias, record
functions, getAvailableVariants) ke skema aktual; fix `pipeline.js` (lexical search tanpa pg_trgm +
cari di `variants` JSON, cache tanpa `question_hash`, quota kolom aktual, log biaya ke
`llm_usage_log`); hapus duplikasi Pool di `rag.js` & `level-access.js`.

**Backtest revisi 3 (live — semua PASSED):**
```
select-variant (bias 17% L8)     → quick, source=placement, offerFromAttempt=1
select-variant (effectiveness)   → gasing, source=performance, effectiveness=1
select-variant (student kosong)  → main, source=default, attempt 1
record-shown/record-helpful      → success, row effectiveness terbuat
quota                            → used=0 limit=40 remaining=40
/api/rag/ask lexical (basic)     → source=lexical, jawaban dari variants JSON
/api/rag/ask cache               → cached=true
/api/rag/ask not-found           → pesan generik, tidak di-cache
/api/rag/ask locked level        → HTTP 403 PREMIUM_REQUIRED
```

**Sisa terbuka:** PracticeScreen belum memanggil select-variant (Fase 5 frontend); semantic search
masih placeholder (embedding kosong, dim 384 vs kolom 768); trial level belum di-grant otomatis.

---

## 7. TAMBAHAN REVISI 4 — 3 ITEM LANJUTAN (PracticeScreen wiring, semantic search, trial gate)

Semua item lanjutan dari revisi 3 telah dikerjakan & diuji:

**Item 1 — PracticeScreen → select-variant (SELESAI ✅)**
- `src/routes/exercises.js`: response kini menyertakan `concept_id` + `concept_code` (JOIN concepts).
- `src/services/api.js`: tambah `selectVariant`, `recordVariantShown`, `recordVariantHelpful`.
- `src/screens/PracticeScreen.jsx`: fetch varian per soal via selection rule; saat bias
  placement/performance menyarankan varian (mis. Quick), eskalasi hint dipercepat
  (`offerFromAttempt`); `record-shown` saat tampil, `record-helpful` saat siswa menjawab benar —
  feedback loop effectiveness tertutup.

**Item 2 — Semantic search berfungsi (SELESAI ✅)**
- `generateEmbedding`: hash sederhana → **hashing-trick bag-of-words** 384 dim (cocok kolom
  `vector(384)` aktual), L2-normalize.
- `explanations_embedding` di-backfill **15/15** (chunk = content + seluruh variants).
- Threshold dikalibrasi ke data aktual: terkait 0.28–0.50, tak terkait 0.03–0.06.
  strong ≥ 0.25, partial ≥ 0.20.
- Live test `/api/rag/ask` (paraphrase, ILIKE dijamin gagal):
  - "garis bilangan melompat... angka dua" → `source=semantic` ✓
  - "kalau ibu kasih permen tambah satu" → `source=semantic` ✓
  - "resep rendang" / "berita cuaca" → `source=none` (tidak menjawab di luar topik) ✓

**Item 3 — Trial level (KEPUTUSAN DESAIN — tidak diubah)**
- `final_plan.md` OVERRIDE + `CADAS_APP_ADDENDUM_v1.md` menegaskan: `trial_level` hanya untuk
  tampilan ("kamu cocok mulai dari level X"), **bukan** gerbang akses gratis.
- `getLevelAccess` saat ini (hanya `paid_basic`/`paid_premium`) sudah konsisten desain.
- Keputusan: tidak ada perubahan kode; perilaku dipertahankan.

**Ringkasan status akhir Sprint B lanjutan:**
```
Fase 5 (Practice Loop) backend+frontend  → ✅ (selection rule wired)
Fase 8 (RAG Pipeline & AskKak) backend   → ✅ (semantic berfungsi)
Catatan produksi                         → ganti embedder hashing-trick ke model nyata (jaga dim 384)

---

## 8. TAMBAHAN REVISI 5 — SPRINT C: BILLING, GATE AKSES, & ASKKAK PREMIUM

Sprint C menutup Fase 6 dan menyelaraskan keputusan gate akses yang sebelumnya terdistribusi:
1. **Harga paywall frontend** (`UpgradePaywallScreen.jsx`) disinkronkan dengan backend:
   `single Rp40.000`, `basicBundle Rp100.000`, `premiumBundle Rp165.000` (bug sebelumnya:
   `45k/120k/115k`, di mana Premium lebih murah dari Basic).
2. **Route admin billing diperbaiki.** Router `payment.js` sudah di-mount di `/api/admin`; path
   internal yang sebelumnya `/admin/billing/...` menghasilkan URL double-prefix
   `/api/admin/admin/billing/...` (404). Path internal diganti `/billing/...`, sehingga endpoint
   `/api/admin/billing/activate` dan `/api/admin/billing/status/:student_id` benar-benar reachable.
3. **Otentikasi admin dikonfirmasi.** Kedua endpoint admin memakai header `x-admin-secret` dan
   membandingkannya dengan `process.env.ADMIN_SECRET`; secret salah menghasilkan 401.
4. **`getLevelAccess` diselaraskan.** Helper lokal di `upgrade-test.js` dihapus dan route memakai
   shared `../middleware/level-access`; helper lokal di `index.js` dihapus. Gate kini hanya membaca `paid_*`
   `premium > basic`; `trial_level` tetap menjadi nilai tampilan saja.
5. **AskKak premium diverifikasi.** Saat siswa telah aktif premium, tier premium menghasilkan `tier=premium`; karena
   `OPENROUTER_API_KEY` di `.env` masih placeholder, pipeline mengambil fallback graceful
   (`source=fallback`) tanpa crash.

### Backtest Sprint C (live, 10 September 2026)

```text
POST /api/admin/billing/activate (secret salah) → 401
POST /api/admin/billing/activate (secret benar) → 200; paid_basic_up_to_level=8;
                                                   payment_records tercatat
GET  /api/admin/billing/status/:student_id      → 200; history=1
upgrade-test level 8  (sebelum bayar)           → 403
upgrade-test level 8  (setelah basic)           → 200; 35 soal
upgrade-test level 12 (sebelum premium)         → 403
upgrade-test level 12 (setelah premium)         → 200; 20 soal
/api/rag/ask (basic aktif, L1)                  → source=lexical, tier=basic
/api/rag/ask (premium aktif, L8)                → tier=premium, source=openrouter ✅
```

#### Integrasi OpenRouter (Final Sprint C)
5 API key OpenRouter (`OPENROUTER_API_KEY_1.._5`) berhasil diintegrasikan ke
`openrouter-client.js` dengan fitur:
- **Rotasi key otomatis:** sequential rotation dengan prioritas `OPENROUTER_API_KEYS` >
  `OPENROUTER_API_KEY` > `OPENROUTER_API_KEY_1.._5`.
- **Retry on failure:** saat key gagal (401/402/429), otomatis coba key berikutnya
  (maksimal 3 retry). Validasi: key pertama (402 insufficient credits) → key kedua berhasil.
- **Model default:** `openai/gpt-4o-mini` (gratis, cepat, cocok untuk edukasi matematika).
  Model `google/gemini-2.0-flash-001` tidak tersedia di OpenRouter (404).
- **Live test result:** `source=openrouter`, `tier=premium`, jawaban LLM 972 karakter
  tentang pecahan ½ + ¼ — membuktikan Layer 3 berfungsi penuh.

Setelah backtest, seluruh data siswa test dibersihkan: `paid_basic_up_to_level=NULL`,
`paid_premium_up_to_level=NULL`, `payment_records=0`, dan `student_questions=0`.

**Status Sprint C:** **PASSED / CLOSED.**

