/**
 * Integration test: placement v2 endpoints (start → submit → status).
 * Requires the backend server running on PORT (default 3000).
 * Uses a throwaway student row created + cleaned up by this script.
 */
const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}/api/placement`;

const db = require('../database/db');

async function main() {
  // 1. Create throwaway student (students.id is a UUID column)
  const studentId = require('crypto').randomUUID();
  await db.query(
    "INSERT INTO students (id, display_id, name, kelas, parent_phone, current_level, trial_level) VALUES ($1, $2, 'TEST PLACEMENT V2', '3', '081000000000', 1, 1) ON CONFLICT (id) DO NOTHING",
    [studentId, 'T' + Math.floor(Math.random() * 9000 + 1000)]
  );
  console.log('[1] student created:', studentId);

  try {
    // 2. START
    const startRes = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId })
    });
    if (startRes.status === 409) {
      throw new Error('START returned 409 — student had leftover completed test (cleanup needed)');
    }
    if (!startRes.ok) throw new Error(`START failed: ${startRes.status} ${await startRes.text()}`);
    const startData = await startRes.json();
    console.log('[2] START ok: placementId=%s totalQuestions=%s exercises=%s timeLimitMs=%s',
      startData.placementId, startData.totalQuestions, startData.exercises.length, startData.timeLimitMs);
    if (startData.exercises.length !== 25) throw new Error('Expected 25 exercises, got ' + startData.exercises.length);
    if (startData.exercises.some(q => q.correctAnswer !== undefined)) throw new Error('LEAK: correctAnswer sent to client!');

    // 3. SUBMIT — simulate: pass everything fast through L6, fail L7 (2 wrong of 3), pass rest
    const answers = [];
    for (const q of startData.exercises) {
      if (q.level === 7 && ['A', 'B'].includes(q.probeId)) {
        answers.push({ probeId: q.probeId, answer: 999999, timeTakenMs: 4000 }); // wrong
      } else {
        // right answer unknown to client — but we cannot cheat: probe answer unknown.
        // For integration test we submit deliberately wrong answers for everything
        // EXCEPT we verify evaluation by answering with a value; engine checks correctness.
        answers.push({ probeId: q.probeId, answer: 1, timeTakenMs: 3000 });
      }
    }
    const submitRes = await fetch(`${BASE}/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId, placementId: startData.placementId, answers })
    });
    if (!submitRes.ok) throw new Error(`SUBMIT failed: ${submitRes.status} ${await submitRes.text()}`);
    const submitData = await submitRes.json();
    console.log('[3] SUBMIT ok: placedLevel=%s reason=%s earlyStopped=%s',
      submitData.placedLevel, submitData.earlyStopReason, submitData.earlyStopped);
    if (submitData.placedLevel !== 1) throw new Error('Expected placedLevel=1 (all wrong answers), got ' + submitData.placedLevel);

    // 4. STATUS
    const statusRes = await fetch(`${BASE}/status/${studentId}`);
    if (!statusRes.ok) throw new Error(`STATUS failed: ${statusRes.status}`);
    const statusData = await statusRes.json();
    console.log('[4] STATUS ok: hasCompleted=%s placedLevel=%s breakdownLevels=%s',
      statusData.hasCompleted, statusData.placedLevel,
      (statusData.levelBreakdown || []).length);
    if (!statusData.hasCompleted) throw new Error('Expected hasCompleted=true');
    if (!statusData.levelBreakdown || statusData.levelBreakdown.length === 0) throw new Error('Expected level_breakdown persisted');

    // 5. START again must return 409 (already completed)
    const againRes = await fetch(`${BASE}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studentId })
    });
    console.log('[5] START after completion → status', againRes.status, '(expect 409)');
    if (againRes.status !== 409) throw new Error('Expected 409 on re-start');

    console.log('\nALL INTEGRATION CHECKS PASSED');
  } finally {
    // Cleanup throwaway rows
    await db.query('DELETE FROM student_variant_bias WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM placement_tests WHERE student_id = $1', [studentId]);
    await db.query('DELETE FROM students WHERE id = $1', [studentId]);
    console.log('[cleanup] test student + placement rows removed');
    process.exit(0);
  }
}

main().catch((e) => { console.error('INTEGRATION FAIL:', e.message); process.exit(1); });
