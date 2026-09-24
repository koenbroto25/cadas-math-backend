/**
 * accessService — model "paket sebagai kredit level, jangkar = placement"
 * (Placement_Test_System.md §13.5, dikonfirmasi owner 2026-09-22)
 *
 * Aturan inti:
 *   1. Ortu membeli PAKET: 'level_1' (Rp40.000) atau 'level_3' (Rp100.000 promo).
 *   2. Rentang level TIDAK dipilih ortu — 100% ditentukan placement test.
 *   3. Beli sebelum placement → kredit menggantung (purchases.status='pending').
 *      Aktif otomatis saat placement selesai:
 *        scope paket #1 = [X .. X+count-1], paket berikutnya menyambung.
 *   4. Top-up saat anchor sudah ada → langsung aktif mulai
 *      (paid_basic_up_to_level + 1) → mustahil overlap.
 *   5. Paket pasti terpakai karena placed_level maksimal 9.
 *   6. Akses latihan dibaca dari kolom existing students.paid_basic_up_to_level
 *      (level-access.js) — service ini satu-satunya penulis dari purchases.
 */

const PRICING = {
  level_1: { level_count: 1, amount_idr: 40000 },
  level_3: { level_count: 3, amount_idr: 100000 }, // promo paket 3 level
};

const MAX_PLACEMENT_LEVEL = 9; // selaras placementEngine.MAX_LEVEL

// ── Helper ────────────────────────────────────────────────────────────────────

/** Anchor placement siswa: placed_level dari placement test terakhir, atau null. */
async function getPlacementAnchor(db, studentId) {
  const r = await db.query(
    `SELECT placed_level FROM placement_tests
     WHERE student_id = $1 AND status = 'completed'
     ORDER BY completed_at DESC NULLS LAST, started_at DESC
     LIMIT 1`,
    [studentId]
  );
  return r.rows[0]?.placed_level ?? null;
}

/** Scope tertinggi yang sudah aktif (paid_basic_up_to_level), atau null. */
async function getCurrentScopeEnd(db, studentId, tier = 'basic') {
  const column = tier === 'premium' ? 'paid_premium_up_to_level' : 'paid_basic_up_to_level';
  const r = await db.query(`SELECT ${column} FROM students WHERE id = $1`, [studentId]);
  return r.rows[0]?.[column] ?? null;
}

/**
 * Konversi SEMUA kredit pending milik siswa menjadi scope level berurutan,
 * dijangkarkan di placedLevel. Idempotent (kredit aktif tidak disentuh).
 *
 * @returns {{activated: Array, scope_end: number|null}}
 */
async function activatePendingPurchases(db, studentId, placedLevel) {
  const anchor = parseInt(placedLevel, 10);
  if (!Number.isInteger(anchor) || anchor < 1 || anchor > MAX_PLACEMENT_LEVEL) {
    throw new Error(`anchor_level (placed) tidak valid: ${placedLevel}`);
  }
  const pending = await db.query(
    `SELECT id, level_count, COALESCE(tier, 'basic') AS tier
     FROM purchases
     WHERE student_id = $1 AND status = 'pending'
       AND (is_confirmed = TRUE OR payment_method <> 'qris_midtrans')
     ORDER BY created_at ASC FOR UPDATE`,
    [studentId]
  );
  const currentBasic = await getCurrentScopeEnd(db, studentId, 'basic');
  const currentPremium = await getCurrentScopeEnd(db, studentId, 'premium');
  const cursors = {
    basic: currentBasic ?? anchor - 1,
    premium: currentPremium ?? anchor - 1,
  };
  const activated = [];
  for (const p of pending.rows) {
    const tier = p.tier === 'premium' ? 'premium' : 'basic';
    const levelFrom = cursors[tier] + 1;
    const levelTo = cursors[tier] + p.level_count;
    await db.query(
      `UPDATE purchases SET status='active', anchor_level=$2, level_from=$3, level_to=$4,
       activated_at=NOW() WHERE id=$1`,
      [p.id, anchor, levelFrom, levelTo]
    );
    cursors[tier] = levelTo;
    activated.push({ purchase_id: p.id, tier, level_from: levelFrom, level_to: levelTo });
  }
  if (activated.length) {
    const basicActivated = activated.some(x => x.tier === 'basic');
    const premiumActivated = activated.some(x => x.tier === 'premium');
    if (basicActivated) {
      await db.query('UPDATE students SET paid_basic_up_to_level=$2 WHERE id=$1', [studentId, cursors.basic]);
    }
    if (premiumActivated) {
      await db.query('UPDATE students SET paid_premium_up_to_level=$2 WHERE id=$1', [studentId, cursors.premium]);
    }
    await db.query('UPDATE students SET pending_levels=0 WHERE id=$1', [studentId]);
  } else {
    await db.query('UPDATE students SET pending_levels=0 WHERE id=$1 AND pending_levels<>0', [studentId]);
  }
  return { activated, scope_end: cursors.basic, premium_scope_end: cursors.premium };
}

