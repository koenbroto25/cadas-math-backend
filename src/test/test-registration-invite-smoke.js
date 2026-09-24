/**
 * Smoke test: registrasi parent-child dua arah.
 *
 * S1 Parent-first:
 *   parent register → parent invite → student register → student redeem
 *   → GET /api/parent/children melihat anak.
 *
 * S2 Child-first:
 *   student register(parent_phone) → student invite → parent register(same phone)
 *   → parent children sudah auto-linked → parent redeem → GET children melihat anak.
 *
 * Data test dibersihkan pada finally.
 */
const crypto = require('crypto');
const db = require('../database/db');

const PORT = process.env.PORT || 3000;
const BASE = `http://localhost:${PORT}/api`;
const testIds = { students: [], parents: [] };

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(method, path, body, token) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function registerStudent(data) {
  return request('POST', '/auth/student/register', data);
}

function registerParent(data) {
  return request('POST', '/auth/parent/register', data);
}

async function main() {
  const suffix = `${Date.now()}${crypto.randomBytes(2).toString('hex')}`;
  const password = 'secret123';

  // ── S1: parent-first via invite ────────────────────────────────────────────
  const parent1 = await registerParent({
    name: 'Smoke Parent First',
    email: `smoke-parent-first-${suffix}@test.local`,
    phone: `0812${suffix.slice(-8)}`,
    password,
  });
  expect(parent1.status === 200, `parent-first register: ${parent1.status} ${JSON.stringify(parent1.data)}`);
  testIds.parents.push(parent1.data.parent.id);

  const invite1 = await request('POST', '/payments/invite', {}, parent1.data.token);
  expect(invite1.status === 201 && invite1.data.code, `parent invite: ${invite1.status} ${JSON.stringify(invite1.data)}`);

  const child1 = await registerStudent({ name: 'Smoke Child First', kelas: 4 });
  expect(child1.status === 201, `child-first register: ${child1.status} ${JSON.stringify(child1.data)}`);
  testIds.students.push(child1.data.student.id);

  const redeem1 = await request('POST', '/payments/invite/redeem', { code: invite1.data.code }, child1.data.token);
  expect(redeem1.status === 200 && redeem1.data.linked === true, `child redeem parent invite: ${redeem1.status} ${JSON.stringify(redeem1.data)}`);

  const children1 = await request('GET', '/parent/children', undefined, parent1.data.token);
  expect(children1.status === 200 && children1.data.children.some((c) => c.id === child1.data.student.id),
    `parent-first children: ${children1.status} ${JSON.stringify(children1.data)}`);
  console.log('[S1] PASS parent-first: parent → invite → child → parent children');

  // ── S2: child-first via auto-link + invite ────────────────────────────────
  const phone = `0813${suffix.slice(-8)}`;
  const child2 = await registerStudent({ name: 'Smoke Child First Reverse', kelas: 5, parent_phone: phone });
  expect(child2.status === 201, `child-first reverse register: ${child2.status} ${JSON.stringify(child2.data)}`);
  testIds.students.push(child2.data.student.id);

  const invite2 = await request('POST', '/payments/invite', {}, child2.data.token);
  expect(invite2.status === 201 && invite2.data.code, `child invite: ${invite2.status} ${JSON.stringify(invite2.data)}`);

  const parent2 = await registerParent({
    name: 'Smoke Parent Reverse',
    email: `smoke-parent-reverse-${suffix}@test.local`,
    phone,
    password,
  });
  expect(parent2.status === 200, `parent reverse register: ${parent2.status} ${JSON.stringify(parent2.data)}`);
  testIds.parents.push(parent2.data.parent.id);
  expect(parent2.data.linked_children.some((c) => c.id === child2.data.student.id),
    `child-first auto-link: ${JSON.stringify(parent2.data.linked_children)}`);

  const redeem2 = await request('POST', '/payments/invite/redeem', { code: invite2.data.code }, parent2.data.token);
  expect(redeem2.status === 200 && redeem2.data.linked === true, `parent redeem child invite: ${redeem2.status} ${JSON.stringify(redeem2.data)}`);

  const children2 = await request('GET', '/parent/children', undefined, parent2.data.token);
  expect(children2.status === 200 && children2.data.children.some((c) => c.id === child2.data.student.id),
    `child-first children: ${children2.status} ${JSON.stringify(children2.data)}`);
  console.log('[S2] PASS child-first: child → invite → parent → auto-link/redeem → parent children');

  console.log('\nALL REGISTRATION INVITE SMOKE TESTS PASSED');
}

async function cleanup() {
  for (const id of testIds.students) {
    for (const table of ['llm_usage_log', 'payment_records', 'referrer_earnings', 'referrers', 'student_questions', 'study_sessions', 'placement_tests', 'purchases', 'invite_links', 'parent_children', 'student_variant_bias', 'student_trial_usage']) {
      await db.query(`DELETE FROM ${table} WHERE student_id = $1`, [id]).catch(() => {});
    }
    await db.query('DELETE FROM students WHERE id = $1', [id]).catch(() => {});
  }
  for (const id of testIds.parents) {
    await db.query('DELETE FROM purchases WHERE parent_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM invite_links WHERE parent_id = $1 OR used_by_parent = $1', [id]).catch(() => {});
    await db.query('DELETE FROM parent_children WHERE parent_id = $1', [id]).catch(() => {});
    await db.query('DELETE FROM parents WHERE id = $1', [id]).catch(() => {});
  }
}

main()
  .catch((error) => {
    console.error('REGISTRATION INVITE SMOKE FAIL:', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    console.log('[cleanup] smoke data removed');
  });
