/* منطق الجلسة في المتصفح (student-session.js + نموذجا الدخول وإنشاء الحساب في auth.html) داخل jsdom بخادم مزيّف عبر fetch.
   المطلوب: لا يُحفظ كود السنتر/كلمة مرور في المتصفح أبدًا، والخروج/الانتهاء/الإيقاف يُنهي الدخول في كل الصفحات. */
'use strict';
const fs = require('fs'), path = require('path');
let J; try { J = require('jsdom'); } catch (e) { console.log('SKIP test-client-session.js — ثبّت jsdom أولًا:  npm i --no-save jsdom'); process.exit(0); }
const { JSDOM } = J, R = __dirname, read = f => fs.readFileSync(path.join(R, f), 'utf8');
let pass = 0, fail = 0; const t = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  → ' + JSON.stringify(x) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const resp = (s, o, json = true) => ({ ok: s >= 200 && s < 300, status: s, headers: { get: k => /content-type/i.test(k) ? (json ? 'application/json' : 'text/html') : null }, json: async () => o });
// وحدة الجلسة وحدها
function sess(ls, routes) {
  const d = new JSDOM('<!doctype html><div id="acct"></div>', { url: 'http://localhost/', runScripts: 'outside-only' }), w = d.window, calls = [];
  Object.entries(ls || {}).forEach(([k, v]) => w.localStorage.setItem(k, JSON.stringify(v)));
  w.fetch = async (u, o) => { calls.push(u); const r = routes[u]; return r ? r(o) : resp(404, {}, false); };
  w.eval(read('student-session.js')); return { w, calls, ss: w.StudentSession, cur: () => JSON.parse(w.localStorage.getItem('alamin_current') || 'null') };
}
const legacy = { id: 'S1', role: 'student', type: 'center', name: 'Ali Hassan', centerCode: 'ABC123', qrCode: 'ABC123', studentCollection: 'centerStudents' };
const fresh = { id: 'S1', role: 'student', type: 'center', name: 'Ali Hassan', studentCollection: 'centerStudents' };
const prof = { id: 'S1', full_name: 'Ali Hassan', grade: '1', account_type: 'center', code: 'ABC123', collection: 'centerStudents', local: 1 };

