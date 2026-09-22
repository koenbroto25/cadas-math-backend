/**
 * utils/cron.js - Cron Jobs untuk Session Notification System
 *
 * F-1: Reminder malam jam 20:00 WIB setiap hari
 * F-2: Cek jadwal terlewat - jalan setiap 15 menit
 */
const cron = require('node-cron');
const { sendNightReminders, sendMissedScheduleNotifs } = require('./notify');

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

  // F-2: Setiap 15 menit - cek jadwal yang end_time sudah lewat 15 menit
  cron.schedule('*/15 * * * *', async () => {
    try {
      await sendMissedScheduleNotifs();
    } catch (err) {
      console.error('[cron] Missed schedule error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[cron] Cron jobs aktif: night reminder (20:00 WIB) + missed schedule (setiap 15 menit)');
}

module.exports = { initCron };