import { bk, td } from './ward-logic.mjs';

const ACTIVE_PATIENTS = [
  // Group A: Beds 1-8 — Pending nurse temperature today (0-2 fever-free days)
  { bed: 1, name: 'Rohan Sharma', age: 29, g: 'M', phone: '98201-11402', notes: 'Mild dry cough, hydrating well', stay: 4, temps: [38.6, 38.2, 37.6], group: 'A' },
  { bed: 2, name: 'Meera Iyer', age: 54, g: 'F', phone: '98201-22914', notes: 'Hypertensive, monitored Q6H', stay: 5, temps: [38.9, 38.7, 38.4, 38.1], group: 'A' },
  { bed: 3, name: 'Arjun Kulkarni', age: 41, g: 'M', phone: '98201-34098', notes: 'Day 3 isolation, appetite improving', stay: 3, temps: [38.3, 37.7], group: 'A' },
  { bed: 4, name: 'Fatima Shaikh', age: 67, g: 'F', phone: '98201-45210', notes: 'Diabetic, low-grade persistent fever', stay: 6, temps: [39.1, 38.8, 38.5, 38.2, 37.9], group: 'A' },
  { bed: 5, name: 'Vikram Singh', age: 36, g: 'M', phone: '98201-56331', notes: 'Admitted yesterday with high fever', stay: 2, temps: [38.8], group: 'A' },
  { bed: 6, name: 'Neha Deshmukh', age: 24, g: 'F', phone: '98201-67844', notes: 'Body ache, vitals stable', stay: 4, temps: [38.4, 37.8, 37.4], group: 'A' },
  { bed: 7, name: 'Suresh Nair', age: 61, g: 'M', phone: '98201-78902', notes: 'Supplemental O2 PRN, Spo2 97%', stay: 5, temps: [39.0, 38.6, 38.3, 38.2], group: 'A' },
  { bed: 8, name: 'Pooja Joshi', age: 47, g: 'F', phone: '98201-89123', notes: 'Recovering smoothly after antipyretics', stay: 3, temps: [38.2, 37.5], group: 'A' },

  // Group B: Beds 9-16 — Nurse measured today, awaiting Doctor visit
  { bed: 9, name: 'Kabir Malhotra', age: 33, g: 'M', phone: '98112-10455', notes: 'Fever spiked overnight, labs ordered', stay: 4, temps: [38.5, 38.4, 38.6, 38.5], group: 'B' },
  { bed: 10, name: 'Ananya Sen', age: 27, g: 'F', phone: '98112-20911', notes: 'Afebrile past 2 days, mild fatigue', stay: 5, temps: [38.7, 38.3, 37.8, 37.3, 37.0], group: 'B' },
  { bed: 11, name: 'Rajesh Verma', age: 58, g: 'M', phone: '98112-31208', notes: 'Evening fever spikes decreasing', stay: 6, temps: [39.2, 38.9, 38.5, 38.1, 37.7, 37.6], group: 'B' },
  { bed: 12, name: 'Deepika Rao', age: 44, g: 'F', phone: '98112-44019', notes: 'Admitted 2 days ago, responding well', stay: 3, temps: [38.9, 38.2, 37.8], group: 'B' },
  { bed: 13, name: 'Imran Khan', age: 71, g: 'M', phone: '98112-55820', notes: 'Elderly watch, chest X-ray clear', stay: 7, temps: [39.0, 38.8, 38.5, 38.4, 38.1, 38.3, 38.2], group: 'B' },
  { bed: 14, name: 'Shruti Patil', age: 38, g: 'F', phone: '98112-66294', notes: 'No headache today, oral intake normal', stay: 4, temps: [38.6, 38.1, 37.6, 37.2], group: 'B' },
  // 3 fever-free days ending today, awaiting doctor confirmation:
  { bed: 15, name: 'Amitabh Roy', age: 49, g: 'M', phone: '98112-77410', notes: 'Completed 3 full days afebrile — review for discharge', stay: 6, temps: [38.8, 38.3, 38.1, 37.4, 37.0, 36.8], group: 'B_ELIG' },
  { bed: 16, name: 'Kavya Menon', age: 31, g: 'F', phone: '98112-88329', notes: 'Asymptomatic, 3 fever-free days logged', stay: 5, temps: [38.5, 38.0, 37.3, 36.9, 36.7], group: 'B_ELIG' },

  // Group C: Beds 17-28 — Measured & visited by doctor today
  { bed: 17, name: 'Siddharth Bose', age: 26, g: 'M', phone: '98330-11290', notes: 'Continue paracetamol PRN and hydration', stay: 5, temps: [38.6, 38.4, 38.1, 37.6, 37.2], group: 'C' },
  { bed: 18, name: 'Lakshmi Krishnan', age: 63, g: 'F', phone: '98330-22140', notes: 'Persistent fever, blood culture pending', stay: 7, temps: [39.3, 39.1, 38.9, 38.8, 38.6, 38.5, 38.4], group: 'C' },
  { bed: 19, name: 'Nitin Gadkari', age: 52, g: 'M', phone: '98330-33512', notes: 'Downward trend, repeat CBC tomorrow', stay: 6, temps: [39.0, 38.7, 38.4, 38.1, 37.7, 37.4], group: 'C' },
  { bed: 20, name: 'Ritu Chaudhary', age: 35, g: 'F', phone: '98330-44671', notes: 'Mild throat irritation, no respiratory distress', stay: 4, temps: [38.4, 38.0, 37.5, 37.1], group: 'C' },
  { bed: 21, name: 'Prakash Hegde', age: 74, g: 'M', phone: '98330-55789', notes: 'Close geriatric monitoring, Spo2 95%', stay: 8, temps: [39.2, 39.0, 38.9, 38.7, 38.5, 38.6, 38.3, 38.2], group: 'C' },
  { bed: 22, name: 'Zoya Akhtar', age: 28, g: 'O', phone: '98330-66892', notes: 'Newly admitted, antipyretics started', stay: 2, temps: [38.7, 38.1], group: 'C' },
  { bed: 23, name: 'Manish Tiwari', age: 46, g: 'M', phone: '98330-77903', notes: 'Second afebrile day tomorrow triggers review', stay: 5, temps: [38.8, 38.5, 38.2, 37.6, 37.3], group: 'C' },
  { bed: 24, name: 'Geeta Bhosale', age: 59, g: 'F', phone: '98330-88014', notes: 'Temperature settling gradually', stay: 6, temps: [38.9, 38.6, 38.3, 38.0, 37.8, 37.5], group: 'C' },
  { bed: 25, name: 'Harish Chawla', age: 40, g: 'M', phone: '98330-99125', notes: 'Breakthrough fever after dip, extended monitoring', stay: 6, temps: [38.7, 38.2, 37.7, 37.8, 38.3, 38.1], group: 'C' },
  { bed: 26, name: 'Swati Mishra', age: 32, g: 'F', phone: '98331-10236', notes: 'Admitted 3 days ago, steady improvement', stay: 3, temps: [38.5, 37.9, 37.4], group: 'C' },
  { bed: 27, name: 'Kiran Deshpande', age: 66, g: 'O', phone: '98331-21347', notes: 'Mild fever, tolerating oral diet', stay: 5, temps: [38.9, 38.6, 38.4, 38.1, 38.0], group: 'C' },
  { bed: 28, name: 'Varun Kapoor', age: 23, g: 'M', phone: '98331-32458', notes: 'Rapid defervescence, energetic', stay: 4, temps: [38.6, 38.1, 37.4, 36.9], group: 'C' },

  // Group D: Beds 29-32 — 3+ days fever-free & Doctor-approved for Admin discharge
  { bed: 29, name: 'Shalini Gupta', age: 37, g: 'F', phone: '98450-14102', notes: 'Cleared by Dr. Mehta for home quarantine follow-up', stay: 6, temps: [38.7, 38.2, 37.6, 37.2, 36.9, 36.8], group: 'D', byDoc: 'Dr. Mehta' },
  { bed: 30, name: 'Rameshwar Das', age: 55, g: 'M', phone: '98450-25213', notes: 'Cleared by Dr. Rao; family notified for pickup', stay: 7, temps: [38.9, 38.5, 38.1, 37.4, 37.1, 36.9, 36.7], group: 'D', byDoc: 'Dr. Rao' },
  { bed: 31, name: 'Nandini Pillai', age: 29, g: 'F', phone: '98450-36324', notes: 'Cleared by Dr. Mehta; discharge summary ready', stay: 5, temps: [38.4, 38.0, 37.3, 36.8, 36.7], group: 'D', byDoc: 'Dr. Mehta' },
  { bed: 32, name: 'Devendra Chauhan', age: 62, g: 'M', phone: '98450-47435', notes: 'Cleared by Dr. Rao; vitals normal across 3 days', stay: 7, temps: [39.0, 38.6, 38.0, 37.5, 37.1, 36.9, 36.8], group: 'D', byDoc: 'Dr. Rao' },
];

