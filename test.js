'use strict';
const { spawn } = require('child_process'), fs = require('fs'), Database = require('better-sqlite3');
const PORT = 3456, B = 'http://127.0.0.1:' + PORT, DB = '/tmp/student-auth-test.db';
for (const x of ['', '-wal', '-shm']) fs.rmSync(DB + x, { force: true });
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT, DB_FILE: DB, }, stdio: 'inherit' });
const client = () => { let ck = ''; return async (m, p, b) => {
  const r = await fetch(B + p, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: b ? JSON.stringify(b) : undefined });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : []; if (sc.length) ck = sc.map(c => c.split(';')[0]).join('; ');
  let j = null; try { j = await r.json(); } catch {} return { s: r.status, j, loc: r.headers.get('location') }; }; };
let pass = 0, fail = 0;
const t = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name); };
const good = { fullName: 'Ahmed Mohamed Ali', phone: '01012345678', parentPhone: '01198765432', password: '123456', confirmPassword: '123456', grade: 'Second Secondary – Baccalaureate', accountType: 'external' };
(async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(B + '/auth.html'); break; } catch { await new Promise(r => setTimeout(r, 200)); } }
  const a = client();
  let r = await a('POST', '/api/register', { ...good, phone: '0101234' }); t('rejects short phone', r.s === 400 && r.j.fields.phone);
  r = await a('POST', '/api/register', { ...good, phone: '0101234567a' }); t('rejects phone with letters', r.s === 400 && r.j.fields.phone);
  r = await a('POST', '/api/register', { ...good, phone: '01312345678' }); t('rejects non-Egyptian prefix', r.s === 400 && r.j.fields.phone);
  r = await a('POST', '/api/register', { ...good, parentPhone: '12345' }); t('rejects bad guardian phone', r.s === 400 && r.j.fields.parentPhone);
  r = await a('POST', '/api/register', { ...good, password: '12345a', confirmPassword: '12345a' }); t('rejects non-numeric password', r.s === 400 && r.j.fields.password);
  r = await a('POST', '/api/register', { ...good, password: '12345', confirmPassword: '12345' }); t('rejects 5-digit password', r.s === 400 && r.j.fields.password);
  r = await a('POST', '/api/register', { ...good, confirmPassword: '654321' }); t('rejects mismatched confirmation', r.s === 400 && r.j.fields.confirmPassword);
  r = await a('POST', '/api/register', { ...good, grade: 'Second Secondary – General' }); t('rejects removed "General" grade', r.s === 400 && r.j.fields.grade);
  r = await a('POST', '/api/register', good); t('registers external student', r.s === 201 && r.j.redirect === '/');
  r = await a('GET', '/dashboard/external'); t('logged-in student reaches own dashboard', r.s === 200);
  r = await a('GET', '/dashboard/center'); t('external student redirected away from center dashboard', r.s === 302 && r.loc === '/');
  r = await a('POST', '/api/register', good); t('duplicate phone rejected (409)', r.s === 409);
  const row = new Database(DB, { readonly: true }).prepare('SELECT * FROM students').get();
  t('stores account type, grade and guardian phone', row.account_type === 'external' && row.grade.includes('Baccalaureate') && row.parent_phone === good.parentPhone);
  t('password stored as bcrypt hash, not plain text', row.password_hash.startsWith('$2') && !row.password_hash.includes('123456'));
  const anon = client();
  r = await anon('GET', '/api/me'); t('protected API rejects anonymous (401)', r.s === 401);
  r = await anon('GET', '/dashboard/external'); t('protected page redirects anonymous to login', r.s === 302 && r.loc.includes('login'));
  r = await anon('POST', '/api/register', { ...good, phone: '01055555555', accountType: 'center' }); t('registration needs no center code (any accountType is ignored) → 201', r.s === 201 && r.j.redirect === '/');
  const row2 = new Database(DB, { readonly: true }).prepare('SELECT account_type, center_code FROM students WHERE phone = ?').get('01055555555'); t('…and is stored as a regular student without a center code', row2.account_type === 'external' && row2.center_code === null);
  r = await anon('POST', '/api/center-code/verify', { code: 'DEMO-2026' }); t('center-code verification endpoint is gone (404)', r.s === 404);
  r = await client()('GET', '/register'); t('/register serves the auth page (200)', r.s === 200);
  r = await anon('GET', '/monalingo-mark.webp'); t('logo asset is served (200)', r.s === 200);
  r = await anon('GET', '/teacher-cutout.webp'); t('old teacher photo is no longer served (404)', r.s === 404);
  r = await client()('GET', '/login'); t('/login serves the login page (200)', r.s === 200);
  r = await anon('GET', '/'); t('/ serves the homepage (200)', r.s === 200);
  r = await anon('GET', '/server.js'); const x1 = await anon('GET', '/package.json'); t('server files are not publicly served (404)', r.s === 404 && x1.s === 404);
  r = await anon('GET', '/test.html'); const x2 = await anon('GET', '/test.js'); t('exams page served, test runner file still hidden', r.s === 200 && x2.s === 404);
  { const need = new Set(); for (const pg of ['course.html', 'courses.html', 'test.html', 'lectures.html', 'profile.html', 'exam.html']) for (const m of fs.readFileSync(pg, 'utf8').matchAll(/(?:src|href)="([\w.-]+\.(?:js|css))"/g)) need.add(m[1]);
    const miss = []; for (const f of need) if ((await anon('GET', '/' + f)).s !== 200) miss.push(f);
    t('every local script/style used by the student pages is served' + (miss.length ? ' (missing: ' + miss.join(', ') + ')' : ''), !miss.length); }
  { const src = fs.readFileSync('course-lessons.js', 'utf8'); t('lesson exam link never depends on a runtime probe of test.html', !/method:\s*'HEAD'/.test(src) && !/textContent\s*=\s*'قريبًا'/.test(src)); }
  r = await anon('GET', '/lectures.html'); const x3 = await anon('GET', '/lectures.js'), x4 = await anon('GET', '/lectures.css'); t('lectures page is public (no login) and its files are served', r.s === 200 && x3.s === 200 && x4.s === 200);
  for (const p of ['/lectures', '/lecture', '/lecture/', '/lectures/']) { r = await anon('GET', p); t('legacy path ' + p + ' redirects to /lectures.html', r.s === 301 && /\/lectures\.html$/.test(r.loc || '')); }
  r = await anon('GET', '/profile.html'); t('student profile page is served (data is read client-side per logged-in student)', r.s === 200);
  r = await anon('GET', '/student-session.js'); t('shared student-session.js is served', r.s === 200);
  r = await anon('GET', '/platform-data.js'); const qi = await anon('GET', '/quiz-index-sync.js'); t('shared data layer (platform-data.js) and the dashboard quiz-index module are served', r.s === 200 && qi.s === 200);
  { const pages = ['index.html', 'courses.html', 'course.html', 'lectures.html', 'test.html', 'profile.html', 'exam.html'], bad = pages.filter(pg => { const h = fs.readFileSync(pg, 'utf8'), ex = /^(index|exam)\.html$/.test(pg) ? /href=\"\/?exam\.html\"/ : /href=\"\/?test\.html\"/; return !/href=\"\/?lectures\.html\"/.test(h) || !ex.test(h); });
    t('every student-facing page links to both lectures and exams' + (bad.length ? ' (missing: ' + bad.join(', ') + ')' : ''), !bad.length); }
  { const both = ['test.html', 'lectures.html'].every(pg => fs.readFileSync(pg, 'utf8').includes('student-session.js')); t('exams and lectures share one student-session module', both && !/async function me\(\)/.test(fs.readFileSync('test.html', 'utf8'))); }
  r = await anon('GET', '/exam.html'); const old = await anon('GET', '/exams.html'); t('old /exams.html link still works and forwards to exam.html', old.s === 200 && /exam\.html/.test(old.t || old.body || fs.readFileSync('exams.html', 'utf8'))); const e1 = await anon('GET', '/exams.js'), e2 = await anon('GET', '/exams.css'); t('exams page and its files are served', r.s === 200 && e1.s === 200 && e2.s === 200);
  { const idx = fs.readFileSync('index.html', 'utf8'), nav = (idx.match(/<nav class="nav"[^>]*>.*?<\/nav>/s) || [''])[0];
    t('index header has the «الاختبارات» tab opening exam.html (next to «المحاضرات»)', /<a href="lectures\.html">المحاضرات<\/a><a href="exam\.html">الاختبارات<\/a>/.test(nav) && /\.hx \.nav a\[href="exam\.html"\]::before/.test(idx) && !/test\.html/.test(nav)); }
  { const js = fs.readFileSync('exams.js', 'utf8'), run = fs.readFileSync('test.html', 'utf8'), pd = fs.readFileSync('platform-data.js', 'utf8');
    t('exams page reads exactly what the dashboard publishes (quizzes.isPublished) and the student results (quiz_attempts), through the shared data layer', /AD\.quizzes\.subscribe\(/.test(js) && /m\.isPublished === true/.test(js) && /AD\.attempts\(SID\)\.subscribe\(/.test(js) && /collection\('quizzes'\)\.where\('isPublished', '==', true\)/.test(pd) && /collection\('quiz_attempts'\)\.where\('studentId'/.test(pd) && /doc\('quizzes_index'\)/.test(pd));
    t('exams page excludes exams attached to lessons (lesson.quizId)', /LINK\[String\(l\.quizId\)\]/.test(js) && /!LINK\[id\]/.test(js));
    t('exams page only lists and links: no second copy of the submit/save logic', !/\.set\(|\.add\(|\.update\(|\.delete\(/.test(js) && /test\.html\?quiz=/.test(js) && /async function save\(/.test(run) && /quiz_attempts/.test(run));
    t('the exam runner keeps its controls after the redesign', ['name="o"', 'data-fin', 'data-yes', 'data-go', 'data-q=', 'id="tm"', 'class="qh"', 'class="qb"'].every(k => run.includes(k))); }
  { const idx = fs.readFileSync('index.html', 'utf8'), a = idx.indexOf('id="lectures-invite"'), b = idx.indexOf('id="exams-invite"'), c = idx.indexOf('id="teacher"'), blk = idx.slice(b, c);
    t('index has a full «الاختبارات» block directly below the lectures block, linked to exam.html (the page that lists all exams)', a > 0 && b > a && c > b && idx.slice(idx.indexOf('</section>', a) + 10, idx.lastIndexOf('<section', b)).trim() === '' && (blk.match(/href="exam\.html"/g) || []).length >= 2 && !/exams\.html|test\.html/.test(blk) && !/href="lectures\.html"/.test(blk)); }
  const l1 = client(), l2 = client();
  const bad = await l1('POST', '/api/login', { phone: '01012345678', password: '000000' });
  const unk = await l2('POST', '/api/login', { phone: '01099999999', password: '000000' });
  t('wrong password → generic 401', bad.s === 401 && bad.j.error === 'رقم الهاتف أو كلمة المرور غير صحيحة.');
  t('unknown phone → identical response', unk.s === 401 && unk.j.error === bad.j.error);
  r = await l1('POST', '/api/login', { phone: '0101', password: '12' }); t('login rejects malformed input', r.s === 400);
  r = await l1('POST', '/api/login', { phone: '01012345678', password: '123456' }); t('successful login redirects to the learning home', r.s === 200 && r.j.redirect === '/' && r.j.student.full_name === good.fullName);
  r = await l1('GET', '/api/me'); t('session works after login, no password data exposed', r.s === 200 && !('password_hash' in r.j));
  let hit = false;
  hit = false; for (let i = 0; i < 12 && !hit; i++) hit = (await client()('POST', '/api/login', { phone: '01012345678', password: '00000' + (i % 10) })).s === 429;
  t('login attempts are rate limited (429)', hit);
  console.log(`\n${pass} passed, ${fail} failed`); srv.kill(); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); srv.kill(); process.exit(1); });
