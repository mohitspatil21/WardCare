import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, createWardStore } from './db.mjs';
import { CAP, buildExcelReport, buildPdfReport, canRole, td } from './ward-logic.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
function resolveHtmlPath() {
  for (const candidate of [
    path.join(__dirname, 'ward-care.html'),
    path.join(process.cwd(), 'ward-care.html'),
    path.join(__dirname, '..', 'ward-care.html'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(__dirname, 'ward-care.html');
}
const MAX_BODY_BYTES = 64 * 1024;
const COOKIE_NAME = 'wc_token';

function sendJson(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return Promise.resolve(req.body);
    try {
      return Promise.resolve(JSON.parse(String(req.body) || '{}'));
    } catch {
      return Promise.reject(new AppError(400, 'Invalid JSON body'));
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new AppError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function extractToken(req, url) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const qTok = url?.searchParams.get('token');
  if (qTok) return qTok.trim();
  const cookieHeader = req.headers.cookie || '';
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === COOKIE_NAME) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function getActor(req, store, url) {
  const token = extractToken(req, url);
  const user = store.getSessionUser(token);
  if (!user) throw new AppError(401, 'Authentication required. Please sign in.');
  return user;
}

function requireRole(user, action) {
  if (!canRole(user.r, action)) {
    throw new AppError(403, `Role "${user.r}" is not permitted to perform "${action}"`);
  }
}

/** Create the WardCare request handler with SQLite persistence and optional SSE/timer support. */
export function createAppHandler({
  dbPath = process.env.WARD_DB || (process.env.VERCEL ? '/tmp/ward-care.db' : path.join(__dirname, 'ward-care.db')),
  seed = true,
  enableTimers = !process.env.VERCEL,
} = {}) {
  const store = createWardStore(dbPath, { seed });
  const html = fs.readFileSync(resolveHtmlPath(), 'utf8');
  const sseClients = new Set();

  function broadcastUpdate() {
    if (!sseClients.size) return;
    const cacheByRole = new Map();
    for (const client of sseClients) {
      let payload = cacheByRole.get(client.role);
      if (!payload) {
        payload = `event: update\ndata: ${JSON.stringify(store.getState(client.role))}\n\n`;
        cacheByRole.set(client.role, payload);
      }
      client.res.write(payload);
    }
  }

  let keepalive = null;
  let reminderTimer = null;
  if (enableTimers) {
    keepalive = setInterval(() => {
      for (const client of sseClients) {
        client.res.write(': keepalive\n\n');
      }
    }, 25000);
    keepalive.unref();

    reminderTimer = setInterval(() => {
      store.syncAutomatedReminders();
      broadcastUpdate();
    }, 60000);
    reminderTimer.unref();
  }

  const handler = async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = req.method || 'GET';
    const isHttps = req.headers['x-forwarded-proto'] === 'https' || req.socket?.encrypted;
    const cookieSec = isHttps ? '; Secure' : '';

    try {
      if (method === 'GET' && (pathname === '/' || pathname === '/ward-care.html')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
      }

      if (method === 'GET' && pathname === '/api/health') {
        const s = store.getState();
        const occupied = s.p.filter((p) => p.st === 'active').length;
        return sendJson(res, 200, { ok: true, occupied, capacity: CAP });
      }

      if (method === 'POST' && pathname === '/api/login') {
        const body = await readJsonBody(req);
        const user = store.authenticate(body.username, body.password);
        if (!user) throw new AppError(401, 'Invalid username or password');
        const token = store.createSession(user.username);
        const cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/${cookieSec}`;
        return sendJson(res, 200, { user, token, state: store.getState(user.r) }, { 'Set-Cookie': cookie });
      }

      if (method === 'POST' && pathname === '/api/logout') {
        store.deleteSession(extractToken(req, url));
        const clearCookie = `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${cookieSec}`;
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie });
      }

      if (method === 'GET' && pathname === '/api/events') {
        const user = getActor(req, store, url);
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: enableTimers ? 'keep-alive' : 'close',
        });
        if (!enableTimers) {
          res.end(`event: ready\ndata: ${JSON.stringify({ ok: true, mode: 'poll' })}\n\n`);
          return;
        }
        const client = { res, role: user.r };
        sseClients.add(client);
        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, mode: 'sse' })}\n\n`);
        req.on('close', () => sseClients.delete(client));
        return;
      }

      if (method === 'GET' && pathname === '/api/me') {
        const user = getActor(req, store, url);
        return sendJson(res, 200, { user });
      }

      if (method === 'GET' && pathname === '/api/state') {
        const user = getActor(req, store, url);
        return sendJson(res, 200, { user, ...store.getState(user.r) });
      }

      if (method === 'GET' && pathname === '/api/stats') {
        const user = getActor(req, store, url);
        return sendJson(res, 200, store.getState(user.r).stats);
      }

      if (method === 'GET' && pathname === '/api/analytics') {
        const user = getActor(req, store, url);
        return sendJson(res, 200, store.getState(user.r).analytics);
      }

      if (method === 'GET' && pathname === '/api/reports/daily') {
        getActor(req, store, url);
        const date = url.searchParams.get('date') || td();
        return sendJson(res, 200, store.getDailyReport(date));
      }

      if (method === 'GET' && pathname === '/api/reports/daily/export') {
        getActor(req, store, url);
        const date = url.searchParams.get('date') || td();
        const format = (url.searchParams.get('format') || 'excel').toLowerCase();
        const report = store.getDailyReport(date);
        if (format === 'pdf') {
          const pdfBuf = buildPdfReport(report);
          res.writeHead(200, {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="wardcare-report-${report.date}.pdf"`,
            'Content-Length': pdfBuf.length,
            'Cache-Control': 'no-store',
          });
          res.end(pdfBuf);
          return;
        }
        const xls = buildExcelReport(report);
        const xlsBuf = Buffer.from(xls, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'application/vnd.ms-excel; charset=utf-8',
          'Content-Disposition': `attachment; filename="wardcare-report-${report.date}.xls"`,
          'Content-Length': xlsBuf.length,
          'Cache-Control': 'no-store',
        });
        res.end(xlsBuf);
        return;
      }

      if (method === 'GET' && pathname === '/api/users') {
        const user = getActor(req, store, url);
        requireRole(user, 'manageUsers');
        return sendJson(res, 200, { users: store.listUsers() });
      }

      if (method === 'POST' && pathname === '/api/users') {
        const user = getActor(req, store, url);
        requireRole(user, 'manageUsers');
        const body = await readJsonBody(req);
        const created = store.createUser(user, body);
        broadcastUpdate();
        return sendJson(res, 201, { created, state: store.getState(user.r) });
      }

      if (method === 'POST' && pathname === '/api/notifications/read-all') {
        const user = getActor(req, store, url);
        store.markNotificationRead(user.r, null);
        broadcastUpdate();
        return sendJson(res, 200, { ok: true, state: store.getState(user.r) });
      }

      const notifMatch = pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
      if (method === 'POST' && notifMatch) {
        const user = getActor(req, store, url);
        store.markNotificationRead(user.r, Number(notifMatch[1]));
        broadcastUpdate();
        return sendJson(res, 200, { ok: true, state: store.getState(user.r) });
      }

      if (method === 'POST' && pathname === '/api/patients') {
        const user = getActor(req, store, url);
        requireRole(user, 'admit');
        const body = await readJsonBody(req);
        const patient = store.admitPatient(user, body);
        broadcastUpdate();
        return sendJson(res, 201, { patient, state: store.getState(user.r) });
      }

      const match = pathname.match(
        /^\/api\/patients\/(\d+)\/(temperatures\/today|temperatures|visits|approve-discharge|discharge|death)$/
      );
      if (match) {
        const id = Number(match[1]);
        const action = match[2];
        const user = getActor(req, store, url);

        if (method === 'POST' && action === 'temperatures') {
          requireRole(user, 'temp');
          const body = await readJsonBody(req);
          const patient = store.recordTemp(id, user, body.c);
          broadcastUpdate();
          return sendJson(res, 201, { patient, state: store.getState(user.r) });
        }

        if (method === 'PATCH' && action === 'temperatures/today') {
          requireRole(user, 'amend');
          const body = await readJsonBody(req);
          const patient = store.amendTemp(id, user, body.c, body.reason);
          broadcastUpdate();
          return sendJson(res, 200, { patient, state: store.getState(user.r) });
        }

        if (method === 'POST' && action === 'visits') {
          requireRole(user, 'visit');
          const body = await readJsonBody(req);
          const patient = store.recordVisit(id, user, body.note, Boolean(body.approve));
          broadcastUpdate();
          return sendJson(res, 201, { patient, state: store.getState(user.r) });
        }

        if (method === 'POST' && action === 'approve-discharge') {
          requireRole(user, 'confirm');
          const patient = store.approveDischarge(id, user);
          broadcastUpdate();
          return sendJson(res, 200, { patient, state: store.getState(user.r) });
        }

        if (method === 'POST' && action === 'discharge') {
          requireRole(user, 'disch');
          const result = store.dischargePatient(id, user);
          broadcastUpdate();
          return sendJson(res, 200, { ...result, state: store.getState(user.r) });
        }

        if (method === 'POST' && action === 'death') {
          requireRole(user, 'death');
          const result = store.recordDeath(id, user);
          broadcastUpdate();
          return sendJson(res, 200, { ...result, state: store.getState(user.r) });
        }
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, err.status, { error: err.message });
      }
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };

  function close() {
    if (keepalive) clearInterval(keepalive);
    if (reminderTimer) clearInterval(reminderTimer);
    for (const client of sseClients) client.res.end();
    sseClients.clear();
    store.close();
  }

  return { store, handler, close };
}

/** Create an HTTP server wrapping the WardCare request handler for standalone Node hosting. */
export function createAppServer(opts = {}) {
  const { store, handler, close } = createAppHandler(opts);
  const server = http.createServer(handler);
  server.on('close', close);
  return { server, store };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8765;
  const { server } = createAppServer();
  server.listen(port, () => {
    console.log(`WardCare server running at http://localhost:${port}/ward-care.html`);
  });
}
