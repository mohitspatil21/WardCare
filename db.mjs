import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  BM,
  CAP,
  MAX_AUDIT_LOGS,
  MAX_PAST_RECORDS,
  PAST_RETENTION_DAYS,
  TH,
  bk,
  computeAnalytics,
  computeDailyReport,
  computeStats,
  findFreeBed,
  hashPassword,
  hm,
  rdy,
  td,
  tod,
  verifyPassword,
  vis,
} from './ward-logic.mjs';

const INITIAL_STAFF = [
  { username: 'priya', name: 'Priya (Nurse)', role: 'nurse', pw: 'nurse123' },
  { username: 'anil', name: 'Anil (Nurse)', role: 'nurse', pw: 'nurse123' },
  { username: 'mehta', name: 'Dr. Mehta', role: 'doctor', pw: 'doc123' },
  { username: 'rao', name: 'Dr. Rao', role: 'doctor', pw: 'doc123' },
  { username: 'sunita', name: 'Sunita (Admin)', role: 'admin', pw: 'admin123' },
];

/** Domain error carrying an HTTP status code. */
export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** SQLite-backed persistence store with bounded past-data retention for WardCare. */
export class WardStore {
  constructor(dbPath = './ward-care.db') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    this.#initSchema();
    this.#initUsers();
    this.prunePastData();
  }

  #initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        pw_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS patients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER NOT NULL,
        gender TEXT NOT NULL DEFAULT '',
        phone TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        bed INTEGER NOT NULL DEFAULT 0,
        adm TEXT NOT NULL,
        st TEXT NOT NULL DEFAULT 'active',
        out_date TEXT,
        conf INTEGER NOT NULL DEFAULT 0,
        conf_by TEXT
      );
      CREATE TABLE IF NOT EXISTS temperatures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        d TEXT NOT NULL,
        c REAL NOT NULL,
        at TEXT NOT NULL,
        by_user TEXT NOT NULL,
        am TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_temp_patient ON temperatures(patient_id, d);
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
        d TEXT NOT NULL,
        at TEXT,
        by_user TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_visit_patient ON visits(patient_id, d);
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        u TEXT NOT NULL,
        a TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL,
        patient_id INTEGER,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        dedup_key TEXT,
        created_at INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_notif_role ON notifications(role, is_read);
      CREATE TABLE IF NOT EXISTS ward_archive (
        key TEXT PRIMARY KEY,
        val INTEGER NOT NULL DEFAULT 0
      );
    `);

    const cols = new Set(this.db.prepare('PRAGMA table_info(patients)').all().map((c) => c.name));
    if (!cols.has('gender')) this.db.exec("ALTER TABLE patients ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
    if (!cols.has('phone')) this.db.exec("ALTER TABLE patients ADD COLUMN phone TEXT NOT NULL DEFAULT ''");
    if (!cols.has('notes')) this.db.exec("ALTER TABLE patients ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
    const nCols = new Set(this.db.prepare('PRAGMA table_info(notifications)').all().map((c) => c.name));
    if (!nCols.has('dedup_key')) this.db.exec('ALTER TABLE notifications ADD COLUMN dedup_key TEXT');
    this.db.exec("INSERT OR IGNORE INTO ward_archive (key, val) VALUES ('disch', 0), ('dead', 0);");
  }

  #initUsers() {
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    if (count > 0) return;
    const ins = this.db.prepare(
      'INSERT INTO users (username, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    const now = Date.now();
    this.#inTx(() => {
      for (const s of INITIAL_STAFF) {
        ins.run(s.username, s.name, s.role, hashPassword(s.pw), now);
      }
    });
  }

  #inTx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  #notify(role, patientId, kind, message) {
    this.db
      .prepare('INSERT INTO notifications (role, patient_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(role, patientId ?? null, kind, message, Date.now());
  }

  #clearPatientNotifs(role, patientId) {
    this.db
      .prepare('UPDATE notifications SET is_read = 1 WHERE role = ? AND patient_id = ? AND is_read = 0')
      .run(role, patientId);
  }

  #log(userName, action) {
    this.db.prepare('INSERT INTO audit_log (ts, u, a) VALUES (?, ?, ?)').run(
      Date.now(),
      userName,
      action
    );
    this.db
      .prepare('DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY id DESC LIMIT ?)')
      .run(MAX_AUDIT_LOGS);
  }

  /**
   * Enforce limited past-data retention: keep only closed patients from the last
   * PAST_RETENTION_DAYS and at most MAX_PAST_RECORDS, archiving pruned outcome counts.
   */
  prunePastData() {
    const cutoff = bk(PAST_RETENTION_DAYS);
    return this.#inTx(() => {
      const closed = this.db
        .prepare("SELECT id, st, out_date FROM patients WHERE st IN ('disch', 'dead') ORDER BY out_date DESC, id DESC")
        .all();
      const toPrune = [];
      for (let i = 0; i < closed.length; i++) {
        const row = closed[i];
        if (i >= MAX_PAST_RECORDS || (row.out_date && row.out_date < cutoff)) {
          toPrune.push(row);
        }
      }
      if (!toPrune.length) return 0;
      const incArch = this.db.prepare('UPDATE ward_archive SET val = val + 1 WHERE key = ?');
      const delP = this.db.prepare('DELETE FROM patients WHERE id = ?');
      for (const r of toPrune) {
        incArch.run(r.st);
        delP.run(r.id);
      }
      return toPrune.length;
    });
  }

  /** Verify username & password against SQLite users table. */
  authenticate(username, password) {
    const uname = String(username ?? '').trim().toLowerCase();
    const row = this.db
      .prepare('SELECT username, name, role, pw_hash FROM users WHERE username = ?')
      .get(uname);
    if (!row || !verifyPassword(password, row.pw_hash)) return null;
    return { username: row.username, n: row.name, r: row.role };
  }

  /** List all registered staff accounts (without password hashes). */
  listUsers() {
    return this.db
      .prepare('SELECT username, name AS n, role AS r FROM users ORDER BY created_at ASC, username ASC')
      .all();
  }

  /** Register a new staff account in the database. */
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
    if (password.length < 6) {
      throw new AppError(400, 'Password must be at least 6 characters');
    }
    const exists = this.db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) throw new AppError(409, `Username "${username}" already exists`);
    this.#inTx(() => {
      this.db
        .prepare('INSERT INTO users (username, name, role, pw_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(username, name, role, hashPassword(password), Date.now());
      this.#log(actor.n, `Created ${role} account "${username}" (${name})`);
    });
    return { username, n: name, r: role };
  }

  /** Create a persisted authentication session token for a verified username. */
  createSession(username) {
    const token = crypto.randomBytes(32).toString('hex');
    this.db
      .prepare('INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)')
      .run(token, username, Date.now());
    return token;
  }

  /** Look up a valid session token and return safe user details, or null. */
  getSessionUser(token) {
    if (!token) return null;
    const row = this.db
      .prepare(
        'SELECT u.username, u.name, u.role FROM sessions s JOIN users u ON u.username = s.username WHERE s.token = ?'
      )
      .get(token);
    return row ? { username: row.username, n: row.name, r: row.role } : null;
  }

  /** Invalidate a session token on logout. */
  deleteSession(token) {
    if (token) this.db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  }

  #getArchive() {
    const rows = this.db.prepare('SELECT key, val FROM ward_archive').all();
    const out = { disch: 0, dead: 0 };
    for (const r of rows) out[r.key] = r.val;
    return out;
  }

  #hydratePatients(rows) {
    if (!rows.length) return [];
    const tempsByPid = new Map();
    const visitsByPid = new Map();
    const tRows = this.db
      .prepare('SELECT id, patient_id, d, c, at, by_user, am FROM temperatures ORDER BY id ASC')
      .all();
    for (const r of tRows) {
      let arr = tempsByPid.get(r.patient_id);
      if (!arr) { arr = []; tempsByPid.set(r.patient_id, arr); }
      arr.push({ id: r.id, d: r.d, c: r.c, at: r.at, by: r.by_user, ...(r.am ? { am: r.am } : {}) });
    }
    const vRows = this.db
      .prepare('SELECT id, patient_id, d, at, by_user, note FROM visits ORDER BY id ASC')
      .all();
    for (const v of vRows) {
      let arr = visitsByPid.get(v.patient_id);
      if (!arr) { arr = []; visitsByPid.set(v.patient_id, arr); }
      arr.push({ id: v.id, d: v.d, ...(v.at ? { at: v.at } : {}), by: v.by_user, note: v.note });
    }
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      age: r.age,
      gender: r.gender || '',
      phone: r.phone || '',
      notes: r.notes || '',
      bed: r.bed,
      adm: r.adm,
      st: r.st,
      out: r.out_date,
      conf: Boolean(r.conf),
      confBy: r.conf_by,
      t: tempsByPid.get(r.id) ?? [],
      v: visitsByPid.get(r.id) ?? [],
    }));
  }

  /** Synchronize automated daily reminders for pending nurse temps, doctor visits, approvals, and discharges. */
  syncAutomatedReminders(patients = null) {
    const p = patients ?? this.#hydratePatients(this.db.prepare('SELECT * FROM patients ORDER BY id ASC').all());
    const today = td();
    const active = p.filter((x) => x.st === 'active');
    const pendingTemps = active.filter((x) => !tod(x, today).length);
    const readyVisits = active.filter((x) => tod(x, today).length && !vis(x, today));
    const awaitApprove = active.filter((x) => rdy(x) && !x.conf);
    const readyDisch = active.filter((x) => rdy(x) && x.conf);

    const specs = [
      {
        role: 'nurse',
        kind: 'reminder',
        key: `${today}:nurse:temp`,
        count: pendingTemps.length,
        msg: `Reminder: ${pendingTemps.length} patient(s) still awaiting today's temperature check (e.g. Bed ${pendingTemps.slice(0, 5).map((x) => x.bed).join(', ')}).`,
      },
      {
        role: 'doctor',
        kind: 'reminder',
        key: `${today}:doctor:visit`,
        count: readyVisits.length,
        msg: `Reminder: ${readyVisits.length} measured patient(s) ready for doctor visit today.`,
      },
      {
        role: 'doctor',
        kind: 'reminder',
        key: `${today}:doctor:approve`,
        count: awaitApprove.length,
        msg: `Reminder: ${awaitApprove.length} patient(s) have 3 fever-free days awaiting discharge approval.`,
      },
      {
        role: 'admin',
        kind: 'reminder',
        key: `${today}:admin:disch`,
        count: readyDisch.length,
        msg: `Reminder: ${readyDisch.length} doctor-approved patient(s) waiting to be discharged.`,
      },
    ];

    const findStmt = this.db.prepare('SELECT id, message, is_read FROM notifications WHERE dedup_key = ?');
    const insStmt = this.db.prepare(
      'INSERT INTO notifications (role, patient_id, kind, message, dedup_key, created_at) VALUES (?, NULL, ?, ?, ?, ?)'
    );
    const updStmt = this.db.prepare('UPDATE notifications SET message = ? WHERE id = ?');
    const resolveStmt = this.db.prepare('UPDATE notifications SET is_read = 1, dedup_key = NULL WHERE dedup_key = ?');

    for (const sp of specs) {
      if (sp.count === 0) {
        resolveStmt.run(sp.key);
        continue;
      }
      const existing = findStmt.get(sp.key);
      if (!existing) {
        insStmt.run(sp.role, sp.kind, sp.msg, sp.key, Date.now());
      } else if (!existing.is_read && existing.message !== sp.msg) {
        updStmt.run(sp.msg, existing.id);
      }
    }
  }

  /** Return full real-time ward state (patients, audit log, stats, analytics, retention policy, notifications). */
  getState(role = null) {
    const pRows = this.db.prepare('SELECT * FROM patients ORDER BY id ASC').all();
    const p = this.#hydratePatients(pRows);
    this.syncAutomatedReminders(p);
    const log = this.db
      .prepare('SELECT ts, u, a FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(MAX_AUDIT_LOGS);
    const notifications = role
      ? this.db
          .prepare('SELECT id, role, patient_id AS patientId, kind, message, created_at AS createdAt FROM notifications WHERE role = ? AND is_read = 0 ORDER BY id DESC LIMIT 20')
          .all(role)
      : [];
    const archive = this.#getArchive();
    const staff = role === 'admin' ? this.listUsers() : undefined;
    return {
      p,
      log,
      stats: computeStats(p, archive),
      analytics: computeAnalytics(p, archive),
      notifications,
      retention: { days: PAST_RETENTION_DAYS, maxPast: MAX_PAST_RECORDS },
      ...(staff ? { staff } : {}),
    };
  }

  /** Compute daily performance report for the given YYYY-MM-DD date. */
  getDailyReport(date = td()) {
    const pRows = this.db.prepare('SELECT * FROM patients ORDER BY id ASC').all();
    const p = this.#hydratePatients(pRows);
    return computeDailyReport(p, date, this.#getArchive());
  }

  /** Return a single hydrated patient by ID, or null if not found. */
  getPatient(id) {
    const row = this.db.prepare('SELECT * FROM patients WHERE id = ?').get(id);
    if (!row) return null;
    const t = this.db
      .prepare('SELECT id, d, c, at, by_user AS by, am FROM temperatures WHERE patient_id = ? ORDER BY id ASC')
      .all(id)
      .map((r) => (r.am ? r : { id: r.id, d: r.d, c: r.c, at: r.at, by: r.by }));
    const v = this.db
      .prepare('SELECT id, d, at, by_user AS by, note FROM visits WHERE patient_id = ? ORDER BY id ASC')
      .all(id);
    return {
      id: row.id,
      name: row.name,
      age: row.age,
      gender: row.gender || '',
      phone: row.phone || '',
      notes: row.notes || '',
      bed: row.bed,
      adm: row.adm,
      st: row.st,
      out: row.out_date,
      conf: Boolean(row.conf),
      confBy: row.conf_by,
      t,
      v,
    };
  }

  #requireActive(id) {
    const p = this.getPatient(id);
    if (!p) throw new AppError(404, 'Patient not found');
    if (p.st !== 'active') throw new AppError(409, 'Patient is no longer active in the ward');
    return p;
  }

  /** Record today's temperature for an active patient (max once per day). */
  recordTemp(id, user, cRaw) {
    const c = Number(cRaw);
    if (Number.isNaN(c) || c < 34 || c > 43) {
      throw new AppError(400, 'Enter a temperature between 34 and 43 °C');
    }
    return this.#inTx(() => {
      const p = this.#requireActive(id);
      if (tod(p).length) throw new AppError(409, 'Temperature already measured today');
      const wasReady = rdy(p);
      this.db
        .prepare('INSERT INTO temperatures (patient_id, d, c, at, by_user) VALUES (?, ?, ?, ?, ?)')
        .run(id, td(), +c.toFixed(1), hm(), user.n);
      if (c >= TH && p.conf) {
        this.db.prepare('UPDATE patients SET conf = 0, conf_by = NULL WHERE id = ?').run(id);
      }
      this.#log(user.n, `Recorded ${c.toFixed(1)}°C for ${p.name} (bed ${p.bed})`);
      const updated = this.getPatient(id);
      if (!wasReady && rdy(updated) && !updated.conf) {
        this.#notify(
          'doctor',
          id,
          'eligible',
          `Bed ${p.bed} (${p.name}) reached 3 fever-free days — ready for discharge approval.`
        );
      }
      return updated;
    });
  }

  /** Correct today's temperature reading with a mandatory audit reason. */
  amendTemp(id, user, cRaw, reasonRaw) {
    const c = Number(cRaw);
    const reason = String(reasonRaw ?? '').trim();
    if (Number.isNaN(c) || c < 34 || c > 43) {
      throw new AppError(400, 'Enter a temperature between 34 and 43 °C');
    }
    if (!reason) throw new AppError(400, 'Reason for correction is required');
    return this.#inTx(() => {
      const p = this.#requireActive(id);
      const wasReady = rdy(p);
      const todayReadings = tod(p);
      const target = todayReadings[todayReadings.length - 1] ?? p.t[p.t.length - 1];
      if (!target) throw new AppError(409, 'No temperature reading to correct');
      const oldC = target.c;
      const newC = +c.toFixed(1);
      this.db.prepare('UPDATE temperatures SET c = ?, am = ? WHERE id = ?').run(newC, reason, target.id);
      const updated = this.getPatient(id);
      if (!rdy(updated) && updated.conf) {
        this.db.prepare('UPDATE patients SET conf = 0, conf_by = NULL WHERE id = ?').run(id);
      }
      if (!wasReady && rdy(updated) && !updated.conf) {
        this.#notify(
          'doctor',
          id,
          'eligible',
          `Bed ${p.bed} (${p.name}) reached 3 fever-free days — ready for discharge approval.`
        );
      } else if (!rdy(updated)) {
        this.#clearPatientNotifs('doctor', id);
        this.#clearPatientNotifs('admin', id);
      }
      this.#log(user.n, `Corrected ${p.name}: ${oldC}→${newC}°C (${reason})`);
      return this.getPatient(id);
    });
  }

  /** Record a doctor's daily visit (requires today's temperature first). */
  recordVisit(id, user, noteRaw = '', approve = false) {
    const note = String(noteRaw ?? '').trim();
    return this.#inTx(() => {
      const p = this.#requireActive(id);
      if (!tod(p).length) throw new AppError(409, 'Temperature not taken yet today');
      if (vis(p)) throw new AppError(409, 'Patient already visited today');
      this.db
        .prepare('INSERT INTO visits (patient_id, d, at, by_user, note) VALUES (?, ?, ?, ?, ?)')
        .run(id, td(), hm(), user.n, note);
      if (approve) {
        if (!rdy(p)) throw new AppError(409, 'Patient has not completed 3 fever-free days');
        if (!p.conf) {
          this.db.prepare('UPDATE patients SET conf = 1, conf_by = ? WHERE id = ?').run(user.n, id);
          this.#clearPatientNotifs('doctor', id);
          this.#notify(
            'admin',
            id,
            'approved',
            `${user.n} approved discharge for Bed ${p.bed} (${p.name}). Ready to discharge & free bed.`
          );
        }
        this.#log(user.n, `Visited ${p.name} & approved discharge${note ? ' – ' + note : ''}`);
      } else {
        this.#log(user.n, `Visited ${p.name}${note ? ' – note added' : ''}`);
      }
      return this.getPatient(id);
    });
  }

  /** Approve a 3-day fever-free patient for admin discharge. */
  approveDischarge(id, user) {
    return this.#inTx(() => {
      const p = this.#requireActive(id);
      if (!rdy(p)) throw new AppError(409, 'Patient has not completed 3 fever-free days');
      if (p.conf) throw new AppError(409, 'Discharge already approved');
      this.db.prepare('UPDATE patients SET conf = 1, conf_by = ? WHERE id = ?').run(user.n, id);
      this.#clearPatientNotifs('doctor', id);
      this.#notify(
        'admin',
        id,
        'approved',
        `${user.n} approved discharge for Bed ${p.bed} (${p.name}). Ready to discharge & free bed.`
      );
      this.#log(user.n, `Approved discharge for ${p.name} (bed ${p.bed})`);
      return this.getPatient(id);
    });
  }

  /** Complete an admin discharge for a doctor-approved patient, free their bed, and enforce retention. */
  dischargePatient(id, user) {
    const res = this.#inTx(() => {
      const p = this.#requireActive(id);
      if (!rdy(p) || !p.conf) {
        throw new AppError(409, 'Discharge requires 3 fever-free days and doctor approval');
      }
      this.db
        .prepare("UPDATE patients SET st = 'disch', out_date = ?, bed = 0 WHERE id = ?")
        .run(td(), id);
      this.#clearPatientNotifs('admin', id);
      this.#clearPatientNotifs('doctor', id);
      this.#log(user.n, `Discharged ${p.name} (bed ${p.bed})`);
      return { patient: this.getPatient(id), freedBed: p.bed };
    });
    this.prunePastData();
    return res;
  }

  /** Record a patient death, free their bed, enforce retention, and alert if mortality exceeds 15%. */
  recordDeath(id, user) {
    const res = this.#inTx(() => {
      const p = this.#requireActive(id);
      this.db
        .prepare("UPDATE patients SET st = 'dead', out_date = ?, bed = 0 WHERE id = ?")
        .run(td(), id);
      this.#clearPatientNotifs('admin', id);
      this.#clearPatientNotifs('doctor', id);
      this.#log(user.n, `Recorded death of ${p.name} (bed ${p.bed})`);
      const rows = this.db.prepare('SELECT id, st, adm, out_date AS out FROM patients').all();
      const s = computeStats(rows, this.#getArchive());
      if ((s.mr30 != null && s.mr30 > BM) || (s.mr != null && s.mr > BM)) {
        const msg = `Mortality alert: 30-day mortality is ${((s.mr30 ?? s.mr) * 100).toFixed(1)}% (above 15% benchmark).`;
        this.#notify('doctor', null, 'mortality', msg);
        this.#notify('admin', null, 'mortality', msg);
      }
      return { patient: this.getPatient(id), freedBed: p.bed };
    });
    this.prunePastData();
    return res;
  }

  /** Admit a new patient into the specified or lowest available bed (max 74). */
  admitPatient(user, payload) {
    const name = String(payload?.name ?? '').trim();
    const age = Number(payload?.age);
    const gender = String(payload?.gender ?? '').trim();
    const phone = String(payload?.phone ?? '').trim();
    const notes = String(payload?.notes ?? '').trim();
    const requestedBed = payload?.bed ? Number(payload.bed) : 0;

    if (!name) throw new AppError(400, 'Patient name is required');
    if (!Number.isInteger(age) || age < 1 || age > 120) {
      throw new AppError(400, 'Valid age (1–120) is required');
    }
    return this.#inTx(() => {
      const rows = this.db.prepare("SELECT bed, st FROM patients WHERE st = 'active'").all();
      let bed = findFreeBed(rows);
      if (!bed) throw new AppError(409, `Ward is at full capacity (${CAP}/${CAP})`);
      if (requestedBed) {
        if (!Number.isInteger(requestedBed) || requestedBed < 1 || requestedBed > CAP) {
          throw new AppError(400, `Bed must be between 1 and ${CAP}`);
        }
        if (rows.some((r) => r.bed === requestedBed)) {
          throw new AppError(409, `Bed ${requestedBed} is already occupied`);
        }
        bed = requestedBed;
      }
      const info = this.db
        .prepare("INSERT INTO patients (name, age, gender, phone, notes, bed, adm, st) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')")
        .run(name, age, gender, phone, notes, bed, td());
      const id = Number(info.lastInsertRowid);
      this.#log(user.n, `Admitted ${name} (${age}y${gender ? ', ' + gender : ''}) to bed ${bed}`);
      return this.getPatient(id);
    });
  }

  /** Mark a single notification or all role notifications as read. */
  markNotificationRead(role, id = null) {
    if (id == null) {
      this.db.prepare('UPDATE notifications SET is_read = 1 WHERE role = ?').run(role);
    } else {
      this.db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND role = ?').run(id, role);
    }
  }

  close() {
    this.db.close();
  }
}