(async () => {
  let x = sess({ alamin_current: fresh }, { '/api/me': () => resp(200, prof) });
  let u = await x.ss.resolve(); t('valid server session → student (even if browser storage was cleared)', u && u.full_name === 'Ali Hassan'); 
  x = sess({}, { '/api/me': () => resp(200, prof) }); u = await x.ss.resolve(); t('works with empty localStorage (cookie is the identity)', u && u.id === 'S1' && x.cur() === null);
  x = sess({ alamin_current: fresh }, { '/api/me': () => resp(401, {}) }); u = await x.ss.resolve();
  t('server says session expired/revoked (401) → logged out everywhere', u === null && x.cur() === null);
  x = sess({ alamin_current: legacy }, { '/api/me': () => resp(401, {}), '/api/center-session': () => resp(200, { ok: true, student: { ...fresh } }) });
  u = await x.ss.resolve(); t('old local-only login is upgraded to a server session once', !!u && x.calls.includes('/api/center-session'));
  t('…and the center code is removed from browser storage', !/ABC123|centerCode|qrCode/.test(JSON.stringify(x.cur())), x.cur());
  x = sess({ alamin_current: legacy }, { '/api/me': () => resp(401, {}), '/api/center-session': () => resp(404, { error: 'x' }) }); u = await x.ss.resolve();
  t('old login whose record no longer exists → logged out and storage cleared', u === null && x.cur() === null);
  x = sess({ alamin_current: legacy }, { '/api/me': () => resp(401, {}), '/api/center-session': () => resp(403, { error: 'blocked' }) }); u = await x.ss.resolve();
  t('old login whose access was revoked (403) → logged out', u === null && x.cur() === null);
  x = sess({ alamin_current: legacy }, { '/api/me': () => resp(401, {}), '/api/center-session': () => resp(503, {}) }); u = await x.ss.resolve();
  t('temporary outage during upgrade does not log the student out', !!u && x.cur() && x.cur().id === 'S1');
  x = sess({ alamin_current: fresh }, {}); u = await x.ss.resolve(); t('static hosting (no /api) keeps the local student (no code stored)', !!u && u.id === 'S1' && !x.cur().centerCode);
  x = sess({ alamin_current: { id: 0, name: 'admin', role: 'admin' } }, { '/api/me': () => resp(401, {}) }); await x.ss.resolve(); t('admin marker is never touched by student session cleanup', x.cur() && x.cur().role === 'admin');
  x = sess({}, {}); x.ss.store({ id: 1, name: 'A', centerCode: 'Z', qrCode: 'Z', offlineCode: 'Z', code: 'Z', password: 'p', pin: '1', passcode: '2' });
  t('store() strips center codes and passwords', JSON.stringify(x.cur()) === JSON.stringify({ id: 1, name: 'A' }));
  x = sess({ alamin_current: fresh }, { '/api/logout': () => resp(200, { ok: true }) }); await x.ss.logout(); t('logout clears the server session and the local copy', x.cur() === null && x.calls.includes('/api/logout'));

  // صفحة auth.html الجديدة: شاشتان فقط (دخول / إنشاء حساب) بدون كود سنتر
  const src = read('auth.html');
  t('auth.html: no center-code UI or old teacher branding left', !/center-?code|centerCode|accountType|سنتر|teacher-cutout|الأمين|مستر|f-code/i.test(src.replace(/ADMIN_[A-Z]+=[^,;]+|الأستاذ الأمين|yghjni-alamin/g, '')));
  async function open(url, routes = {}) {
    const w = new JSDOM(src, { url, runScripts: 'dangerously', pretendToBeVisual: true, beforeParse(w) { w.fetch = async (u, o) => (routes[u] ? routes[u](o) : resp(404, {}, false)); w.scrollTo = () => {}; } }).window;
    await sleep(50); return w;
  }
  const vis = w => ['login', 'register'].filter(n => !w.document.getElementById('v-' + n).hidden);
  let w = await open('http://localhost/auth.html#/login'); t('auth.html#/login opens Login directly', vis(w).join() === 'login' && w.document.querySelectorAll('#f-login input').length === 2);
  w = await open('http://localhost/auth.html#/register'); t('auth.html#/register opens Create Account directly', vis(w).join() === 'register' && w.document.querySelectorAll('#f-reg input,#f-reg select').length === 6);
  w = await open('http://localhost/register'); t('/register path opens Create Account', vis(w).join() === 'register');
  for (const [h, v] of [['#/choose', 'register'], ['#/center', 'login'], ['#/signin', 'login'], ['', 'login']]) { w = await open('http://localhost/auth.html' + h); t('legacy route "' + h + '" → ' + v, vis(w).join() === v); }
  w = await open('http://localhost/auth.html#/login', { '/api/login': o => resp(200, { ok: true, redirect: '/', student: { id: 1, full_name: 'Ali Hassan' } }) });
  const f = w.document.getElementById('f-login'); f.elements.phone.value = '01012345678'; f.elements.password.value = '123456'; f.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(150);
  t('login form posts phone+password and shows the welcome message', /Welcome, Ali Hassan/.test(f.querySelector('.al').textContent));
  w = await open('http://localhost/auth.html#/register', { '/api/register': o => { w.__body = JSON.parse(o.body); return resp(201, { ok: true, redirect: '/' }); } });
  const g = w.document.getElementById('f-reg'), set = (n, v) => { g.elements[n].value = v; };
  set('fullName', 'Ahmed Mohamed Ali'); set('phone', '01012345678'); set('parentPhone', '01198765432'); set('password', '123456'); set('confirmPassword', '123456'); set('grade', 'First Secondary');
  g.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); await sleep(150);
  t('registration sends no accountType / center code', w.__body && !('accountType' in w.__body) && !/center/i.test(JSON.stringify(w.__body)), w.__body);
  w = await open('http://localhost/auth.html#/login'); const lf = w.document.getElementById('f-login'); lf.elements.phone.value = '2026'; lf.elements.phone.dispatchEvent(new w.Event('input', { bubbles: true }));
  t('admin id still switches the password field to free text', lf.elements.password.maxLength === 128 && lf.classList.contains('admin'));
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