/**
 * Beli paket.
 *  - student sudah placement → purchase LANGSUNG aktif (scope menyambung).
 *  - student belum placement / student_id NULL → purchase 'pending'
 *    (kredit menggantung, aktif otomatis setelah placement / redeem).
 *
 * Catatan pembayaran: endpoint ini mensimulasikan pembayaran sukses
 * (is_confirmed = true). Gateway asli (Midtrans/Xendit) menyusul di
 * sesi terpisah — flow konfirmasi admin tidak perlu diubah nanti.
 */
async function createPurchase(db, { studentId = null, parentId = null, packageName }) {
  const pkg = PRICING[packageName];
  if (!pkg) {
    throw Object.assign(new Error(`Paket tidak dikenal: ${packageName}`), { status: 400 });
  }

  let status = 'pending';
  let scope = null;

  if (studentId) {
    const anchor = await getPlacementAnchor(db, studentId);
    if (anchor !== null) {
      // Anchor sudah ada → scope pasti: mulai dari scope terakhir + 1
      const scopeEnd = await getCurrentScopeEnd(db, studentId);
      const levelFrom = (scopeEnd ?? anchor - 1) + 1;
      const levelTo = levelFrom + pkg.level_count - 1;
      status = 'active';

      const ins = await db.query(
        `INSERT INTO purchases
           (student_id, parent_id, package, level_count, amount_idr,
            status, anchor_level, level_from, level_to, is_confirmed, confirmed_at, activated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, $8, TRUE, NOW(), NOW())
         RETURNING id, level_from, level_to`,
        [studentId, parentId, packageName, pkg.level_count, pkg.amount_idr,
         anchor, levelFrom, levelTo]
      );
      scope = ins.rows[0];

      const newEnd = Math.max(scopeEnd ?? 0, levelTo);
      await db.query(
        `UPDATE students SET paid_basic_up_to_level = $2, pending_levels = 0
         WHERE id = $1`,
        [studentId, newEnd]
      );
      scope.scope_end = newEnd;
    }
  }

  if (status === 'pending') {
    const ins = await db.query(
      `INSERT INTO purchases
         (student_id, parent_id, package, level_count, amount_idr, status, is_confirmed, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, 'pending', TRUE, NOW())
       RETURNING id`,
      [studentId, parentId, packageName, pkg.level_count, pkg.amount_idr]
    );
    scope = ins.rows[0];

    // Kredit menggantung tercatat di students.pending_levels (per student)
    if (studentId) {
      await db.query(
        `UPDATE students
         SET pending_levels = pending_levels + $2
         WHERE id = $1`,
        [studentId, pkg.level_count]
      );
    }
  }

  return {
    purchase_id: scope.id,
    package: packageName,
    level_count: pkg.level_count,
    amount_idr: pkg.amount_idr,
    status,
    ...(scope.level_from && {
      level_from: scope.level_from,
      level_to: scope.level_to,
      scope_end: scope.scope_end,
    }),
  };
}

/** Ringkasan akses siswa: scope aktif, kredit menggantung, titik top-up berikutnya. */
async function getAccessSummary(db, studentId) {
  const s = await db.query(
    `SELECT COALESCE(paid_basic_up_to_level, 0) AS scope_end, pending_levels
     FROM students WHERE id = $1`,
    [studentId]
  );
  if (s.rowCount === 0) {
    throw Object.assign(new Error('student tidak ditemukan'), { status: 404 });
  }
  const anchor = await getPlacementAnchor(db, studentId);
  const history = await db.query(
    `SELECT id, package, level_count, amount_idr, status, anchor_level,
            level_from, level_to, created_at
     FROM purchases WHERE student_id = $1
     ORDER BY created_at ASC`,
    [studentId]
  );

  const scopeEnd = s.rows[0].scope_end;
  return {
    student_id: studentId,
    placement_anchor: anchor,
    scope: anchor && scopeEnd >= anchor
      ? { from: anchor, to: scopeEnd }
      : null,
    scope_end: scopeEnd > 0 ? scopeEnd : null,
    pending_levels: s.rows[0].pending_levels,
    next_purchase_starts_at: (scopeEnd || (anchor ? anchor - 1 : 0)) + 1,
    packages: history.rows,
  };
}

/**
 * Invite code — dipakai di kedua pintu:
 *   - Pintu 2 (anak dulu): anak membuat kode (student_id) → ortu redeem via
 *     link web https://cadasmatematika.web.id/parent/join?code=XXXXXX → auto-link.
 *   - Pintu 1 (ortu dulu): ortu membuat kode (parent_id, student_id NULL) →
 *     anak daftar + redeem → kredit pending ortu dipindahkan ke siswa tersebut.
 * Aturan A2 (2026-09-23): 1 kode aktif per parent; "Buat baru" me-revoke yang lama.
 */
