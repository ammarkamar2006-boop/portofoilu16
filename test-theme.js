/* اختبارات الوضع النهاري/الليلي: theme.js على صفحات المنصة الفعلية داخل jsdom + فحص ثابت للـ CSS.
   لو jsdom غير مثبّت يتخطّى بهدوء:  npm i --no-save jsdom */
'use strict';
const fs = require('fs'), path = require('path');
let J; try { J = require('jsdom'); } catch (e) { console.log('SKIP test-theme.js — ثبّت jsdom أولًا:  npm i --no-save jsdom'); process.exit(0); }
const { JSDOM } = J, R = __dirname, src = fs.readFileSync(path.join(R, 'theme.js'), 'utf8');
let pass = 0, fail = 0; const t = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  → ' + JSON.stringify(x) : '')); };
const PAGES = ['index.html', 'auth.html', 'profile.html', 'courses.html', 'course.html', 'lectures.html', 'test.html', 'exam.html', 'dashboard.html'];
const read = f => fs.readFileSync(path.join(R, f), 'utf8');
// يفتح الصفحة الحقيقية (بدون سكربتاتها الأخرى) ثم يشغّل theme.js كما يفعل المتصفح؛ store = محتوى localStorage المحفوظ من زيارة سابقة
function open(f, store, opts = {}) {
  const d = new JSDOM(read(f), { url: 'http://localhost/' + f, runScripts: 'outside-only' }), w = d.window;
  if (opts.systemDark) w.matchMedia = q => ({ matches: /dark/.test(q), addEventListener() { }, addListener() { } });
  if (opts.noStorage) Object.defineProperty(w, 'localStorage', { get() { throw new Error('blocked'); } });
  else Object.entries(store || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
  w.eval(src); w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  return w;
}
const theme = w => w.document.documentElement.getAttribute('data-theme');
const flip = w => { const c = w.document.getElementById('thm'), b = w.document.getElementById('tg'); if (c) { c.checked = !c.checked; c.dispatchEvent(new w.Event('change', { bubbles: true })); } else b.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };

for (const f of PAGES) {
  const html = read(f), head = html.slice(0, html.indexOf('</head>')), at = head.indexOf('src="theme.js"');
  t(`[${f}] theme.js loaded synchronously in <head>`, at > 0 && !/<script[^>]*src="theme.js"[^>]*(defer|async)/.test(head));
  t(`[${f}] theme.js comes before any stylesheet/style (no flash)`, at > 0 && !/<link[^>]*stylesheet|<style/.test(head.slice(0, at)));
}
for (const f of PAGES.filter(x => x !== 'dashboard.html')) {
  const w = open(f);
  t(`[${f}] first visit → light`, theme(w) === 'light' && w.localStorage.getItem('theme') === null);
  const s = open(f, {}, { systemDark: true });
  t(`[${f}] first visit stays light even if the OS is dark`, theme(s) === 'light');
  flip(w); t(`[${f}] toggle → dark and saved`, theme(w) === 'dark' && w.localStorage.getItem('theme') === 'dark');
  const n = open(f, { theme: 'dark' }, { systemDark: false }); t(`[${f}] next page / refresh / reopen keeps dark (applied before body exists)`, theme(n) === 'dark');
  const o = open(f, { theme: 'light' }, { systemDark: true }); t(`[${f}] saved light is not overridden by a dark OS`, theme(o) === 'light');
  flip(w); t(`[${f}] toggle back → light and saved`, theme(w) === 'light' && w.localStorage.getItem('theme') === 'light');
  const c = w.document.getElementById('thm'); if (c) { flip(w); t(`[${f}] checkbox mirrors the theme`, c.checked === (theme(w) === 'dark')); }
}
{ // مزامنة التبويبات + الرجوع من الكاش + تخزين محجوب
  const w = open('index.html'); w.localStorage.setItem('theme', 'dark'); w.dispatchEvent(new w.StorageEvent('storage', { key: 'theme', newValue: 'dark' }));
  t('another tab switching to dark updates this tab immediately', theme(w) === 'dark');
  const x = open('index.html', {}, { noStorage: true }); t('blocked storage → still light, no crash', theme(x) === 'light');
  flip(x); t('blocked storage → toggle still works in the page (cookie fallback)', theme(x) === 'dark' && /theme=dark/.test(x.document.cookie));
  const y = open('index.html', {}, { noStorage: true }); /* نفس الكوكي لا ينتقل بين نوافذ jsdom؛ نكتفي بقراءة المسار */ t('no matchMedia / OS preference is read by theme.js', !/matchMedia|prefers-color-scheme/.test(src));
}
// CSS: لا اعتماد على إعداد النظام ولا على حالة checkbox فقط
const FILES = ['index.html', 'auth.html', 'profile.html', 'courses.html', 'course.html', 'lectures.html', 'test.html', 'exam.html', 'student-courses.css', 'exams.css', 'mobile-header.css', 'lectures.css', 'dev-signature.css'];
const bad = FILES.filter(f => /prefers-color-scheme|:has\(#thm:checked\)|:not\(:has\(#thm/.test(read(f)));
t('no stylesheet follows the OS colour scheme or the checkbox state directly', bad.length === 0, bad);
t('dark palette is driven by html[data-theme=dark] in the shared stylesheet', /html\[data-theme=dark\] \.pg\{--bg:#08111F/.test(read('student-courses.css')) && /\.pg\{[^}]*--bg:#FFFFFF/.test(read('student-courses.css')));
t('mobile toggle thumb follows data-theme', /@media\(max-width:720px\)\{html\[data-theme=dark\] \.pg \.tg::before/.test(read('mobile-header.css')));
t('home page palette + hero + toggle follow data-theme', (read('index.html').match(/html\[data-theme=dark\] \.pg/g) || []).length >= 5);
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
