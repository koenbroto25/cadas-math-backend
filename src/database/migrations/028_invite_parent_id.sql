-- ============================================================
-- 028_invite_parent_id.sql
-- A2: 1 kode invite aktif per parent + revoke explisit.
-- Kolom parent_id = pembuat kode (sisi Pintu 1).
-- Kode sisi anak (Pintu 2) memakai student_id (parent_id NULL).
-- Unik parsial: 1 baris aktif (belum used/expired/revoked) per parent.
-- ============================================================
ALTER TABLE invite_links
  ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES parents(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

-- 1 kode aktif per parent ditegakkan di accessService.createInvite (revoke-then-insert),
-- bukan via unique index (NOW() tidak IMMUTABLE sehingga tidak bisa di index predicate).
CREATE INDEX IF NOT EXISTS idx_invite_links_parent
  ON invite_links (parent_id);
