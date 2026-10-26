'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const express = require('express'), session = require('express-session');
const rateLimit = require('express-rate-limit'), bcrypt = require('bcryptjs'), Database = require('better-sqlite3');

const PHONE = /^01[0125]\d{8}$/, PIN = /^\d{6}$/;
const GRADES = [
  'Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1',
  'Phonics', 'Kids Level 1', 'Kids Level 2', 'Kids Level 3'
];
const GRADE_AR = {
  'Pre-A1': 'Pre-A1 (للمبتدئين تمامًا)',
  'A1': 'A1 (مبتدئ)',
  'A2': 'A2 (ما دون المتوسط)',
  'B1': 'B1 (متوسط)',
  'B2': 'B2 (فوق المتوسط)',
  'C1': 'C1 (متقدم)',
  'Phonics': 'Phonics Course (تعليم الأصوات)',
  'Kids Level 1': 'Kids Level 1 (أطفال)',
  'Kids Level 2': 'Kids Level 2 (أطفال)',
  'Kids Level 3': 'Kids Level 3 (أطفال)',
  'First Secondary': 'A1 (مبتدئ)',
  'Second Secondary – Baccalaureate': 'A2 (ما دون المتوسط)',
  'Third Secondary': 'B1 (متوسط)'
};
const PROD = process.env.NODE_ENV === 'production';

// ---- Database (SQLite). Swap for your existing DB layer if you already have one. ----
const db = new Database(process.env.DB_FILE || path.join(__dirname, 'students.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS students(
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE, parent_phone TEXT NOT NULL,
  grade TEXT NOT NULL, account_type TEXT NOT NULL CHECK(account_type IN ('external','center')),
  password_hash TEXT NOT NULL, center_code TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
// Legacy columns/tables (students.center_code, students.account_type 'center', center_codes) are left untouched so existing records survive; the app no longer reads or writes center codes.
// Access revocation: set students.active = 0 (or delete the row / the Firestore record) and the student's sessions stop working on their next request.
if (!db.prepare("SELECT 1 FROM pragma_table_info('students') WHERE name = 'active'").get()) db.exec('ALTER TABLE students ADD COLUMN active INTEGER NOT NULL DEFAULT 1');

// In production SESSION_SECRET is mandatory. In development a random secret is generated once and kept in the database, so cookies stay valid across restarts.
db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT NOT NULL)');
const devSecret = () => { const r = db.prepare("SELECT v FROM kv WHERE k = 'session_secret'").get(); if (r) return r.v; const v = crypto.randomBytes(32).toString('hex'); db.prepare("INSERT INTO kv(k, v) VALUES('session_secret', ?)").run(v); return v; };
const secret = process.env.SESSION_SECRET || (PROD ? (() => { throw new Error('SESSION_SECRET is required in production'); })() : devSecret());
const DUMMY = bcrypt.hashSync('000000', 12); // equalises timing when the phone number is unknown

// ---- Persistent sessions: the browser only holds a signed, HttpOnly session-id cookie; all session data lives in SQLite, so it survives restarts. ----
const SESSION_MS = (Number(process.env.SESSION_DAYS) || 90) * 864e5;          // idle lifetime, renewed on every visit
const SESSION_MAX_MS = (Number(process.env.SESSION_MAX_DAYS) || 365) * 864e5; // absolute cap since sign-in
class SqliteStore extends session.Store {
  constructor(d) {
    super();
    d.exec('CREATE TABLE IF NOT EXISTS sessions(sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires INTEGER NOT NULL)');
    this.q = { get: d.prepare('SELECT sess FROM sessions WHERE sid = ? AND expires > ?'), set: d.prepare('INSERT OR REPLACE INTO sessions(sid, sess, expires) VALUES(?, ?, ?)'),
      del: d.prepare('DELETE FROM sessions WHERE sid = ?'), touch: d.prepare('UPDATE sessions SET expires = ? WHERE sid = ?') };
    const purge = d.prepare('DELETE FROM sessions WHERE expires <= ?'); purge.run(Date.now());
    setInterval(() => purge.run(Date.now()), 36e5).unref();
  }
  static exp(s) { const t = s && s.cookie && s.cookie.expires ? new Date(s.cookie.expires).getTime() : NaN; return Number.isFinite(t) ? t : Date.now() + SESSION_MS; }
  get(sid, cb) { try { const r = this.q.get.get(sid, Date.now()); cb(null, r ? JSON.parse(r.sess) : null); } catch (e) { cb(e); } }
  set(sid, s, cb) { try { this.q.set.run(sid, JSON.stringify(s), SqliteStore.exp(s)); cb && cb(null); } catch (e) { cb && cb(e); } }
  destroy(sid, cb) { try { this.q.del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); } }
  touch(sid, s, cb) { try { this.q.touch.run(SqliteStore.exp(s), sid); cb && cb(null); } catch (e) { cb && cb(e); } }
}

