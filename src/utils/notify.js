/**
 * utils/notify.js - FCM Push Notification Helper (FCM HTTP v1)
 *
 * Memakai Google Auth Library + Service Account JSON untuk OAuth2 token.
 * Legacy FCM API sudah deprecated sejak Juni 2024 -- wajib pakai v1.
 *
 * Env yang dibutuhkan:
 *   FCM_SERVICE_ACCOUNT_PATH = path absolut ke service account JSON
 *
 * Jika FCM_SERVICE_ACCOUNT_PATH belum diset, fungsi log warning dan
 * return tanpa error sehingga flow sesi tidak terganggu.
 */
const db = require('../database/db');

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
let _projectId = null;

/**
 * Ambil OAuth2 access token dari service account JSON
 */
async function getAccessToken() {
  const path = process.env.FCM_SERVICE_ACCOUNT_PATH;
  if (!path) {
    console.warn('[notify] FCM_SERVICE_ACCOUNT_PATH belum diset');
    return null;
  }
  const { GoogleAuth } = require('google-auth-library');
  const auth = new GoogleAuth({
    keyFile: path,
    scopes: [FCM_SCOPE],
  });
  const client = await auth.getClient();
  const token  = await client.getAccessToken();

  // Ambil project_id dari service account JSON (sekali saja)
  if (!_projectId) {
    const sa = require(path);
    _projectId = sa.project_id;
  }

  return token.token || token;
}

/**
 * Ambil semua FCM token parent yang terhubung ke student_id
 */
async function getParentTokens(studentId) {
  const r = await db.query(`
    SELECT dt.token, dt.platform
    FROM device_tokens dt
    JOIN parent_children pc ON pc.parent_id = dt.user_id
    WHERE pc.student_id = $1
      AND dt.user_type = 'parent'
  `, [studentId]);
  return r.rows;
}

/**
 * Ambil nama siswa
 */
async function getStudentName(studentId) {
  const r = await db.query(
    'SELECT COALESCE(name, display_name, display_id) AS nama FROM students WHERE id = $1',
    [studentId]
  );
  return r.rows[0]?.nama || 'Anak';
}

/**
 * Kirim FCM v1 ke satu token
 */
