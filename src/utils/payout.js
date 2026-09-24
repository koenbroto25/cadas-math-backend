/**
 * utils/payout.js — Antrian pencairan fee referrer (A4, marketing.md bagian 2).
 *
 * Konteks A4: "fee guru/sales ter-transfer otomatis saat kuota terpenuhi".
 * Sistem TIDAK boleh menandai uang sudah dikirim tanpa transfer bank nyata
 * (tidak ada API disbursement di repo ini). Jadi yang diotomatiskan penuh:
 *
 *   1. saat invoice lunas & kuota tier terpenuhi -> baris referrer_earnings
 *      langsung berstatus 'ready'  (lihat midtrans.js saveEarnings)
 *   2. job harian (utils/cron.js) menghitung antrean 'ready' per referrer
 *      dan mencatatnya ke log backend -> owner tahu siapa yang siap dicairkan
 *   3. pencairan dieksekusi satu perintah: POST /api/admin/earnings/payout
 *      (borongan per referrer, atau semua sekaligus) — lihat routes/admin.js
 *
 * Status akhir: 'transferred' + transferred_at + total_transferred_idr naik.
 */
const db = require('../database/db');

/**
 * Antrean pencairan: total fee 'ready' dikelompokkan per referrer.
 * Dipakai endpoint GET /api/admin/earnings/payout-queue dan job harian.
 */
async function readyPayoutQueue() {
  const rows = await db.query(`
    SELECT r.id AS referrer_id, r.full_name, r.type AS referrer_type,
           r.bank_name, r.bank_account_number, r.bank_account_name,
           (r.bank_name IS NOT NULL AND r.bank_account_number IS NOT NULL) AS bank_complete,
           COUNT(e.id)::int               AS ready_count,
           COALESCE(SUM(e.commission_idr),0)::int AS ready_idr,
           MIN(e.created_at)              AS oldest_ready_at,
           MAX(e.created_at)              AS newest_ready_at
      FROM referrer_earnings e
      JOIN referrers r ON r.id = e.referrer_id
     WHERE e.status = 'ready'
     GROUP BY r.id, r.full_name, r.type,
              r.bank_name, r.bank_account_number, r.bank_account_name
     ORDER BY ready_idr DESC, oldest_ready_at ASC
  `);
  return rows.rows;
}

/** Ringkasan angka antrean — dipakai logging cron & response endpoint. */
function summarizeQueue(queue) {
  const totalIdr = queue.reduce((a, r) => a + (r.ready_idr || 0), 0);
  const withoutBank = queue.filter((r) => !r.bank_complete).length;
  return { referrers: queue.length, total_idr: totalIdr, referrers_without_bank: withoutBank };
}

/**
 * Job harian: catat antrean pencairan ke log supaya owner/admin tahu
 * siapa saja yang fee-nya sudah siap ditransfer. Tidak mengubah data.
 */
async function logPayoutQueue() {
  const queue = await readyPayoutQueue();
  const sum = summarizeQueue(queue);
  if (!sum.referrers) {
    console.log('[cron] payout queue: kosong (tidak ada earning berstatus ready)');
    return { ok: true, ...sum };
  }
  console.log(`[cron] payout queue: ${sum.referrers} referrer siap cair, total Rp${sum.total_idr.toLocaleString('id-ID')}` +
    (sum.referrers_without_bank ? `, ${sum.referrers_without_bank} belum lengkapi data bank` : ''));
  for (const r of queue) {
    console.log(`        - ${r.full_name || r.referrer_id} (${r.referrer_type}) Rp${(r.ready_idr || 0).toLocaleString('id-ID')}` +
      ` dari ${r.ready_count} transaksi${r.bank_complete ? '' : ' [BANK BELUM LENGKAP]'}`);
  }
  return { ok: true, ...sum };
}

module.exports = { readyPayoutQueue, summarizeQueue, logPayoutQueue };