const app = express();
app.disable('x-powered-by');
if (PROD) app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(session({ name: 'sid', secret, store: new SqliteStore(db), resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: SESSION_MS } }));
app.use((req, res, next) => { const s = req.session; s && s.iat && Date.now() - s.iat > SESSION_MAX_MS ? s.regenerate(next) : next(); });
app.use((req, res, next) => { if (req.path.startsWith('/api') || req.path.startsWith('/dashboard')) res.set('Cache-Control', 'no-store'); next(); });

const limiter = (max, extra = {}) => rateLimit({ windowMs: 15 * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة. حاول مرة أخرى بعد بضع دقائق.' }, ...extra });
const open = (req, data) => new Promise((ok, no) => req.session.regenerate(err => err ? no(err) : (Object.assign(req.session, data, { iat: Date.now() }), ok())));
const signIn = (req, id) => open(req, { userId: id });
// Students always continue to the learning home after authenticating. The
// legacy dashboard URLs remain available for existing bookmarks.
const home = () => '/';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function check(b) {
  const e = {}, s = k => typeof b[k] === 'string' ? b[k] : '';
  const name = s('fullName').trim().replace(/\s+/g, ' ');
  if (name.length < 3 || name.length > 100 || name.split(' ').length < 2 || !/^[\p{L}][\p{L}\s'.-]*$/u.test(name)) e.fullName = 'أدخل اسمك الأول والأخير على الأقل.';
  if (!PHONE.test(s('phone'))) e.phone = 'أدخل رقم موبايل مصريًا صحيحًا من 11 رقمًا.';
  if (!PHONE.test(s('parentPhone'))) e.parentPhone = 'أدخل رقم موبايل مصريًا صحيحًا من 11 رقمًا.';
  if (!PIN.test(s('password'))) e.password = 'يجب أن تتكوّن كلمة المرور من 6 أرقام بالضبط.';
  else if (s('password') !== s('confirmPassword')) e.confirmPassword = 'كلمتا المرور غير متطابقتين.';
  if (!GRADES.includes(s('grade'))) e.grade = 'اختر الصف الدراسي.';
  return { e, name };
}

// ---- Firebase Firestore REST Configuration ----
const FBC = (() => { try { const t = fs.readFileSync(path.join(__dirname, 'firebase-config.js'), 'utf8'), g = k => (t.match(new RegExp(k + '\\s*:\\s*"([^"]+)"')) || [])[1]; return { id: g('projectId'), key: g('apiKey') }; } catch { return {}; } })();
const FS_BASE = process.env.FIRESTORE_BASE || 'https://firestore.googleapis.com/v1/projects/' + (process.env.FIREBASE_PROJECT_ID || FBC.id) + '/databases/(default)/documents';
const FS_KEY = process.env.FIREBASE_API_KEY || FBC.key;
const CFIELDS = ['centerCode', 'qrCode', 'offlineCode', 'code'], CHECK_MS = Number(process.env.CENTER_RECHECK_MS) || 10 * 60 * 1000;
const ncode = v => String(v == null ? '' : v).trim().replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).toUpperCase();
const fsv = v => { const k = v && Object.keys(v)[0], x = k && v[k]; return k === 'integerValue' || k === 'doubleValue' ? Number(x) : k === 'arrayValue' ? (x.values || []).map(fsv) : k === 'mapValue' ? fsobj(x.fields) : k === 'stringValue' || k === 'booleanValue' || k === 'timestampValue' ? x : null; };
const fsobj = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, fsv(v)]));
const fsx = (p, init, ms) => fetch(FS_BASE + p + (FS_KEY ? (p.includes('?') ? '&' : '?') + 'key=' + FS_KEY : ''), { ...init, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(ms || 8000) });