// 22 Past Outcomes over the last 24 days (19 cured + 3 deceased => 86.4% recovery, 13.6% mortality)
const PAST_PATIENTS = [
  // <30 (5 disch, 0 dead)
  { name: 'Aarav Mehta', age: 22, g: 'M', admAgo: 18, outAgo: 12, st: 'disch', temps: [38.6, 38.3, 37.7, 37.2, 36.9, 36.8] },
  { name: 'Tanvi Kulkarni', age: 25, g: 'F', admAgo: 16, outAgo: 10, st: 'disch', temps: [38.8, 38.4, 38.0, 37.4, 37.0, 36.7] },
  { name: 'Kunal Bansal', age: 28, g: 'M', admAgo: 14, outAgo: 8, st: 'disch', temps: [38.5, 38.1, 37.6, 37.1, 36.8, 36.7] },
  { name: 'Sneha Reddy', age: 24, g: 'F', admAgo: 11, outAgo: 5, st: 'disch', temps: [38.4, 37.9, 37.4, 37.0, 36.8] },
  { name: 'Ishaan Verma', age: 27, g: 'M', admAgo: 8, outAgo: 2, st: 'disch', temps: [38.7, 38.2, 37.7, 37.1, 36.9, 36.8] },

  // 30-49 (6 disch, 0 dead)
  { name: 'Priyanka Chopra', age: 34, g: 'F', admAgo: 20, outAgo: 14, st: 'disch', temps: [38.9, 38.5, 38.1, 37.4, 37.0, 36.8] },
  { name: 'Sameer Joshi', age: 42, g: 'M', admAgo: 17, outAgo: 11, st: 'disch', temps: [39.0, 38.6, 38.2, 37.6, 37.1, 36.9] },
  { name: 'Bhavna Shah', age: 39, g: 'F', admAgo: 15, outAgo: 9, st: 'disch', temps: [38.7, 38.3, 37.8, 37.3, 36.9, 36.7] },
  { name: 'Gaurav Saxena', age: 47, g: 'M', admAgo: 12, outAgo: 6, st: 'disch', temps: [38.8, 38.4, 37.9, 37.3, 36.8, 36.8] },
  { name: 'pallavi Gokhale', age: 31, g: 'F', admAgo: 10, outAgo: 4, st: 'disch', temps: [38.5, 38.1, 37.5, 37.0, 36.9, 36.7] },
  { name: 'Tarun Bhatia', age: 45, g: 'M', admAgo: 7, outAgo: 1, st: 'disch', temps: [38.6, 38.1, 37.4, 37.0, 36.8] },

  // 50-64 (5 disch, 1 dead)
  { name: 'Harshvardhan Rao', age: 56, g: 'M', admAgo: 22, outAgo: 15, st: 'disch', temps: [39.1, 38.8, 38.4, 37.8, 37.2, 36.9, 36.8] },
  { name: 'Sunanda Deshmukh', age: 52, g: 'F', admAgo: 19, outAgo: 13, st: 'disch', temps: [38.9, 38.5, 38.0, 37.4, 37.0, 36.8] },
  { name: 'Vinod Kambli', age: 61, g: 'M', admAgo: 15, outAgo: 9, st: 'dead', temps: [39.4, 39.6, 39.5, 39.8, 39.7] },
  { name: 'Kalyani Sengupta', age: 58, g: 'F', admAgo: 13, outAgo: 7, st: 'disch', temps: [38.8, 38.4, 38.0, 37.4, 36.9, 36.8] },
  { name: 'Mahesh Hegde', age: 54, g: 'M', admAgo: 9, outAgo: 3, st: 'disch', temps: [38.7, 38.2, 37.6, 37.1, 36.8] },
  { name: 'Usha Krishnan', age: 63, g: 'F', admAgo: 8, outAgo: 2, st: 'disch', temps: [38.9, 38.3, 37.8, 37.2, 36.9, 36.7] },

  // 65+ (3 disch, 2 dead)
  { name: 'Gopalakrishna Iyer', age: 72, g: 'M', admAgo: 21, outAgo: 14, st: 'dead', temps: [39.3, 39.5, 39.4, 39.7, 39.9] },
  { name: 'Savita Kulkarni', age: 68, g: 'F', admAgo: 18, outAgo: 10, st: 'disch', temps: [39.0, 38.7, 38.3, 37.8, 37.3, 36.9, 36.8] },
  { name: 'Brijmohan Lal', age: 76, g: 'M', admAgo: 13, outAgo: 7, st: 'dead', temps: [39.2, 39.4, 39.6, 39.5, 39.8] },
  { name: 'Indira Banerjee', age: 66, g: 'F', admAgo: 11, outAgo: 4, st: 'disch', temps: [38.8, 38.4, 37.9, 37.4, 37.0, 36.8] },
  { name: 'Narayanan Menon', age: 70, g: 'M', admAgo: 9, outAgo: 1, st: 'disch', temps: [38.9, 38.3, 37.8, 37.3, 36.9, 36.7] },
];

