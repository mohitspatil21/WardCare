import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { createAppHandler, createAppServer } from './server.js';
import { JsonWardStore } from './json-store.mjs';
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
  let { server, store } = createAppServer({ dbPath, seed: false });
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

    // 7. Phase 2: Automated reminders, advanced analytics, daily report & Excel/PDF export
    const admit3 = await reqJson(baseUrl, 'POST', '/api/patients', adminAuth.token, {
      name: 'Kavita Nair',
      age: 34,
      g: 'F',
      phone: '555-0199',
    });
    assert.equal(admit3.status, 201);
    const p3 = admit3.data.patient;

    // Nurse sees automated reminder for pending temperature
    const nurseRemState = await reqJson(baseUrl, 'GET', '/api/state', nurseAuth.token);
    assert.ok(
      nurseRemState.data.notifications.some((n) => n.kind === 'reminder' && /temperature/i.test(n.message)),
      'Expected automated pending temperature reminder for nurse'
    );

    // Record temperature -> nurse pending-temp reminder auto-resolves, doctor visit reminder appears
    assert.equal((await reqJson(baseUrl, 'POST', `/api/patients/${p3.id}/temperatures`, nurseAuth.token, { c: 38.4 })).status, 201);
    const nurseAfterTemp = await reqJson(baseUrl, 'GET', '/api/state', nurseAuth.token);
    assert.ok(
      !nurseAfterTemp.data.notifications.some((n) => n.kind === 'reminder' && /temperature/i.test(n.message)),
      'Expected nurse pending temperature reminder to auto-resolve'
    );
    const docRemState = await reqJson(baseUrl, 'GET', '/api/state', patelAuth.token);
    assert.ok(
      docRemState.data.notifications.some((n) => n.kind === 'reminder' && /ready for doctor visit/i.test(n.message)),
      'Expected automated ready-for-visit reminder for doctor'
    );

    // Doctor visits -> ready-for-visit reminder auto-resolves
    assert.equal((await reqJson(baseUrl, 'POST', `/api/patients/${p3.id}/visits`, patelAuth.token, { note: 'Fever noted' })).status, 201);
    const docAfterVisit = await reqJson(baseUrl, 'GET', '/api/state', patelAuth.token);
    assert.ok(
      !docAfterVisit.data.notifications.some((n) => n.kind === 'reminder' && /ready for doctor visit/i.test(n.message)),
      'Expected ready-for-visit reminder to auto-resolve after doctor visit'
    );

    // Advanced analytics endpoint
    const anRes = await reqJson(baseUrl, 'GET', '/api/analytics', adminAuth.token);
    assert.equal(anRes.status, 200);
    assert.equal(anRes.data.dailyTrend.length, 14);
    assert.equal(anRes.data.ageCohorts.length, 4);
    assert.equal(anRes.data.tempCompliance, 1);
    assert.equal(anRes.data.visitCompliance, 1);

    // Daily performance report JSON
    const repRes = await reqJson(baseUrl, 'GET', `/api/reports/daily?date=${td()}`, adminAuth.token);
    assert.equal(repRes.status, 200);
    assert.equal(repRes.data.summary.occupied, 5);
    assert.equal(repRes.data.summary.admissions, 3);
    assert.ok(repRes.data.rows.some((r) => r.name === 'Kavita Nair' && r.temp === 38.4));

    // Excel export
    const xlsRes = await fetch(`${baseUrl}/api/reports/daily/export?format=excel&date=${td()}`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.equal(xlsRes.status, 200);
    assert.ok((xlsRes.headers.get('content-type') || '').includes('excel'));
    const xlsText = await xlsRes.text();
    assert.ok(xlsText.includes('<Workbook') && xlsText.includes('Kavita Nair'));

    // PDF export
    const pdfRes = await fetch(`${baseUrl}/api/reports/daily/export?format=pdf&date=${td()}`, {
      headers: { Authorization: `Bearer ${adminAuth.token}` },
    });
    assert.equal(pdfRes.status, 200);
    assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    const pdfStr = pdfBuf.toString('latin1');
    assert.ok(pdfStr.startsWith('%PDF-1.4') && pdfStr.includes('%%EOF') && pdfStr.includes('Kavita Nair'));
  } finally {
    sseAbort.abort();
    await new Promise((resolve) => server.close(resolve));
  }

  // Persistence check after restart
  ({ server } = createAppServer({ dbPath, seed: false }));
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

