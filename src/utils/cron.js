/**
 * utils/cron.js - Cron Jobs untuk Session Notification System
 *
 * F-1: Reminder malam jam 20:00 WIB setiap hari
 * F-2: Cek jadwal terlewat - jalan setiap 15 menit
 * F-5: Notif weekly summary - Minggu malam jam 20:00 WIB
 */
const cron = require('node-cron');
const { sendNightReminders, sendMissedScheduleNotifs, sendWeeklySummaryNotifs } = require('./notify');
const finance = require('../services/financeReportService');

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

  // F-2: Setiap 15 menit - cek jadwal yang end_time sudah lewat
  cron.schedule('*/15 * * * *', async () => {
    try {
      await sendMissedScheduleNotifs();
    } catch (err) {
      console.error('[cron] Missed schedule error:', err.message);
    }
  }, { timezone: 'UTC' });

  // M8 finance: expire referrer windows secara otomatis dan audit setiap 15 menit.
  cron.schedule('*/15 * * * *', async () => {
    try { await finance.runFinanceMaintenance(); }
    catch (err) { console.error('[cron] finance maintenance error:', err.message); }
  }, { timezone: 'UTC' });

  // F-5: Minggu malam jam 20:00 WIB (UTC = 13:00, DOW = 0 = Minggu)
  cron.schedule('0 13 * * 0', async () => {
    console.log('[cron] Weekly summary dimulai...');
    try {
      await sendWeeklySummaryNotifs();
    } catch (err) {
      console.error('[cron] Weekly summary error:', err.message);
    }
  }, { timezone: 'UTC' });

  console.log('[cron] Cron jobs aktif: night reminder + missed schedule + weekly summary + finance expiry');
}

module.exports = { initCron };