// Registration is open to everyone: no center code. New accounts are regular phone+password students (account_type 'external').
app.post('/api/register', limiter(20), async (req, res) => {
  const b = req.body || {};
  const { e, name } = check(b);
  if (Object.keys(e).length) return res.status(400).json({ error: 'يرجى تصحيح الحقول المحددة.', fields: e });
  const hash = await bcrypt.hash(b.password, 12);
  try {
    const info = db.prepare('INSERT INTO students(full_name,phone,parent_phone,grade,account_type,password_hash) VALUES(?,?,?,?,?,?)')
      .run(name, b.phone, b.parentPhone, b.grade, 'external', hash);
    const studentId = Number(info.lastInsertRowid);
    await signIn(req, studentId);

    // Sync to Firebase Firestore
    try {
      const studentDoc = {
        fields: {
          id: { stringValue: String(studentId) },
          name: { stringValue: name },
          fullName: { stringValue: name },
          phone: { stringValue: b.phone },
          parentPhone: { stringValue: b.parentPhone },
          grade: { stringValue: b.grade },
          password: { stringValue: b.password },
          role: { stringValue: 'student' },
          studentType: { stringValue: 'platform' },
          status: { stringValue: 'active' },
          createdAt: { stringValue: new Date().toISOString() },
          joinDate: { stringValue: new Date().toLocaleDateString('ar-EG') }
        }
      };
      await fsx('/students/' + studentId, { method: 'PATCH', body: JSON.stringify(studentDoc) }, 4000).catch(() => {});
    } catch (fsErr) {}

    res.status(201).json({ ok: true, redirect: home(), student: { id: studentId, full_name: name } });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'يوجد حساب مسجّل بهذا الرقم بالفعل.', fields: { phone: 'رقم الهاتف هذا مسجّل بالفعل.' } });
    throw err;
  }
});

app.post('/api/login', limiter(10, { skipSuccessfulRequests: true }), async (req, res) => {
  const { phone, password } = req.body || {};
  if (typeof phone !== 'string' || typeof password !== 'string' || !PHONE.test(phone) || !PIN.test(password))
    return res.status(400).json({ error: 'أدخل رقم هاتفك (11 رقمًا) وكلمة المرور (6 أرقام).' });
  let u = db.prepare('SELECT id, full_name, account_type, password_hash, active FROM students WHERE phone = ?').get(phone);
  let ok = false;
  if (u) {
    ok = await bcrypt.compare(password, u.password_hash);
  } else {
    // Fallback: Check Firestore for students registered directly via client
    try {
      const q = await fsx(':runQuery', {
        method: 'POST',
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: 'students' }],
            where: { fieldFilter: { field: { fieldPath: 'phone' }, op: 'EQUAL', value: { stringValue: phone } } },
            limit: 1
          }
        })
      });
      if (q.ok) {
        const rows = await q.json();
        for (const row of rows) {
          if (row.document) {
            const data = fsobj(row.document.fields);
            if (data && String(data.password) === String(password)) {
              const hash = await bcrypt.hash(password, 10);
              const info = db.prepare('INSERT OR REPLACE INTO students(full_name,phone,parent_phone,grade,account_type,password_hash) VALUES(?,?,?,?,?,?)')
                .run(data.name || data.fullName, phone, data.parentPhone || '', data.grade || '1', 'external', hash);
              u = { id: Number(info.lastInsertRowid), full_name: data.name || data.fullName, active: 1 };
              ok = true;
              break;
            }
          }
        }
      }
    } catch (e) {}
  }
  if (!u || !ok) return res.status(401).json({ error: 'رقم الهاتف أو كلمة المرور غير صحيحة.' });
  if (!u.active) return res.status(403).json({ error: 'تم إيقاف هذا الحساب. تواصل مع إدارة المنصة.' });
  await signIn(req, u.id);
  res.json({ ok: true, redirect: home(), student: { id: u.id, full_name: u.full_name } });
});

const need = (req, res, next) => req.session.userId || req.session.center ? next()
  : req.originalUrl.startsWith('/api') ? res.status(401).json({ error: 'يجب تسجيل الدخول أولًا.' }) : res.redirect('/login');
