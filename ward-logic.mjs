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

export const INITIAL_STAFF = [
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

const TOKEN_SECRET = process.env.WARD_SECRET || 'wardcare-serverless-session-secret';

/** Sign an HMAC session token containing username and expiry for stateless fallback. */
export function signToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + 7 * 864e5 })).toString('base64url');
  const sig = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

/** Verify an HMAC session token and return its username if valid and unexpired. */
export function verifySignedToken(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.u || (data.exp && Date.now() > data.exp)) return null;
    return data.u;
  } catch {
    return null;
  }
}

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

/** Build role-targeted automated reminder specs for today's pending ward tasks. */
export function buildReminderSpecs(patients, today = td()) {
  const active = patients.filter((x) => x.st === 'active');
  const pendingTemps = active.filter((x) => !tod(x, today).length);
  const readyVisits = active.filter((x) => tod(x, today).length && !vis(x, today));
  const awaitApprove = active.filter((x) => rdy(x) && !x.conf);
  const readyDisch = active.filter((x) => rdy(x) && x.conf);
  return [
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
}

/** Compute advanced ward analytics: 14-day fever trend, age cohorts, and compliance. */
export function computeAnalytics(patients, archive = { disch: 0, dead: 0 }) {
  const active = patients.filter((p) => p.st === 'active');
  const today = td();
  const dailyTrend = [];
  for (let i = 13; i >= 0; i--) {
    const date = bk(i);
    let readings = 0;
    let fevers = 0;
    let sumTemp = 0;
    for (const p of patients) {
      const dayReads = p.t.filter((x) => x.d === date);
      if (!dayReads.length) continue;
      readings += dayReads.length;
      if (dayReads.some((x) => x.c >= TH)) fevers++;
      sumTemp += dayReads.reduce((a, x) => a + x.c, 0);
    }
    dailyTrend.push({
      date,
      readings,
      fevers,
      feverRate: readings ? fevers / readings : null,
      avgTemp: readings ? +(sumTemp / readings).toFixed(2) : null,
    });
  }

  const bands = [
    { label: '<30', match: (age) => age < 30 },
    { label: '30–49', match: (age) => age >= 30 && age < 50 },
    { label: '50–64', match: (age) => age >= 50 && age < 65 },
    { label: '65+', match: (age) => age >= 65 },
  ];
  const ageCohorts = bands.map((b) => {
    const group = patients.filter((p) => b.match(p.age));
    const act = group.filter((p) => p.st === 'active').length;
    const disch = group.filter((p) => p.st === 'disch').length;
    const dead = group.filter((p) => p.st === 'dead').length;
    const closed = disch + dead;
    return {
      label: b.label,
      active: act,
      discharged: disch,
      deceased: dead,
      mortalityRate: closed ? dead / closed : null,
    };
  });

  const measuredToday = active.filter((p) => tod(p, today).length > 0).length;
  const visitedToday = active.filter((p) => vis(p, today)).length;
  const eligible = active.filter((p) => rdy(p));
  const awaitingApproval = eligible.filter((p) => !p.conf).length;
  const approvedWaiting = eligible.filter((p) => p.conf).length;
  const ds = patients.filter((p) => p.st === 'disch');
  const dt = patients.filter((p) => p.st === 'dead');

  return {
    occupancyRate: active.length / CAP,
    freeBeds: Math.max(0, CAP - active.length),
    tempCompliance: active.length ? measuredToday / active.length : 1,
    visitCompliance: active.length ? visitedToday / active.length : 1,
    awaitingApproval,
    approvedWaiting,
    avgStayCured: ds.length ? ds.reduce((a, p) => a + dd(p.adm, p.out), 0) / ds.length : 0,
    avgStayDeceased: dt.length ? dt.reduce((a, p) => a + dd(p.adm, p.out), 0) / dt.length : 0,
    dailyTrend,
    ageCohorts,
    stats: computeStats(patients, archive),
  };
}

/** Generate a structured daily performance report for a specific YYYY-MM-DD date. */
export function computeDailyReport(patients, date = td(), archive = { disch: 0, dead: 0 }) {
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(String(date)) ? String(date) : td();
  const activeOnDate = patients.filter(
    (p) => p.adm <= targetDate && (!p.out || p.out >= targetDate)
  );
  const admissions = patients.filter((p) => p.adm === targetDate).length;
  const discharges = patients.filter((p) => p.st === 'disch' && p.out === targetDate).length;
  const deaths = patients.filter((p) => p.st === 'dead' && p.out === targetDate).length;

  let measuredCount = 0;
  let feverCount = 0;
  let visitedCount = 0;
  const rows = [];

  for (const p of activeOnDate) {
    const dayTemps = p.t.filter((x) => x.d === targetDate);
    const dayVisits = p.v.filter((x) => x.d === targetDate);
    const latestOnDay = dayTemps[dayTemps.length - 1] || null;
    const hasTemp = dayTemps.length > 0;
    const hasFever = dayTemps.some((x) => x.c >= TH);
    const hasVisit = dayVisits.length > 0;
    if (hasTemp) measuredCount++;
    if (hasFever) feverCount++;
    if (hasVisit) visitedCount++;
    rows.push({
      id: p.id,
      bed: p.bed || '—',
      name: p.name,
      age: p.age,
      gender: p.gender || '—',
      temp: latestOnDay ? latestOnDay.c : null,
      measuredBy: latestOnDay ? latestOnDay.by : 'Pending',
      visited: hasVisit,
      visitedBy: dayVisits[0]?.by || 'Pending',
      feverFreeDays: p.st === 'active' ? stk(p) : '—',
      status:
        p.st === 'dead'
          ? `Deceased (${p.out})`
          : p.st === 'disch'
            ? `Discharged (${p.out})`
            : rdy(p)
              ? p.conf
                ? 'Discharge approved'
                : 'Eligible (awaiting doctor)'
              : hasFever
                ? 'Fever'
                : 'Active',
    });
  }

  rows.sort((a, b) => (Number(a.bed) || 999) - (Number(b.bed) || 999));

  return {
    date: targetDate,
    summary: {
      occupied: activeOnDate.length,
      capacity: CAP,
      occupancyRate: activeOnDate.length / CAP,
      admissions,
      discharges,
      deaths,
      measuredCount,
      tempCompliance: activeOnDate.length ? measuredCount / activeOnDate.length : 1,
      visitedCount,
      visitCompliance: activeOnDate.length ? visitedCount / activeOnDate.length : 1,
      feverCount,
      stats: computeStats(patients, archive),
    },
    rows,
  };
}

function xmlEsc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build a SpreadsheetML (.xls) multi-sheet Excel workbook from a daily report. */
export function buildExcelReport(report) {
  const s = report.summary;
  const b = s.stats;
  const pctStr = (x) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const summaryRows = [
    ['WardCare Daily Performance Report', report.date],
    ['Occupancy', `${s.occupied} / ${s.capacity} (${pctStr(s.occupancyRate)})`],
    ['Admissions on Date', s.admissions],
    ['Discharges on Date', s.discharges],
    ['Deaths on Date', s.deaths],
    ['Temperatures Recorded', `${s.measuredCount} / ${s.occupied} (${pctStr(s.tempCompliance)})`],
    ['Doctor Visits Recorded', `${s.visitedCount} / ${s.occupied} (${pctStr(s.visitCompliance)})`],
    ['Fever Cases (>= 38.0 C)', s.feverCount],
    ['30-Day Mortality (Benchmark <= 15%)', pctStr(b.mr30)],
    ['30-Day Recovery (Benchmark >= 85%)', pctStr(b.sr30)],
    ['Overall Recovery', pctStr(b.sr)],
    ['Average Stay (Discharged)', `${b.los.toFixed(1)} days`],
  ];

  const makeRow = (cells, styleId) =>
    `<Row>${cells
      .map((val) => {
        const isNum = typeof val === 'number' && Number.isFinite(val);
        const type = isNum ? 'Number' : 'String';
        const st = styleId ? ` ss:StyleID="${styleId}"` : '';
        return `<Cell${st}><Data ss:Type="${type}">${xmlEsc(val)}</Data></Cell>`;
      })
      .join('')}</Row>`;

  const patientHeader = ['Bed', 'Patient', 'Age', 'Gender', 'Temp (C)', 'Measured By', 'Doctor Visit', 'Fever-Free Days', 'Status'];
  const patientRows = report.rows.map((r) => [
    r.bed,
    r.name,
    r.age,
    r.gender,
    r.temp == null ? 'Pending' : r.temp,
    r.measuredBy,
    r.visited ? r.visitedBy : 'Pending',
    r.feverFreeDays === '—' ? '—' : `${r.feverFreeDays}/3`,
    r.status,
  ]);

  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#E6F4F1" ss:Pattern="Solid"/></Style>
 </Styles>
 <Worksheet ss:Name="Daily Summary">
  <Table>
   ${makeRow(['Metric', 'Value'], 'hdr')}
   ${summaryRows.map((r) => makeRow(r)).join('\n   ')}
  </Table>
 </Worksheet>
 <Worksheet ss:Name="Patient Log">
  <Table>
   ${makeRow(patientHeader, 'hdr')}
   ${patientRows.map((r) => makeRow(r)).join('\n   ')}
  </Table>
 </Worksheet>
</Workbook>`;
}

function pdfAscii(text) {
  return String(text ?? '')
    .replace(/[–—]/g, '-')
    .replace(/≥/g, '>=')
    .replace(/≤/g, '<=')
    .replace(/→/g, '->')
    .replace(/°/g, ' deg ')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** Build a valid multi-page PDF 1.4 binary Buffer for a daily performance report. */
export function buildPdfReport(report) {
  const s = report.summary;
  const b = s.stats;
  const pctStr = (x) => (x == null ? '--' : `${(x * 100).toFixed(1)}%`);

  const lines = [
    { bold: true, size: 14, text: `WardCare Daily Performance Report - ${report.date}` },
    { bold: false, size: 10, text: `Occupancy: ${s.occupied}/${s.capacity} (${pctStr(s.occupancyRate)})   Admissions: ${s.admissions}   Discharges: ${s.discharges}   Deaths: ${s.deaths}` },
    { bold: false, size: 10, text: `Temp Compliance: ${s.measuredCount}/${s.occupied} (${pctStr(s.tempCompliance)})   Doctor Visits: ${s.visitedCount}/${s.occupied} (${pctStr(s.visitCompliance)})   Fevers: ${s.feverCount}` },
    { bold: false, size: 10, text: `30d Mortality: ${pctStr(b.mr30)} (target <=15%)   30d Recovery: ${pctStr(b.sr30)} (target >=85%)   Avg Stay: ${b.los.toFixed(1)}d` },
    { bold: true, size: 10, text: '------------------------------------------------------------------------------------------------' },
    { bold: true, size: 9, text: 'Bed | Patient                | Age | Temp   | Visit        | FF  | Status' },
    { bold: false, size: 9, text: '------------------------------------------------------------------------------------------------' },
  ];

  const pad = (str, len) => String(str ?? '').slice(0, len).padEnd(len, ' ');
  for (const r of report.rows) {
    const tempStr = r.temp == null ? 'Pend  ' : `${r.temp.toFixed(1)}C `;
    const visStr = r.visited ? r.visitedBy : 'Pending';
    const ffStr = r.feverFreeDays === '—' ? '-- ' : `${r.feverFreeDays}/3`;
    lines.push({
      bold: false,
      size: 9,
      text: `${pad(r.bed, 3)} | ${pad(r.name, 22)} | ${pad(r.age, 3)} | ${pad(tempStr, 6)} | ${pad(visStr, 12)} | ${pad(ffStr, 3)} | ${r.status}`,
    });
  }
  if (!report.rows.length) {
    lines.push({ bold: false, size: 10, text: 'No active or closed patient records for this date.' });
  }

  const linesPerPage = 44;
  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }

  const objects = [];
  const addObj = (content) => {
    objects.push(content);
    return objects.length;
  };

  const catalogId = addObj('');
  const pagesId = addObj('');
  const fontRegularId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = addObj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

  const pageIds = [];
  for (const pageLines of pages) {
    let stream = 'BT\n';
    let y = 755;
    for (const ln of pageLines) {
      const f = ln.bold ? '/F2' : '/F1';
      stream += `${f} ${ln.size} Tf 40 ${y} Td (${pdfAscii(ln.text)}) Tj\n`;
      stream += `-40 ${-y} Td\n`;
      y -= ln.size + 5;
    }
    stream += 'ET';
    const contentId = addObj(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObj(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`
    );
    pageIds.push(pageId);
  }

  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  const chunks = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets = [0];
  let byteLen = chunks[0].length;
  for (let i = 0; i < objects.length; i++) {
    offsets.push(byteLen);
    const objBuf = Buffer.from(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`, 'latin1');
    chunks.push(objBuf);
    byteLen += objBuf.length;
  }

  const xrefStart = byteLen;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
