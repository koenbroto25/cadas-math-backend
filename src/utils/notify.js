/**
 * utils/notify.js - FCM Push Notification Helper
 * Kirim notifikasi ke device token parent yang terhubung ke student.
 *
 * Env yang dibutuhkan:
 *   FCM_SERVER_KEY = key dari Firebase Console -> Project Settings -> Cloud Messaging
 *
 * Jika FCM_SERVER_KEY belum diset, fungsi log warning dan return tanpa error
 * sehingga flow sesi tidak terganggu.
 */
const db = require('../database/db');

const FCM_URL = 'https://fcm.googleapis.com/fcm/send';

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
 * Kirim FCM ke satu atau banyak token
 */
async function sendFcm(tokens, title, body, data = {}) {
  const key = process.env.FCM_SERVER_KEY;
  if (!key) {
    console.warn('[notify] FCM_SERVER_KEY belum diset — notif dilewati');
    return;
  }
  if (!tokens || tokens.length === 0) return;

  const registrationIds = tokens.map((t) => t.token);

  const payload = {
    registration_ids: registrationIds,
    notification: { title, body, sound: 'default' },
    data,
    priority: 'high',
  };

  const res = await fetch(FCM_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `key=${key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error('[notify] FCM error:', res.status, txt);
    return;
  }

  const json = await res.json();
  if (json.failure > 0) {
    console.warn('[notify] FCM partial failure:', json.failure, 'dari', registrationIds.length);
  } else {
    console.log('[notify] FCM ok, dikirim ke', registrationIds.length, 'token');
  }
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
  if (naik) body += ' Naik level! Keren! 🚀';
  else body += ' 🎉';

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
 * F-1: Notif reminder malam (dipanggil dari cron)
 * Cek semua siswa yang belum capai target harian, kirim ke parent.
 */
async function sendNightReminders() {
  // Ambil semua siswa dengan parent token, cek akumulasi hari ini (WIB = UTC+7)
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
 * F-2: Notif jadwal terlewat (dipanggil dari cron, 15 menit setelah end_time)
 */
async function sendMissedScheduleNotifs() {
  // Ambil semua jadwal aktif hari ini (hari dalam timezone masing-masing)
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
    // Cek apakah ada sesi dalam window jadwal hari ini
    const check = await db.query(`
      SELECT 1 FROM study_sessions
      WHERE student_id = $1
        AND status = 'completed'
        AND started_at >= (NOW() AT TIME ZONE $2)::date + $3::time
        AND started_at <  (NOW() AT TIME ZONE $2)::date + $4::time
      LIMIT 1
    `, [row.student_id, row.timezone, row.start_time, row.end_time]);

    if (check.rowCount > 0) continue; // sudah belajar dalam jadwal

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

module.exports = {
  sendSessionResultNotif,
  sendDistractionNotif,
  sendNightReminders,
  sendMissedScheduleNotifs,
};