const me = req => db.prepare('SELECT id, full_name, phone, parent_phone, grade, account_type FROM students WHERE id = ? AND active = 1').get(req.session.userId);
const gone = (req, res) => req.session.destroy(() => { res.clearCookie('sid'); res.status(401).json({ error: 'انتهت الجلسة أو تم إيقاف الوصول. سجّل الدخول من جديد.' }); });
async function fsMatches(col, code) {
  const found = new Map(), g = await fsx('/' + col + '/' + encodeURIComponent(code));
  if (g.ok) { const d = await g.json(); found.set(d.name.split('/').pop(), fsobj(d.fields)); } else if (g.status !== 404) throw new Error('firestore ' + g.status);
  const vals = [{ stringValue: code }]; if (/^\d+$/.test(code)) vals.push({ integerValue: code });
  const filters = CFIELDS.flatMap(f => vals.map(value => ({ fieldFilter: { field: { fieldPath: f }, op: 'EQUAL', value } })));
  const q = await fsx(':runQuery', { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where: { compositeFilter: { op: 'OR', filters } }, limit: 10 } }) });
  if (!q.ok) throw new Error('firestore ' + q.status);
  for (const row of await q.json()) if (row.document) {
    const id = row.document.name.split('/').pop(), data = fsobj(row.document.fields);
    if (ncode(id) === code || CFIELDS.some(k => ncode(data[k]) === code)) found.set(id, data);
  }
  return [...found].map(([id, data]) => ({ id, data }));
}
async function findCenterStudent(code) {
  for (const col of ['centerStudents', 'students']) { const m = await fsMatches(col, code); if (m.length > 1) return { dup: true }; if (m.length) return { col, id: m[0].id, data: m[0].data }; }
  return null;
}
const str = v => v == null ? '' : String(v);
const revoked = d => !!(d.blocked || d.isBlocked || d.disabled || d.suspended || d.active === false || d.isActive === false || ['blocked', 'disabled', 'suspended', 'inactive'].includes(str(d.status).toLowerCase()));
const profile = (col, id, d) => ({ id, full_name: str(d.name || d.fullName || d.full_name || d.firstName).trim() || 'طالب', phone: str(d.phone || d.mobile || d.phoneNumber || d.studentPhone),
  parent_phone: str(d.parentPhone || d.parent_phone || d.guardianPhone), grade: d.grade || d.offlineGrade || '', account_type: 'center', code: str(d.qrCode || d.centerCode || d.offlineCode || d.code), collection: col, local: 1 });
const publicDoc = (col, id, d) => { const o = { ...d, id, role: 'student', type: 'center', studentType: 'center', studentCollection: col }; for (const k of [...CFIELDS, 'password', 'pin', 'passcode']) delete o[k]; return o; };

app.post('/api/center-session', limiter(20, { skipSuccessfulRequests: true }), async (req, res) => {
  const code = ncode((req.body || {}).code);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(code)) return res.status(400).json({ error: 'أدخل كود طالب صحيحًا.' });
  let f; try { f = await findCenterStudent(code); } catch (e) { return res.status(503).json({ error: 'تعذّر التحقق من الكود الآن. حاول مرة أخرى.' }); }
  if (!f) return res.status(404).json({ error: 'كود الطالب غير صحيح أو غير مسجّل. تأكد من الكود وحاول مرة أخرى.' });
  if (f.dup) return res.status(409).json({ error: 'هذا الكود مرتبط بأكثر من سجل. تواصل مع إدارة السنتر لتصحيح البيانات.' });
  if (revoked(f.data)) return res.status(403).json({ error: 'تم إيقاف هذا الحساب. تواصل مع إدارة السنتر.' });
  await open(req, { center: { col: f.col, id: f.id, at: Date.now(), p: profile(f.col, f.id, f.data) } });
  res.json({ ok: true, student: publicDoc(f.col, f.id, f.data) });
});

app.get('/api/me', need, async (req, res) => {
  const c = req.session.center;
  if (!c) { const u = me(req); return u ? res.json(u) : gone(req, res); }
  if (Date.now() - c.at > CHECK_MS) { // periodic re-check: deleted/blocked record => revoke; if Firestore is unreachable keep the session and retry in a minute
    try {
      const g = await fsx('/' + c.col + '/' + encodeURIComponent(c.id), {}, 3000);
      if (g.status === 404) return gone(req, res);
      if (!g.ok) throw new Error('firestore ' + g.status);
      const d = fsobj((await g.json()).fields);
      if (revoked(d)) return gone(req, res);
      c.p = profile(c.col, c.id, d); c.at = Date.now();
    } catch (e) { c.at = Date.now() - CHECK_MS + Math.min(60000, CHECK_MS); }
    req.session.center = c;
  }
  res.json(c.p);
});
app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('sid'); res.json({ ok: true }); }));

