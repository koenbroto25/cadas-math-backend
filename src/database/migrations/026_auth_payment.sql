-- ============================================================
-- 026_auth_payment.sql
-- Auth & Payment — model "paket sebagai kredit level, jangkar = placement"
-- (Placement_Test_System.md §13.5, dikonfirmasi owner 2026-09-22)
--
-- Model:
--   - Ortu membeli PAKET: 'level_1' (Rp40.000) atau 'level_3' (Rp100.000 promo).
--   - Pembelian TIDAK menentukan rentang level. Rentang 100% ditentukan
--     placement test (placed_level = X, maks 9).
--   - Jika ortu bayar SEBELUM placement test anak → kredit menggantung
--     di purchases.status='pending' + students.pending_levels.
--     Aktif otomatis saat placement selesai:
--       scope aktif = [X .. X + total_level_count - 1]
--   - Top-up berikutnya selalu mulai dari (scope tertinggi saat ini + 1)
--     → mustahil overlap. Paket pasti terpakai karena placed_level maks 9.
--
-- Catatan: akses latihan tetap memakai kolom existing students
--   paid_basic_up_to_level (dibaca level-access.js). Service aktivasi
--   yang men-set kolom ini dari purchases — satu sumber kebenaran transaksi.
-- ============================================================

-- ── Kredit menggantung di students ──────────────────────────────────────────
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS pending_levels INT NOT NULL DEFAULT 0;

-- ── purchases: satu baris per pembelian paket ───────────────────────────────
CREATE TABLE IF NOT EXISTS purchases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- student boleh NULL (Pintu 1: ortu beli dulu, anak belum terdaftar/linked)
    student_id UUID REFERENCES students(id) ON DELETE SET NULL,
    parent_id UUID REFERENCES parents(id) ON DELETE SET NULL,
    -- 'level_1' | 'level_3'
    package TEXT NOT NULL CHECK (package IN ('level_1', 'level_3')),
    level_count INT NOT NULL CHECK (level_count IN (1, 3)),
    amount_idr INT NOT NULL CHECK (amount_idr IN (40000, 100000)),
    -- 'pending'  : kredit menggantung (menunggu placement anchor)
    -- 'active'   : sudah dikonversi jadi scope level
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active')),
    -- anchor dari placement (diisi saat aktivasi)
    anchor_level INT,
    level_from INT,              -- level pertama dalam scope (inklusif)
    level_to INT,                -- level terakhir dalam scope (inklusif)
    -- 'manual_transfer' untuk sekarang; gateway menyusul (sesi terpisah)
    payment_method TEXT NOT NULL DEFAULT 'manual_transfer',
    proof_url TEXT,
    is_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
    confirmed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    -- Paket 'pending' harus punya pemilik kredit minimal satu sisi
    CONSTRAINT purchases_pending_has_owner
        CHECK (status <> 'pending' OR student_id IS NOT NULL OR parent_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_purchases_student
    ON purchases (student_id, status);
CREATE INDEX IF NOT EXISTS idx_purchases_parent
    ON purchases (parent_id, status);

-- ── invite_links: anak mengajak ortu (QR / share link) ──────────────────────
CREATE TABLE IF NOT EXISTS invite_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code TEXT UNIQUE NOT NULL,
    -- Pintu 2: anak yang mengundang
    student_id UUID REFERENCES students(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL DEFAULT 'parent_invite',
    expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    used_by_parent UUID REFERENCES parents(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invite_links_student
    ON invite_links (student_id);
