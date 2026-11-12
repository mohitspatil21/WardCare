import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createAppServer } from './server.js';
import { MAX_PAST_RECORDS, bk, td } from './ward-logic.mjs';

function tmpDbPath() {
  return path.join(os.tmpdir(), `wardcare-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

async function reqJson(baseUrl, method, urlPath, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
}

async function loginAs(baseUrl, username, password) {
  const res = await reqJson(baseUrl, 'POST', '/api/login', null, { username, password });
  assert.equal(res.status, 200, `Login failed for ${username}`);
  return res.data;
}

test('WardCare HTML inline script is valid JS and has no demo artifacts', () => {
  const html = fs.readFileSync(new URL('./ward-care.html', import.meta.url), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(m, 'Missing <script> block in ward-care.html');
  new vm.Script(m[1]);
  assert.ok(!/Reset demo|Quick demo sign-in|DEMO_PW/.test(html), 'Demo artifacts should be removed');
});

test('Real-time SSE, DB persistence, RBAC, clinical workflow, and limited past-data retention', async () => {
  const dbPath = tmpDbPath();
  let { server, store } = createAppServer({ dbPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const sseAbort = new AbortController();
  try {
    // 1. Starts clean (no demo patients), requires authentication
    assert.equal((await reqJson(baseUrl, 'GET', '/api/state', null)).status, 401);
    const health = await reqJson(baseUrl, 'GET', '/api/health', null);
    assert.deepEqual(health.data, { ok: true, occupied: 0, capacity: 74 });

    const adminAuth = await loginAs(baseUrl, 'sunita', 'admin123');
    const nurseAuth = await loginAs(baseUrl, 'priya', 'nurse123');
    const docAuth = await loginAs(baseUrl, 'mehta', 'doc123');
    assert.equal(adminAuth.state.p.length, 0);

    // 2. Connect real-time SSE stream as Nurse and verify live push when Admin admits patient
    const sseRes = await fetch(`${baseUrl}/api/events?token=${encodeURIComponent(nurseAuth.token)}`, {
      signal: sseAbort.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body.getReader();
    const decoder = new TextDecoder();
    const firstChunk = decoder.decode((await reader.read()).value);
    assert.match(firstChunk, /event: ready/);

    const admit1 = await reqJson(baseUrl, 'POST', '/api/patients', adminAuth.token, {
      name: 'Asha Verma',
      age: 42,
      gender: 'Female',
      phone: '9876543210',
      notes: 'Fever since 2 days',
    });
    assert.equal(admit1.status, 201);
    const p1 = admit1.data.patient;
    assert.equal(p1.bed, 1);

    // Wait for SSE update event pushed from admit1
    let sseBuf = '';
    while (!sseBuf.includes('event: update')) {
      const { value } = await reader.read();
      sseBuf += decoder.decode(value, { stream: true });
    }
    assert.match(sseBuf, /Asha Verma/);

    // 3. Admin can create a new staff account in SQLite
    const newDoc = await reqJson(baseUrl, 'POST', '/api/users', adminAuth.token, {
      username: 'drpatel',
      name: 'Dr. Patel',
      role: 'doctor',
      password: 'secret99',
    });
    assert.equal(newDoc.status, 201);
    const patelAuth = await loginAs(baseUrl, 'drpatel', 'secret99');
    assert.equal(patelAuth.user.r, 'doctor');

    // 4. Clinical workflow: temp -> visit -> 3-day fever-free notification -> approve -> discharge
    assert.equal((await reqJson(baseUrl, 'POST', `/api/patients/${p1.id}/visits`, docAuth.token, { note: 'Early' })).status, 409);

    const insT = store.db.prepare(
      'INSERT INTO temperatures (patient_id, d, c, at, by_user) VALUES (?, ?, ?, ?, ?)'
    );
    insT.run(p1.id, bk(2), 36.8, '08:00', 'Priya (Nurse)');
    insT.run(p1.id, bk(1), 36.7, '08:00', 'Priya (Nurse)');

    const day3Temp = await reqJson(baseUrl, 'POST', `/api/patients/${p1.id}/temperatures`, nurseAuth.token, { c: 36.9 });
    assert.equal(day3Temp.status, 201);
    assert.equal((await reqJson(baseUrl, 'POST', `/api/patients/${p1.id}/temperatures`, nurseAuth.token, { c: 37.0 })).status, 409);

    const docState = await reqJson(baseUrl, 'GET', '/api/state', patelAuth.token);
    assert.ok(docState.data.notifications.some((n) => n.patientId === p1.id && n.kind === 'eligible'));

    const visitApprove = await reqJson(baseUrl, 'POST', `/api/patients/${p1.id}/visits`, patelAuth.token, {
      note: '3 fever-free days complete',
      approve: true,
    });
    assert.equal(visitApprove.status, 201);
    assert.equal(visitApprove.data.patient.conf, true);

    const disch = await reqJson(baseUrl, 'POST', `/api/patients/${p1.id}/discharge`, adminAuth.token);
    assert.equal(disch.status, 200);
    assert.equal(disch.data.freedBed, 1);

    // 5. Death updates mortality benchmark (>15%)
    const admit2 = await reqJson(baseUrl, 'POST', '/api/patients', adminAuth.token, { name: 'Mohan Das', age: 68 });
    const death = await reqJson(baseUrl, 'POST', `/api/patients/${admit2.data.patient.id}/death`, patelAuth.token);
    assert.equal(death.status, 200);
    assert.equal(death.data.state.stats.mr30, 0.5); // 1 dead / 2 closed

    // 6. Limited past-data retention: insert 60 extra closed records (including >30d old) and prune
    const insPast = store.db.prepare(
      "INSERT INTO patients (name, age, bed, adm, st, out_date) VALUES (?, 45, 0, ?, 'disch', ?)"
    );
    for (let i = 0; i < 60; i++) {
      const outDay = i < 5 ? bk(45) : bk(i % 20);
      insPast.run(`Past-${i}`, bk(50), outDay);
    }
    const pruned = store.prunePastData();
    assert.ok(pruned > 0, 'Expected older/excess past records to be pruned');
    const postPrune = await reqJson(baseUrl, 'GET', '/api/state', adminAuth.token);
    assert.ok(postPrune.data.stats.retainedPast <= MAX_PAST_RECORDS);
    assert.equal(postPrune.data.stats.s, 61); // 1 Asha + 60 Past
    assert.equal(postPrune.data.stats.d, 1);  // 1 Mohan
  } finally {
    sseAbort.abort();
    await new Promise((resolve) => server.close(resolve));
  }

  // Persistence check after restart
  ({ server } = createAppServer({ dbPath }));
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl2 = `http://127.0.0.1:${server.address().port}`;
  try {
    const patelAuth2 = await loginAs(baseUrl2, 'drpatel', 'secret99');
    const persisted = await reqJson(baseUrl2, 'GET', '/api/state', patelAuth2.token);
    assert.equal(persisted.data.stats.s, 61);
    assert.equal(persisted.data.stats.d, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  }
});
