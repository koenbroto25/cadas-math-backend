-- 020: parent_children.linked_at (Neon sudah punya tabel versi lama tanpa kolom ini)
ALTER TABLE parent_children ADD COLUMN IF NOT EXISTS linked_at TIMESTAMPTZ NOT NULL DEFAULT now();
