/**
 * Shared clinical rules, permissions, password hashing, and benchmark calculations for WardCare.
 */

import crypto from 'node:crypto';

export const TH = 38;
export const CAP = 74;
export const BM = 0.15;
export const PAST_RETENTION_DAYS = 30;
export const MAX_PAST_RECORDS = 50;
export const MAX_AUDIT_LOGS = 300;

export const CAN = {
  temp: ['nurse'],
  visit: ['doctor'],
  confirm: ['doctor'],
  death: ['doctor', 'admin'],
  admit: ['admin'],
  disch: ['admin'],
  amend: ['nurse', 'doctor'],
  manageUsers: ['admin'],
};

/** Hash a password with a random 16-byte salt using scrypt. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

/** Verify a plaintext password against a stored `salt:hash` string. */
export function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 2) return false;
  const [salt, expectedHex] = parts;
  const candidate = crypto.scryptSync(String(password ?? ''), salt, 32);
  const expected = Buffer.from(expectedHex, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

/** Format a Date as local YYYY-MM-DD. */
export function iso(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}

/** Return local YYYY-MM-DD offset n days in the past. */
export function bk(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return iso(d);
}

/** Return today's local YYYY-MM-DD. */
export const td = () => bk(0);

/** Return current HH:MM local time string. */
export const hm = () => new Date().toTimeString().slice(0, 5);

/** Whole-day difference between two YYYY-MM-DD strings. */
export const dd = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);

/** Check whether a role is authorized for an action. */
export const canRole = (role, action) => Boolean(CAN[action]?.includes(role));

/** Readings recorded today for a patient. */
export const tod = (p, today = td()) => p.t.filter((x) => x.d === today);

/** Whether a patient was visited by a doctor today. */
export const vis = (p, today = td()) => p.v.some((x) => x.d === today);

/** Consecutive fever-free days (< TH °C) looking backwards from today. */
export function stk(p) {
  let s = 0;
  for (let i = 0; i < 60; i++) {
    const d = bk(i);
    const r = p.t.filter((x) => x.d === d);
    if (!r.length) {
      if (i === 0) continue;
      break;
    }
    if (r.some((x) => x.c >= TH)) break;
    s++;
  }
  return s;
}

/** Whether a patient satisfies the 3-day fever-free cure criterion. */
export const rdy = (p) => stk(p) >= 3;

/** Find the lowest unoccupied bed number in 1..CAP, or 0 if full. */
export function findFreeBed(patients) {
  const used = new Set(patients.filter((p) => p.st === 'active').map((p) => p.bed));
  for (let i = 1; i <= CAP; i++) {
    if (!used.has(i)) return i;
  }
  return 0;
}

/** Compute mortality and recovery benchmark metrics including archived past counts. */
export function computeStats(patients, archive = { disch: 0, dead: 0 }) {
  const ds = patients.filter((p) => p.st === 'disch');
  const dt = patients.filter((p) => p.st === 'dead');
  const c = bk(30);
  const recent = (l) => l.filter((p) => p.out && p.out >= c).length;
  const d3 = recent(dt);
  const s3 = recent(ds);
  const totalS = ds.length + (archive.disch || 0);
  const totalD = dt.length + (archive.dead || 0);
  const f = totalS + totalD;
  const f3 = d3 + s3;
  const mr = f ? totalD / f : null;
  const mr30 = f3 ? d3 / f3 : null;
  const los = ds.length
    ? ds.reduce((acc, p) => acc + dd(p.adm, p.out), 0) / ds.length
    : 0;
  return {
    mr,
    mr30,
    sr: mr == null ? null : 1 - mr,
    sr30: mr30 == null ? null : 1 - mr30,
    n: f,
    d: totalD,
    s: totalS,
    f3,
    d3,
    s3,
    los,
    retainedPast: ds.length + dt.length,
    archivedPast: (archive.disch || 0) + (archive.dead || 0),
  };
}
