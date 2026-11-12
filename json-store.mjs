import fs from 'node:fs';
import path from 'node:path';
import {
  AppError,
  BM,
  CAP,
  INITIAL_STAFF,
  MAX_AUDIT_LOGS,
  MAX_PAST_RECORDS,
  PAST_RETENTION_DAYS,
  TH,
  bk,
  buildReminderSpecs,
  computeAnalytics,
  computeDailyReport,
  computeStats,
  findFreeBed,
  hashPassword,
  hm,
  rdy,
  signToken,
  td,
  tod,
  verifyPassword,
  verifySignedToken,
  vis,
} from './ward-logic.mjs';
import { buildSeedDataset } from './seed.mjs';

/**
 * Ephemeral JSON/in-memory fallback store used automatically when node:sqlite
 * is unavailable in the host runtime (e.g., older serverless Node runtimes).
 */
export class JsonWardStore {
  constructor(filePath = '/tmp/ward-care.json', { seed = true } = {}) {
    this.filePath = filePath === ':memory:' ? null : filePath.replace(/\.db$/i, '.json');
    this.data = this.#loadOrInit(seed);
    this.prunePastData();
  }

  #loadOrInit(seed) {
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      } catch {}
    }
    const now = Date.now();
    const users = {};
    for (const s of INITIAL_STAFF) {
      users[s.username] = { username: s.username, name: s.name, role: s.role, pw_hash: hashPassword(s.pw), created_at: now };
    }
    const data = {
      nextPid: 1,
      nextTid: 1,
      nextVid: 1,
      nextNid: 1,
      users,
      patients: [],
      logs: [],
      notifications: [],
      sessions: {},
      archive: { disch: 0, dead: 0 },
    };
    if (seed) {
      const ds = buildSeedDataset();
      for (let i = 0; i < ds.patients.length; i++) {
        const sp = ds.patients[i];
        const pid = data.nextPid++;
        data.patients.push({
          id: pid,
          name: sp.name,
          age: sp.age,
          gender: sp.gender,
          phone: sp.phone,
          notes: sp.notes,
          bed: sp.bed,
          adm: sp.adm,
          st: sp.st,
          out: sp.out,
          conf: sp.conf,
          confBy: sp.confBy,
          t: sp.t.map((x) => ({ id: data.nextTid++, ...x })),
          v: sp.v.map((x) => ({ id: data.nextVid++, ...x })),
        });
        if (sp._group === 'B_ELIG') {
          data.notifications.push({
            id: data.nextNid++,
            role: 'doctor',
            patientId: pid,
            kind: 'eligible',
            message: `${sp.name} (Bed ${sp.bed}) completed 3 fever-free days and is eligible for discharge.`,
            dedupKey: null,
            createdAt: now - (i + 1) * 60000,
            isRead: false,
          });
        } else if (sp._group === 'D') {
          data.notifications.push({
            id: data.nextNid++,
            role: 'admin',
            patientId: pid,
            kind: 'discharge_approved',
            message: `${sp.name} (Bed ${sp.bed}) was approved for discharge by ${sp.confBy}.`,
            dedupKey: null,
            createdAt: now - (i + 1) * 45000,
            isRead: false,
          });
        }
      }
      data.logs = [...ds.logs].sort((a, b) => b.ts - a.ts);
    }
    this.#save(data);
    return data;
  }

  #save(target = this.data) {
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(target));
    } catch {}
  }

  #log(userName, action) {
    this.data.logs.unshift({ ts: Date.now(), u: userName, a: action });
    if (this.data.logs.length > MAX_AUDIT_LOGS) this.data.logs.length = MAX_AUDIT_LOGS;
  }

  #notify(role, patientId, kind, message) {
    this.data.notifications.push({
      id: this.data.nextNid++,
      role,
      patientId: patientId ?? null,
      kind,
      message,
      dedupKey: null,
      createdAt: Date.now(),
      isRead: false,
    });
  }

  #clearPatientNotifs(role, patientId) {
    for (const n of this.data.notifications) {
      if (n.role === role && n.patientId === patientId && !n.isRead) n.isRead = true;
    }
  }

  prunePastData() {
    const cutoff = bk(PAST_RETENTION_DAYS);
    const closed = this.data.patients
      .filter((p) => p.st === 'disch' || p.st === 'dead')
      .sort((a, b) => (b.out || '').localeCompare(a.out || '') || b.id - a.id);
    const dropIds = new Set();
    for (let i = 0; i < closed.length; i++) {
      if (i >= MAX_PAST_RECORDS || (closed[i].out && closed[i].out < cutoff)) {
        dropIds.add(closed[i].id);
        this.data.archive[closed[i].st] = (this.data.archive[closed[i].st] || 0) + 1;
      }
    }
    if (dropIds.size) {
      this.data.patients = this.data.patients.filter((p) => !dropIds.has(p.id));
      this.#save();
    }
    return dropIds.size;
  }

  authenticate(username, password) {
    const uname = String(username ?? '').trim().toLowerCase();
    const row = this.data.users[uname];
    if (!row || !verifyPassword(password, row.pw_hash)) return null;
    return { username: row.username, n: row.name, r: row.role };
  }

  listUsers() {
    return Object.values(this.data.users).map((u) => ({ username: u.username, n: u.name, r: u.role }));
  }

  createUser(actor, payload) {
    const username = String(payload?.username ?? '').trim().toLowerCase();
    const name = String(payload?.name ?? '').trim();
    const role = String(payload?.role ?? '').trim().toLowerCase();
    const password = String(payload?.password ?? '');
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
      throw new AppError(400, 'Username must be 3–32 characters (letters, numbers, _, ., -)');
    }
    if (!name) throw new AppError(400, 'Staff display name is required');
    if (!['nurse', 'doctor', 'admin'].includes(role)) {
      throw new AppError(400, 'Role must be nurse, doctor, or admin');
    }
    if (password.length < 6) throw new AppError(400, 'Password must be at least 6 characters');
    if (this.data.users[username]) throw new AppError(409, `Username "${username}" already exists`);
    this.data.users[username] = { username, name, role, pw_hash: hashPassword(password), created_at: Date.now() };
    this.#log(actor.n, `Created ${role} account "${username}" (${name})`);
    this.#save();
    return { username, n: name, r: role };
  }

  createSession(username) {
    const token = signToken(username);
    this.data.sessions[token] = username;
    this.#save();
    return token;
  }

  getSessionUser(token) {
    if (!token) return null;
    const direct = this.data.sessions[token];
    const uname = direct || verifySignedToken(token);
    if (!uname) return null;
    const u = this.data.users[uname];
    return u ? { username: u.username, n: u.name, r: u.role } : null;
  }

  deleteSession(token) {
    if (token && this.data.sessions[token]) {
      delete this.data.sessions[token];
      this.#save();
    }
  }

  syncAutomatedReminders(patients = this.data.patients) {
    const specs = buildReminderSpecs(patients, td());
    let changed = false;
    for (const sp of specs) {
      const existing = this.data.notifications.find((n) => n.dedupKey === sp.key);
      if (sp.count === 0) {
        if (existing) {
          existing.isRead = true;
          existing.dedupKey = null;
          changed = true;
        }
        continue;
      }
      if (!existing) {
        this.data.notifications.push({
          id: this.data.nextNid++,
          role: sp.role,
          patientId: null,
          kind: sp.kind,
          message: sp.msg,
          dedupKey: sp.key,
          createdAt: Date.now(),
          isRead: false,
        });
        changed = true;
      } else if (!existing.isRead && existing.message !== sp.msg) {
        existing.message = sp.msg;
        changed = true;
      }
    }
    if (changed) this.#save();
  }

  getState(role = null) {
    const p = structuredClone(this.data.patients);
    this.syncAutomatedReminders(p);
    const notifications = role
      ? this.data.notifications
          .filter((n) => n.role === role && !n.isRead)
          .sort((a, b) => b.id - a.id)
          .slice(0, 20)
          .map(({ id, role: r, patientId, kind, message, createdAt }) => ({ id, role: r, patientId, kind, message, createdAt }))
      : [];
    const staff = role === 'admin' ? this.listUsers() : undefined;
    return {
      p,
      log: this.data.logs.slice(0, MAX_AUDIT_LOGS),
      stats: computeStats(p, this.data.archive),
      analytics: computeAnalytics(p, this.data.archive),
      notifications,
      retention: { days: PAST_RETENTION_DAYS, maxPast: MAX_PAST_RECORDS },
      ...(staff ? { staff } : {}),
    };
  }

  getDailyReport(date = td()) {
    return computeDailyReport(this.data.patients, date, this.data.archive);
  }

  getPatient(id) {
    const p = this.data.patients.find((x) => x.id === id);
    return p ? structuredClone(p) : null;
  }

  #requireActiveMut(id) {
    const p = this.data.patients.find((x) => x.id === id);
    if (!p) throw new AppError(404, 'Patient not found');
    if (p.st !== 'active') throw new AppError(409, 'Patient is no longer active in the ward');
    return p;
  }

  recordTemp(id, user, cRaw) {
    const c = Number(cRaw);
    if (Number.isNaN(c) || c < 34 || c > 43) throw new AppError(400, 'Enter a temperature between 34 and 43 °C');
    const p = this.#requireActiveMut(id);
    if (tod(p).length) throw new AppError(409, 'Temperature already measured today');
    const wasReady = rdy(p);
    p.t.push({ id: this.data.nextTid++, d: td(), c: +c.toFixed(1), at: hm(), by: user.n });
    if (c >= TH && p.conf) { p.conf = false; p.confBy = null; }
    this.#log(user.n, `Recorded ${c.toFixed(1)}°C for ${p.name} (bed ${p.bed})`);
    if (!wasReady && rdy(p) && !p.conf) {
      this.#notify('doctor', id, 'eligible', `Bed ${p.bed} (${p.name}) reached 3 fever-free days — ready for discharge approval.`);
    }
    this.#save();
    return structuredClone(p);
  }

  amendTemp(id, user, cRaw, reasonRaw) {
    const c = Number(cRaw);
    const reason = String(reasonRaw ?? '').trim();
    if (Number.isNaN(c) || c < 34 || c > 43) throw new AppError(400, 'Enter a temperature between 34 and 43 °C');
    if (!reason) throw new AppError(400, 'Reason for correction is required');
    const p = this.#requireActiveMut(id);
    const wasReady = rdy(p);
    const tr = tod(p);
    const target = tr[tr.length - 1] ?? p.t[p.t.length - 1];
    if (!target) throw new AppError(409, 'No temperature reading to correct');
    const oldC = target.c;
    const newC = +c.toFixed(1);
    target.c = newC;
    target.am = reason;
    if (!rdy(p) && p.conf) { p.conf = false; p.confBy = null; }
    if (!wasReady && rdy(p) && !p.conf) {
      this.#notify('doctor', id, 'eligible', `Bed ${p.bed} (${p.name}) reached 3 fever-free days — ready for discharge approval.`);
    } else if (!rdy(p)) {
      this.#clearPatientNotifs('doctor', id);
      this.#clearPatientNotifs('admin', id);
    }
    this.#log(user.n, `Corrected ${p.name}: ${oldC}→${newC}°C (${reason})`);
    this.#save();
    return structuredClone(p);
  }

  recordVisit(id, user, noteRaw = '', approve = false) {
    const note = String(noteRaw ?? '').trim();
    const p = this.#requireActiveMut(id);
    if (!tod(p).length) throw new AppError(409, 'Temperature not taken yet today');
    if (vis(p)) throw new AppError(409, 'Patient already visited today');
    p.v.push({ id: this.data.nextVid++, d: td(), at: hm(), by: user.n, note });
    if (approve) {
      if (!rdy(p)) throw new AppError(409, 'Patient has not completed 3 fever-free days');
      if (!p.conf) {
        p.conf = true;
        p.confBy = user.n;
        this.#clearPatientNotifs('doctor', id);
        this.#notify('admin', id, 'approved', `${user.n} approved discharge for Bed ${p.bed} (${p.name}). Ready to discharge & free bed.`);
      }
      this.#log(user.n, `Visited ${p.name} & approved discharge${note ? ' – ' + note : ''}`);
    } else {
      this.#log(user.n, `Visited ${p.name}${note ? ' – note added' : ''}`);
    }
    this.#save();
    return structuredClone(p);
  }

  approveDischarge(id, user) {
    const p = this.#requireActiveMut(id);
    if (!rdy(p)) throw new AppError(409, 'Patient has not completed 3 fever-free days');
    if (p.conf) throw new AppError(409, 'Discharge already approved');
    p.conf = true;
    p.confBy = user.n;
    this.#clearPatientNotifs('doctor', id);
    this.#notify('admin', id, 'approved', `${user.n} approved discharge for Bed ${p.bed} (${p.name}). Ready to discharge & free bed.`);
    this.#log(user.n, `Approved discharge for ${p.name} (bed ${p.bed})`);
    this.#save();
    return structuredClone(p);
  }

  dischargePatient(id, user) {
    const p = this.#requireActiveMut(id);
    if (!rdy(p) || !p.conf) throw new AppError(409, 'Discharge requires 3 fever-free days and doctor approval');
    const freedBed = p.bed;
    p.st = 'disch';
    p.out = td();
    p.bed = 0;
    this.#clearPatientNotifs('admin', id);
    this.#clearPatientNotifs('doctor', id);
    this.#log(user.n, `Discharged ${p.name} (bed ${freedBed})`);
    this.prunePastData();
    this.#save();
    return { patient: structuredClone(p), freedBed };
  }

  recordDeath(id, user) {
    const p = this.#requireActiveMut(id);
    const freedBed = p.bed;
    p.st = 'dead';
    p.out = td();
    p.bed = 0;
    this.#clearPatientNotifs('admin', id);
    this.#clearPatientNotifs('doctor', id);
    this.#log(user.n, `Recorded death of ${p.name} (bed ${freedBed})`);
    const s = computeStats(this.data.patients, this.data.archive);
    if ((s.mr30 != null && s.mr30 > BM) || (s.mr != null && s.mr > BM)) {
      const msg = `Mortality alert: 30-day mortality is ${((s.mr30 ?? s.mr) * 100).toFixed(1)}% (above 15% benchmark).`;
      this.#notify('doctor', null, 'mortality', msg);
      this.#notify('admin', null, 'mortality', msg);
    }
    this.prunePastData();
    this.#save();
    return { patient: structuredClone(p), freedBed };
  }

  admitPatient(user, payload) {
    const name = String(payload?.name ?? '').trim();
    const age = Number(payload?.age);
    const gender = String(payload?.gender ?? '').trim();
    const phone = String(payload?.phone ?? '').trim();
    const notes = String(payload?.notes ?? '').trim();
    const requestedBed = payload?.bed ? Number(payload.bed) : 0;
    if (!name) throw new AppError(400, 'Patient name is required');
    if (!Number.isInteger(age) || age < 1 || age > 120) throw new AppError(400, 'Valid age (1–120) is required');
    let bed = findFreeBed(this.data.patients);
    if (!bed) throw new AppError(409, `Ward is at full capacity (${CAP}/${CAP})`);
    if (requestedBed) {
      if (!Number.isInteger(requestedBed) || requestedBed < 1 || requestedBed > CAP) {
        throw new AppError(400, `Bed must be between 1 and ${CAP}`);
      }
      if (this.data.patients.some((r) => r.st === 'active' && r.bed === requestedBed)) {
        throw new AppError(409, `Bed ${requestedBed} is already occupied`);
      }
      bed = requestedBed;
    }
    const patient = {
      id: this.data.nextPid++,
      name,
      age,
      gender,
      phone,
      notes,
      bed,
      adm: td(),
      st: 'active',
      out: null,
      conf: false,
      confBy: null,
      t: [],
      v: [],
    };
    this.data.patients.push(patient);
    this.#log(user.n, `Admitted ${name} (${age}y${gender ? ', ' + gender : ''}) to bed ${bed}`);
    this.#save();
    return structuredClone(patient);
  }

  markNotificationRead(role, id = null) {
    for (const n of this.data.notifications) {
      if (n.role === role && (id == null || n.id === id)) n.isRead = true;
    }
    this.#save();
  }

  close() {
    this.#save();
  }
}
