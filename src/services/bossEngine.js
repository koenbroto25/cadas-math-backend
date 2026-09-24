/**
 * Boss Battle Engine — Championship Gate (Level 9)
 *
 * Spec (Placement_Test_System.md §12.3, keputusan user):
 *   - Boss = 3 fase x 9 HP = 27 pukulan (championship: lebih tinggi dari latihan biasa)
 *   - PUKULAN SAH hanya jika jawaban BENAR dan waktu <= 6000 ms (target boss 6 detik)
 *   - Benar tapi lambat (>6s)  → NEUTRAL: HP boss tidak berkurang, nyawa tidak berkurang,
 *     streak reset (speed wall — presisi waktu adalah inti championship)
 *   - Salah / timeout          → nyawa siswa -1, streak reset
 *   - Nyawa habis (3x gagal)   → BOSS_LOSE (sesi selesai)
 *   - HP habis (27 pukulan sah)→ BOSS_WIN → gate terbuka (Level 10+)
 *
 * Logika "tidak terus-menerus" (bagaimana HP berkurang walau tidak streak penuh):
 *   Setiap pukulan sah langsung mengurangi HP 1 poin — TIDAK ada syarat streak.
 *   Streak hanya kosmetik/motivasi (best_streak dicatat).
 *   Nyawa siswa hanya berkurang karena salah/timeout — lambat tidak menghukum nyawa.
 */

const BOSS_LEVEL = 9;
const HIT_TIME_LIMIT_MS = 6000;   // target kecepatan boss (championship)
const PHASES = 3;
const HITS_PER_PHASE = 9;
const TOTAL_HITS = PHASES * HITS_PER_PHASE; // 27
const PLAYER_LIVES = 3;

function newBattleState() {
  return {
    boss_hp: TOTAL_HITS,
    boss_hp_max: TOTAL_HITS,
    phase: 1,
    total_phases: PHASES,
    hits_landed: 0,
    hits_needed: TOTAL_HITS,
    player_lives: PLAYER_LIVES,
    player_lives_max: PLAYER_LIVES,
    streak: 0,
    best_streak: 0,
    hit_times: []
  };
}

/**
 * Proses satu hit (jawaban siswa) terhadap state battle.
 * @returns {{state, hitResult}} hitResult: 'hit' | 'slow' | 'miss'
 */
function applyHit(state, { isCorrect, timeTakenMs, timedOut }) {
  const s = { ...state, hit_times: [...(state.hit_times || [])] };
  const t = Number.isFinite(Number(timeTakenMs)) ? Math.max(0, Math.round(Number(timeTakenMs))) : HIT_TIME_LIMIT_MS + 1;
  const withinTime = !timedOut && t <= HIT_TIME_LIMIT_MS;

  let hitResult;
  if (timedOut) {
    // Timeout selalu miss — meski nilainya benar (tidak pernah dihitung "hampir benar")
    hitResult = 'miss';
    s.player_lives -= 1;
    s.streak = 0;
  } else if (isCorrect && withinTime) {
    hitResult = 'hit';
    s.boss_hp -= 1;
    s.hits_landed += 1;
    s.streak += 1;
    s.best_streak = Math.max(s.best_streak, s.streak);
    s.hit_times.push(t);
    // fase naik tiap 9 pukulan sah
    const phase = Math.min(PHASES, Math.floor(s.hits_landed / HITS_PER_PHASE) + 1);
    s.phase = phase;
  } else if (isCorrect && !withinTime) {
    hitResult = 'slow'; // benar tapi lambat — speed wall, tidak menghukum nyawa
    s.streak = 0;
    s.hit_times.push(t);
  } else {
    hitResult = 'miss'; // salah
    s.player_lives -= 1;
    s.streak = 0;
  }
  return { state: s, hitResult };
}

function battleOutcome(state) {
  if (state.boss_hp <= 0) return 'boss_win';
  if (state.player_lives <= 0) return 'boss_lose';
  return 'ongoing';
}

function summarizeTimes(hit_times) {
  if (!hit_times || hit_times.length === 0) return { avg_hit_time_ms: null, best_hit_time_ms: null };
  const avg = Math.round(hit_times.reduce((a, b) => a + b, 0) / hit_times.length);
  return { avg_hit_time_ms: avg, best_hit_time_ms: Math.min(...hit_times) };
}

module.exports = {
  BOSS_LEVEL,
  HIT_TIME_LIMIT_MS,
  PHASES,
  HITS_PER_PHASE,
  TOTAL_HITS,
  PLAYER_LIVES,
  newBattleState,
  applyHit,
  battleOutcome,
  summarizeTimes
};