/** Build deterministic initial patients, temperatures, visits, notifications, and logs. */
export function buildSeedDataset() {
  const nurses = ['Priya (Nurse)', 'Anil (Nurse)'];
  const doctors = ['Dr. Mehta', 'Dr. Rao'];
  const today = td();
  const now = Date.now();
  const patients = [];
  const notifications = [];

  for (let idx = 0; idx < ACTIVE_PATIENTS.length; idx++) {
    const p = ACTIVE_PATIENTS[idx];
    const isApproved = p.group === 'D';
    const nurseName = nurses[idx % nurses.length];
    const docName = p.byDoc || doctors[idx % doctors.length];
    const t = [];
    const v = [];

    for (let ti = 0; ti < p.temps.length; ti++) {
      const offsetDays = p.group === 'A' ? p.temps.length - ti : p.temps.length - 1 - ti;
      const dStr = bk(offsetDays);
      const hr = String(8 + ((idx + ti) % 3)).padStart(2, '0');
      const mn = String(((idx * 7 + ti * 13) % 50) + 10).padStart(2, '0');
      t.push({ d: dStr, c: p.temps[ti], at: `${hr}:${mn}`, by: nurseName });

      const isToday = dStr === today;
      if (!isToday || p.group === 'C' || p.group === 'D') {
        const vHr = String(10 + ((idx + ti) % 4)).padStart(2, '0');
        const note = isApproved && isToday
          ? '3 fever-free days verified; approved for discharge'
          : p.temps[ti] >= 38.0
            ? 'Fever managed with antipyretics and fluids'
            : 'Vitals stable, continue observation';
        v.push({ d: dStr, at: `${vHr}:${mn}`, by: docName, note });
      }
    }

    patients.push({
      name: p.name,
      age: p.age,
      gender: p.g,
      phone: p.phone,
      notes: p.notes,
      bed: p.bed,
      adm: bk(p.stay - 1),
      st: 'active',
      out: null,
      conf: isApproved,
      confBy: isApproved ? p.byDoc : null,
      t,
      v,
      _group: p.group,
    });
  }

  for (let idx = 0; idx < PAST_PATIENTS.length; idx++) {
    const p = PAST_PATIENTS[idx];
    const cleanName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const docName = doctors[idx % doctors.length];
    const nurseName = nurses[idx % nurses.length];
    const t = [];
    const v = [];
    for (let ti = 0; ti < p.temps.length; ti++) {
      const dStr = bk(p.admAgo - ti);
      t.push({ d: dStr, c: p.temps[ti], at: '08:30', by: nurseName });
      v.push({
        d: dStr,
        at: '11:15',
        by: docName,
        note: p.st === 'dead' && ti === p.temps.length - 1 ? 'Critical deterioration noted' : 'Daily clinical review completed',
      });
    }
    patients.push({
      name: cleanName,
      age: p.age,
      gender: p.g,
      phone: `98900-${String(10000 + idx * 137)}`,
      notes: p.st === 'disch' ? 'Recovered & discharged after 3 fever-free days' : 'Deceased despite ICU escalation',
      bed: 0,
      adm: bk(p.admAgo),
      st: p.st,
      out: bk(p.outAgo),
      conf: p.st === 'disch',
      confBy: p.st === 'disch' ? docName : null,
      t,
      v,
      _group: 'PAST',
    });
  }

  const logs = [
    { ts: Math.round(now - 3600000 * 5), u: 'Sunita (Admin)', a: 'Admitted Zoya Akhtar to bed 22' },
    { ts: Math.round(now - 3600000 * 4), u: 'Priya (Nurse)', a: 'Recorded morning temperatures for Beds 9–16 & 29–32' },
    { ts: Math.round(now - 3600000 * 3), u: 'Anil (Nurse)', a: 'Recorded morning temperatures for Beds 17–28' },
    { ts: Math.round(now - 3600000 * 2.5), u: 'Dr. Mehta', a: 'Completed rounds for Beds 17–22 & approved discharge for Shalini Gupta (Bed 29)' },
    { ts: Math.round(now - 3600000 * 2), u: 'Dr. Rao', a: 'Completed rounds for Beds 23–28 & approved discharge for Rameshwar Das (Bed 30)' },
    { ts: Math.round(now - 3600000 * 1.2), u: 'Dr. Mehta', a: 'Approved discharge for Nandini Pillai (Bed 31)' },
    { ts: Math.round(now - 3600000 * 0.7), u: 'Dr. Rao', a: 'Approved discharge for Devendra Chauhan (Bed 32)' },
    { ts: Math.round(now - 1800000), u: 'Sunita (Admin)', a: 'Discharged Narayanan Menon from previous ward cycle' },
  ];

  return { patients, notifications, logs };
}