test('Default initial ward seeding populates dashboard, queues, and benchmarks', async () => {
  const dbPath = tmpDbPath();
  const { server } = createAppServer({ dbPath });
  await new Promise((resolve) => server.listen(0, resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await reqJson(baseUrl, 'GET', '/api/health', null);
    assert.deepEqual(health.data, { ok: true, occupied: 32, capacity: 74 });

    const adminAuth = await loginAs(baseUrl, 'sunita', 'admin123');
    const docAuth = await loginAs(baseUrl, 'mehta', 'doc123');
    const nurseAuth = await loginAs(baseUrl, 'priya', 'nurse123');

    assert.equal(adminAuth.state.stats.s, 19);
    assert.equal(adminAuth.state.stats.d, 3);
    assert.ok(adminAuth.state.stats.sr30 >= 0.85, 'Expected recovery rate >= 85%');
    assert.ok(adminAuth.state.stats.mr30 <= 0.15, 'Expected mortality rate <= 15%');
    assert.equal(adminAuth.state.analytics.freeBeds, 42);
    assert.ok(adminAuth.state.analytics.ageCohorts.every((c) => c.discharged + c.active > 0));
    assert.ok(adminAuth.state.analytics.dailyTrend.some((d) => d.readings > 0));

    const docState = await reqJson(baseUrl, 'GET', '/api/state', docAuth.token);
    assert.ok(docState.data.notifications.some((n) => n.kind === 'eligible'));
    assert.ok(docState.data.notifications.some((n) => n.kind === 'reminder'));

    const nurseState = await reqJson(baseUrl, 'GET', '/api/state', nurseAuth.token);
    assert.ok(nurseState.data.notifications.some((n) => n.kind === 'reminder'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  }
});

test('Serverless handler supports pre-parsed bodies, HTTPS cookies, and polling-mode /api/events', async () => {
  const dbPath = tmpDbPath();
  const app = createAppHandler({ dbPath, enableTimers: false });
  function mockRes() {
    let status = 200;
    let headers = {};
    const chunks = [];
    return {
      writeHead(s, h = {}) { status = s; headers = h; },
      write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      end(c) { if (c !== undefined) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      result() { return { status, headers, body: Buffer.concat(chunks).toString('utf8') }; },
    };
  }
  try {
    const loginRes = mockRes();
    await app.handler(
      {
        method: 'POST',
        url: '/api/login',
        headers: { 'x-forwarded-proto': 'https' },
        body: { username: 'sunita', password: 'admin123' },
      },
      loginRes
    );
    const loginOut = loginRes.result();
    assert.equal(loginOut.status, 200);
    assert.match(loginOut.headers['Set-Cookie'], /Secure/);
    const parsed = JSON.parse(loginOut.body);
    assert.equal(parsed.user.r, 'admin');

    const evtRes = mockRes();
    await app.handler(
      {
        method: 'GET',
        url: `/api/events?token=${encodeURIComponent(parsed.token)}`,
        headers: {},
      },
      evtRes
    );
    const evtOut = evtRes.result();
    assert.equal(evtOut.status, 200);
    assert.match(evtOut.body, /"mode":"poll"/);
  } finally {
    app.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(dbPath + suffix); } catch {}
    }
  }
});

test('JsonWardStore fallback supports seeding, clinical actions, and Vercel entrypoint GET /', async () => {
  const store = new JsonWardStore(':memory:', { seed: true });
  const admin = store.authenticate('sunita', 'admin123');
  const nurse = store.authenticate('priya', 'nurse123');
  assert.equal(admin?.r, 'admin');
  const st = store.getState('nurse');
  assert.equal(st.p.filter((x) => x.st === 'active').length, 32);
  assert.equal(st.stats.s, 19);
  assert.equal(st.stats.d, 3);
  const p1 = st.p.find((x) => x.bed === 1);
  const updated = store.recordTemp(p1.id, nurse, 37.2);
  assert.equal(updated.t[updated.t.length - 1].c, 37.2);
  assert.ok(store.getDailyReport(td()).rows.length >= 32);

  // Also simulate importing api/index.mjs with WARD_DB pointing to temp path
  const tmpDb = tmpDbPath();
  process.env.WARD_DB = tmpDb;
  try {
    const { default: vercelHandler } = await import('./api/index.mjs');
    let status = 0;
    let body = '';
    await vercelHandler(
      { method: 'GET', url: '/', headers: {} },
      {
        writeHead(s) { status = s; },
        end(c) { body = Buffer.isBuffer(c) ? c.toString('utf8') : String(c ?? ''); },
      }
    );
    assert.equal(status, 200);
    assert.match(body, /Ward<i>Care<\/i>/);
  } finally {
    delete process.env.WARD_DB;
    for (const suffix of ['', '-wal', '-shm', '.json']) {
      try { fs.unlinkSync(tmpDb + suffix); } catch {}
    }
  }
});