async function sendOneFcm(accessToken, projectId, deviceToken, title, body, data = {}) {
  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const payload = {
    message: {
      token: deviceToken,
      notification: { title, body },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
      android: { priority: 'high' },
      apns: {
        payload: { aps: { sound: 'default' } },
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    // Token tidak valid / expired: log tapi jangan throw
    if (res.status === 404 || res.status === 400) {
      console.warn('[notify] Token tidak valid, skip:', deviceToken.slice(0, 20), txt.slice(0, 100));
      return;
    }
    console.error('[notify] FCM v1 error:', res.status, txt.slice(0, 200));
  }
}

/**
 * Kirim FCM ke semua token (satu per satu — FCM v1 tidak support batch sederhana)
 */
async function sendFcm(tokens, title, body, data = {}) {
  if (!tokens || tokens.length === 0) return;

  const accessToken = await getAccessToken();
  if (!accessToken) return;
  if (!_projectId) {
    console.warn('[notify] project_id tidak ditemukan');
    return;
  }

  const results = await Promise.allSettled(
    tokens.map((t) => sendOneFcm(accessToken, _projectId, t.token, title, body, data))
  );

  const ok      = results.filter((r) => r.status === 'fulfilled').length;
  const failed  = results.filter((r) => r.status === 'rejected').length;
  console.log(`[notify] FCM selesai: ${ok} ok, ${failed} gagal dari ${tokens.length} token`);
}

/**
 * F-3: Notif hasil sesi setelah siswa selesai belajar
 */
async function sendSessionResultNotif(studentId, session) {
  const [tokens, nama] = await Promise.all([
    getParentTokens(studentId),
    getStudentName(studentId),
  ]);
  if (tokens.length === 0) return;

  const durMenit  = Math.round((session.duration_active_ms || 0) / 60000);
  const akurasi   = Math.round(parseFloat(session.accuracy || 0));
  const totalSoal = session.total_count || 0;
  const naik      = session.level_up;

  let body = `${nama} baru selesai belajar! Akurasi ${akurasi}%, ${totalSoal} soal, ${durMenit} menit.`;
  if (naik) body += ' Naik level! Keren!';

  await sendFcm(tokens, 'Sesi Belajar Selesai', body, {
    type:       'session_result',
    student_id: String(studentId),
    session_id: String(session.id),
  });
}

/**
 * F-4: Notif distraksi (focus_ratio < 75%, exit_count >= 3)
 */
async function sendDistractionNotif(studentId, session) {
  const [tokens, nama] = await Promise.all([
    getParentTokens(studentId),
    getStudentName(studentId),
  ]);
  if (tokens.length === 0) return;

  const exitCount = session.exit_count || 0;
  const durMenit  = Math.round((session.duration_total_ms || 0) / 60000);
  const bgMenit   = Math.round(
    ((session.duration_total_ms || 0) - (session.duration_active_ms || 0)) / 60000
  );

  const body = `${nama} keluar dari app ${exitCount} kali saat belajar tadi (sekitar ${bgMenit} dari ${durMenit} menit). Mungkin perlu waktu belajar yang lebih tenang.`;

  await sendFcm(tokens, 'Info Fokus Belajar', body, {
    type:       'distraction',
    student_id: String(studentId),
    session_id: String(session.id),
  });
}

/**
 * F-1: Notif reminder malam (dipanggil dari cron jam 20:00 WIB)
 */
async function sendNightReminders() {
  const r = await db.query(`
    SELECT
      s.id            AS student_id,
      COALESCE(s.name, s.display_name, s.display_id) AS nama,
      s.daily_target_minutes,
      COALESCE(SUM(ss.duration_active_ms), 0)::bigint AS total_ms_today
    FROM students s
    JOIN parent_children pc ON pc.student_id = s.id
    JOIN device_tokens dt   ON dt.user_id = pc.parent_id AND dt.user_type = 'parent'
    LEFT JOIN study_sessions ss
      ON ss.student_id = s.id
      AND ss.status = 'completed'
      AND ss.started_at >= (NOW() AT TIME ZONE 'Asia/Jakarta')::date
      AND ss.started_at <  (NOW() AT TIME ZONE 'Asia/Jakarta')::date + INTERVAL '1 day'
    GROUP BY s.id, s.daily_target_minutes
  `);

  for (const row of r.rows) {
    const targetMs  = (row.daily_target_minutes || 30) * 60 * 1000;
    const actualMs  = parseInt(row.total_ms_today || 0);
    if (actualMs >= targetMs) continue;

    const sudahMenit = Math.round(actualMs / 60000);
    const targetMen  = row.daily_target_minutes || 30;
    const tokens     = await getParentTokens(row.student_id);
    if (tokens.length === 0) continue;

    const body = `${row.nama} baru belajar ${sudahMenit} menit hari ini. Masih ada waktu untuk mencapai target ${targetMen} menit!`;
    await sendFcm(tokens, 'Pengingat Belajar Malam', body, {
      type:       'night_reminder',
      student_id: String(row.student_id),
    }).catch((e) => console.error('[notify/night]', row.student_id, e.message));
  }
  console.log('[notify] Night reminders selesai, diproses', r.rows.length, 'siswa');
}

/**
 * F-2: Notif jadwal terlewat (dipanggil dari cron setiap 15 menit)
 */
async function sendMissedScheduleNotifs() {
  const r = await db.query(`
    SELECT
      sch.student_id,
      sch.start_time,
      sch.end_time,
      sch.timezone,
      COALESCE(s.name, s.display_name, s.display_id) AS nama
    FROM study_schedules sch
    JOIN students s ON s.id = sch.student_id
    WHERE sch.active = TRUE
      AND EXTRACT(DOW FROM NOW() AT TIME ZONE sch.timezone) = ANY(sch.days)
  `);

  for (const row of r.rows) {
    const check = await db.query(`
      SELECT 1 FROM study_sessions
      WHERE student_id = $1
        AND status = 'completed'
        AND started_at >= (NOW() AT TIME ZONE $2)::date + $3::time
        AND started_at <  (NOW() AT TIME ZONE $2)::date + $4::time
      LIMIT 1
    `, [row.student_id, row.timezone, row.start_time, row.end_time]);

    if (check.rowCount > 0) continue;

    const tokens = await getParentTokens(row.student_id);
    if (tokens.length === 0) continue;

    const startStr = String(row.start_time).slice(0, 5);
    const endStr   = String(row.end_time).slice(0, 5);
    const body     = `Jadwal belajar ${row.nama} jam ${startStr}-${endStr} belum dimulai hari ini.`;

    await sendFcm(tokens, 'Jadwal Belajar Terlewat', body, {
      type:       'missed_schedule',
      student_id: String(row.student_id),
    }).catch((e) => console.error('[notify/schedule]', row.student_id, e.message));
  }
  console.log('[notify] Missed schedule check selesai');
}


/**
 * F-5: Notif ringkasan mingguan (dipanggil dari cron Minggu malam)
 */
async function sendWeeklySummaryNotifs() {
  // Ambil semua siswa yang punya parent token
  const r = await db.query(`
    SELECT DISTINCT
      s.id            AS student_id,
      COALESCE(s.name, s.display_name, s.display_id) AS nama,
      s.weekly_target_days
    FROM students s
    JOIN parent_children pc ON pc.student_id = s.id
    JOIN device_tokens dt   ON dt.user_id = pc.parent_id AND dt.user_type = 'parent'
  `);

  for (const row of r.rows) {
    const stats = await db.query(`
      SELECT
        COUNT(DISTINCT DATE(started_at AT TIME ZONE 'Asia/Jakarta'))::int AS hari_belajar,
        ROUND(AVG(duration_active_ms) / 60000.0, 1)                       AS rata_durasi_menit,
        ROUND(AVG(accuracy), 1)                                            AS rata_akurasi,
        ROUND(AVG(focus_ratio), 1)                                         AS rata_fokus
      FROM study_sessions
      WHERE student_id = $1
        AND status = 'completed'
        AND started_at >= NOW() - INTERVAL '7 days'
    `, [row.student_id]);

    const s = stats.rows[0];
    const hariBelajar  = s.hari_belajar  || 0;
    const targetHari   = row.weekly_target_days || 5;
    const rataDurasi   = s.rata_durasi_menit || 0;
    const rataAkurasi  = s.rata_akurasi  || 0;
    const rataFokus    = s.rata_fokus    || 0;

    // Skip jika tidak ada aktivitas sama sekali minggu ini
    if (hariBelajar === 0) continue;

    const tokens = await getParentTokens(row.student_id);
    if (tokens.length === 0) continue;

    const tercapai = hariBelajar >= targetHari;
    const emoji    = tercapai ? 'Luar biasa!' : 'Terus semangat!';

    const body = `${emoji} Minggu ini ${row.nama} belajar ${hariBelajar}/${targetHari} hari, ` +
      `rata-rata ${rataDurasi} menit/sesi, akurasi ${rataAkurasi}%, fokus ${rataFokus}%.`;

    await sendFcm(tokens, 'Laporan Mingguan', body, {
      type:       'weekly_summary',
      student_id: String(row.student_id),
    }).catch((e) => console.error('[notify/weekly]', row.student_id, e.message));
  }
  console.log('[notify] Weekly summary selesai, diproses', r.rows.length, 'siswa');
}

module.exports = {
  sendSessionResultNotif,
  sendDistractionNotif,
  sendNightReminders,
  sendMissedScheduleNotifs,
  sendWeeklySummaryNotifs,
};