async function createInvite(db, { studentId = null, parentId = null, ttlHours = 72 }) {
  if (!studentId && !parentId) {
    throw Object.assign(new Error('student_id atau parent_id wajib salah satu'), { status: 400 });
  }
  const code = 'CADAS-' + require('crypto').randomBytes(4).toString('hex').toUpperCase();
  // Revoke kode aktif lama milik pembuat yang sama (1 aktif per parent/student)
  if (parentId) {
    await db.query(
      `UPDATE invite_links SET revoked_at = NOW()
       WHERE parent_id = $1 AND used_at IS NULL AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [parentId]
    );
  } else if (studentId) {
    await db.query(
      `UPDATE invite_links SET revoked_at = NOW()
       WHERE student_id = $1 AND parent_id IS NULL AND used_at IS NULL AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [studentId]
    );
  }
  const r = await db.query(
    `INSERT INTO invite_links (code, student_id, parent_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)
     RETURNING id, code, expires_at`,
    [code, studentId, parentId, String(ttlHours)]
  );
  return { invite_id: r.rows[0].id, code: r.rows[0].code, expires_at: r.rows[0].expires_at };
}

/**
 * Redeem kode undangan.
 *  1. Validasi kode (ada, belum dipakai, belum kedaluwarsa).
 *  2. Tentukan siswa: dari kode (Pintu 2) atau param (Pintu 1).
 *  3. Link parent ↔ child, tandai kode terpakai.
 *  4. Pindahkan kredit pending ortu (purchases.student_id NULL, parent_id = X)
 *     ke siswa ini + perbarui students.pending_levels.
 *
 * @returns {{linked: boolean, transferred_levels: number, student_id}}
 */
/** Transfer semua purchase parent yang sudah lunas ke siswa. */
async function attachPaidPurchasesToStudent(db, parentId, studentId) {
  const moved = await db.query(
    `UPDATE purchases SET student_id=$2
     WHERE parent_id=$1 AND student_id IS NULL AND status='pending' AND is_confirmed=TRUE
     RETURNING id, level_count, COALESCE(tier,'basic') AS tier`,
    [parentId, studentId]
  );
  const total = moved.rows.reduce((n, p) => n + p.level_count, 0);
  if (total) {
    await db.query('UPDATE students SET pending_levels=pending_levels+$2 WHERE id=$1', [studentId, total]);
  }
  return { purchase_ids: moved.rows.map(p => p.id), transferred_levels: total };
}

async function redeemInvite(db, { code, parentId, studentId = null }) {
  const r = await db.query(
    'SELECT id, student_id, parent_id AS maker_parent_id, expires_at, used_at, revoked_at FROM invite_links WHERE code = $1 FOR UPDATE',
    [String(code || '').toUpperCase()]
  );
  const inv = r.rows[0];
  if (!inv) throw Object.assign(new Error('Kode undangan tidak ditemukan'), { status: 404 });
  if (inv.used_at) throw Object.assign(new Error('Kode undangan sudah dipakai'), { status: 409 });
  if (inv.revoked_at) throw Object.assign(new Error('Kode undangan sudah diganti yang baru'), { status: 410 });
  if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
    throw Object.assign(new Error('Kode undangan kedaluwarsa'), { status: 410 });
  }

  const sid = inv.student_id || studentId;
  const ownerParentId = parentId || inv.maker_parent_id;
  if (!sid || !ownerParentId) {
    throw Object.assign(new Error('pembuat kode atau anak tidak ditemukan'), { status: 400 });
  }

  // Arah redeem harus sesuai pemilik invite:
  // - invite dibuat anak (inv.student_id): parent yang login menukarnya.
  // - invite dibuat parent (inv.parent_id): student yang login menukarnya.
  if (inv.student_id && studentId && inv.student_id !== studentId) {
    throw Object.assign(new Error('kode undangan bukan untuk akun ini'), { status: 403 });
  }
  if (!inv.student_id && inv.maker_parent_id && parentId && inv.maker_parent_id !== parentId) {
    throw Object.assign(new Error('kode undangan bukan untuk akun ini'), { status: 403 });
  }

  // Link parent ↔ child (idempotent)
  await db.query(
    `INSERT INTO parent_children (parent_id, student_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [ownerParentId, sid]
  );
  await db.query(
    'UPDATE invite_links SET used_at = NOW(), used_by_parent = $2, student_id = $3 WHERE id = $1',
    [inv.id, ownerParentId, sid]
  );

  // Pindahkan kredit parent yang sudah lunas ke siswa.
  const attached = await attachPaidPurchasesToStudent(db, ownerParentId, sid);
  const transferred = attached.transferred_levels;
  return { linked: true, transferred_levels: transferred, paid_purchase_ids: attached.purchase_ids, student_id: sid };
}

module.exports = {
  PRICING,
  MAX_PLACEMENT_LEVEL,
  getPlacementAnchor,
  getCurrentScopeEnd,
  activatePendingPurchases,
  createPurchase,
  getAccessSummary,
  createInvite,
  attachPaidPurchasesToStudent,
  redeemInvite,
};