for (const t of ['center', 'external']) app.get('/dashboard/' + t, need, (req, res) => {
  const u = me(req);
  if (!u) return res.redirect('/login');
  if (u.account_type !== t) return res.redirect(home(u.account_type));
  res.send(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>لوحة الطالب</title>
<body style="font-family:'Readex Pro','IBM Plex Sans Arabic',system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 20px;color:#1B1D46"><h1>مرحبًا، ${esc(u.full_name)}</h1>
<p>نوع الحساب: <b>${t === 'center' ? 'طالب من السنتر' : 'طالب من خارج السنتر'}</b> · ${esc(GRADE_AR[u.grade] || u.grade)}</p>
<p>هذه لوحة مؤقتة — استبدلها بلوحة الطالب الحقيقية.</p><p><a href="/profile.html" style="color:#7A54D6;font-weight:700">ملفي الشخصي ←</a> &nbsp; <a href="/test.html" style="color:#7A54D6;font-weight:700">الاختبارات ودرجاتي ←</a> &nbsp; <a href="/lectures.html" style="color:#7A54D6;font-weight:700">المحاضرات ←</a></p><button id="o">تسجيل الخروج</button>
<script>o.onclick=async()=>{await fetch('/api/logout',{method:'POST'});location.href='/login'}</script>`);
});

const AUTH = path.join(__dirname, 'auth.html'), HOME = path.join(__dirname, 'index.html');
// One flat project folder: files are served from an explicit whitelist (never express.static(__dirname), which would expose server.js and the database).
app.get(['/', '/index.html'], (req, res) => res.sendFile(HOME));
// /login and /register both serve the same page; auth.html shows the matching form (the /register path opens Create Account directly).
app.get(['/login', '/register'], (req, res) => { const u = req.session.userId && me(req); u || req.session.center ? res.redirect(home()) : res.sendFile(AUTH); });
app.get('/auth.html', (req, res) => res.sendFile(AUTH));
// ---- لوحة التحكم (الداشبورد القديمة تُنسخ كما هي): قائمة بيضاء بملفاتها فقط. الدخول من صفحة /login بمعرّف الأدمن عبر Firebase Auth ----
// صفحات الكورسات للطالب (courses.html / course.html) وملفاتها المساعدة تُخدَّم من نفس القائمة البيضاء.
const STUDENT_COURSE_FILES = ['courses.html', 'course.html', 'student-courses.js', 'student-courses.css', 'course-lessons.js', 'firebase-config.js', 'grade-mapping.js', 'student-session.js', 'platform-data.js', 'test.html', 'profile.html'];
// صفحة المحاضرات العامة (مفتوحة للزوار بدون تسجيل دخول): ملفاتها بجانب باقي صفحات المنصة وتُخدَّم من نفس القائمة البيضاء.
const SHARED_FILES = ['monalingo-mark.webp', 'theme.js', 'mobile-header.css', 'mobile-header.js', 'dev-signature.css', 'splash.css', 'splash.js']; // theme.js = الوضع النهاري/الليلي المشترك
const LECTURE_FILES = ['lectures.html', 'lectures.css', 'lectures.js'];
// صفحة الاختبارات المستقلة (قائمة الاختبارات المنشورة من الداشبورد + النتائج). حلّ الاختبار نفسه يتم في test.html.
const EXAM_FILES = ['exam.html', 'exams.html', 'exams.css', 'exams.js']; // exams.html = تحويل للروابط القديمة إلى exam.html
const DASH_FILES = new Set(['dashboard.html', 'alamin-premium.css', 'firestore-read-cache.js', 'lesson-progress.js', 'quiz-index-sync.js', 'assignments-dashboard.js', 'ايقونة الواجهه.jpeg', '1782242191457_image.png', ...STUDENT_COURSE_FILES, ...LECTURE_FILES, ...EXAM_FILES, ...SHARED_FILES]);
app.get(['/lectures', '/lecture', '/lecture/', '/lectures/'], (req, res) => res.redirect(301, '/lectures.html')); // مسارات قديمة/مختصرة للصفحة
app.get('/login.html', (req, res) => res.redirect('/login')); // الداشبورد تحوّل غير المسجَّلين إلى login.html
app.get('/:file', (req, res, next) => { const f = req.params.file, p = path.join(__dirname, f); DASH_FILES.has(f) && fs.existsSync(p) ? res.sendFile(p) : next(); });
app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: 'حدث خطأ ما. حاول مرة أخرى.' }); });
app.listen(process.env.PORT || 3000, () => console.log('Listening on http://localhost:' + (process.env.PORT || 3000)));