/** Populate initial realistic clinical records into an empty WardCare SQLite database once. */
export function seedInitialWard(db) {
  const alreadySeeded = db.prepare("SELECT 1 FROM ward_meta WHERE key = 'seeded'").get();
  if (alreadySeeded) return false;
  const existingPatients = db.prepare('SELECT COUNT(*) AS n FROM patients').get().n;
  if (existingPatients > 0) {
    db.prepare("INSERT OR IGNORE INTO ward_meta (key, val) VALUES ('seeded', '1')").run();
    return false;
  }

  const { patients, logs } = buildSeedDataset();
  const insPatient = db.prepare(
    'INSERT INTO patients (name, age, gender, phone, notes, bed, adm, st, out_date, conf, conf_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insTemp = db.prepare('INSERT INTO temperatures (patient_id, d, c, at, by_user) VALUES (?, ?, ?, ?, ?)');
  const insVisit = db.prepare('INSERT INTO visits (patient_id, d, at, by_user, note) VALUES (?, ?, ?, ?, ?)');
  const insNotif = db.prepare('INSERT INTO notifications (role, patient_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)');
  const insLog = db.prepare('INSERT INTO audit_log (ts, u, a) VALUES (?, ?, ?)');
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let idx = 0; idx < patients.length; idx++) {
      const p = patients[idx];
      const res = insPatient.run(
        p.name, p.age, p.gender, p.phone, p.notes, p.bed, p.adm, p.st, p.out, p.conf ? 1 : 0, p.confBy
      );
      const pid = Number(res.lastInsertRowid);
      for (const tp of p.t) insTemp.run(pid, tp.d, tp.c, tp.at, tp.by);
      for (const vs of p.v) insVisit.run(pid, vs.d, vs.at, vs.by, vs.note);

      if (p._group === 'B_ELIG') {
        insNotif.run('doctor', pid, 'eligible', `${p.name} (Bed ${p.bed}) completed 3 fever-free days and is eligible for discharge.`, now - (idx + 1) * 60000);
      } else if (p._group === 'D') {
        insNotif.run('admin', pid, 'discharge_approved', `${p.name} (Bed ${p.bed}) was approved for discharge by ${p.confBy}.`, now - (idx + 1) * 45000);
      }
    }
    for (const l of logs) insLog.run(l.ts, l.u, l.a);
    db.prepare("INSERT OR REPLACE INTO ward_meta (key, val) VALUES ('seeded', '1')").run();
    db.exec('COMMIT');
    return true;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

