/**
 * utils/cron.js - Cron Jobs untuk Session Notification System
 *
 * F-1: Reminder malam jam 20:00 WIB setiap hari
 * F-2: Cek jadwal terlewat — jalan setiap 15 menit, cek apakah ada jadwal
 *      yang end_time-nya sudah lewat 15 menit dan belum ada sesi
 *
 * Pakai node-cron (sudah tersedia di banyak project Express).
 * Jika belum install: npm install node-cron
 */
const cron = require('node-cron');
const { sendNightReminders, sendMissedScheduleNotifs } = require('./notify');
const { logPayoutQueue } = require('./payout');

function initCron() {
  // F-1: Jam 20:00 WIB setiap hari (UTC+7 = 13:00 UTC)
  cron.schedule('0 13 * * *', async () => {
    console.log('[cron] Night reminder dimulai...');
    try {
      await sendNightReminders();
    } catch (err) {
      console.error('[cron] Night reminder error:', err.message);
    }
  }, { timezone: 'UTC' });

  // F-2: Setiap 15 menit — cek jadwal yang end_time sudah lewat 15 menit
  cron.schedule('*/15 * * * *', async () => {
    try {
      await sendMissedScheduleNotifs();
    } catch (err) {
      console.error('[cron] Missed schedule error:', err.message);
    }
  }, { timezone: 'UTC' });

  // A4: Job harian 09:00 WIB (02:00 UTC) — rekap antrean fee berstatus 'ready'.
  // Tidak mengubah data; hanya mencatat ke log backend agar owner tahu siapa saja
  // yang sudah lolos kuota tier dan siap ditransfer (pencairan: POST /earnings/payout).
  cron.schedule('0 2 * * *', async () => {
    try {
      await logPayoutQueue();
    } catch (err) {
      console.error('[cron] payout queue error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[cron] Cron jobs aktif: night reminder (20:00 WIB) + missed schedule (setiap 15 menit)');
}

module.exports = { initCron };