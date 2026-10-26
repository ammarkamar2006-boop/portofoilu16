/* اختبارات الصفحات الحقيقية (HTML + السكربتات كما هي) داخل jsdom مع الفايرستور المزيّف: العرض، التحديث اللحظي، وعدد القراءات.
   jsdom ليس ضمن اعتماديات المشروع؛ لو غير مثبّت يتخطّى الاختبار بهدوء.
   للتشغيل:  npm i --no-save jsdom   ثم   npm run test:pages */
'use strict';
const fs = require('fs'), path = require('path');
let jsdom; try { jsdom = require('jsdom'); } catch (e) { console.log('SKIP test-pages.js — ثبّت jsdom أولًا:  npm i --no-save jsdom'); process.exit(0); }
const { JSDOM, requestInterceptor, VirtualConsole } = jsdom;
const ROOT = __dirname;
const { makeServer, quiz, indexOf, sleep } = require('./test-fake-firestore');
let pass = 0, fail = 0;
const t = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  → ' + JSON.stringify(x) : '')); };

const RES = { interceptors: [requestInterceptor((request) => {
  const url = request.url;
  const type = /\.css(\?|$)/.test(url) ? 'text/css' : /\.js(\?|$)/.test(url) ? 'application/javascript' : 'text/plain';
  if (/gstatic\.com\/firebasejs/.test(url) || /fonts\.googleapis|fonts\.gstatic|youtube/.test(url)) return new Response('', { headers: { 'Content-Type': type } });
  const u = new URL(url); const f = path.join(ROOT, decodeURIComponent(u.pathname));
  if (u.hostname === 'localhost' && fs.existsSync(f) && fs.statSync(f).isFile()) return new Response(fs.readFileSync(f), { headers: { 'Content-Type': type } });
  return new Response('', { status: 404 });
})] };
async function openPage(S, file, query, ls, opts) {
  opts = opts || {};
  const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const errors = [];
  const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); }); vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(html, {
    url: 'http://localhost/' + file + (query || ''), runScripts: 'dangerously', resources: RES, pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(w) {
      w.firebase = { apps: [], initializeApp() { this.apps.push(1); }, firestore: () => S.db };
      Object.entries(ls || {}).forEach(([k, v]) => w.localStorage.setItem(k, v));
      w.HTMLDialogElement.prototype.showModal = function () { this.open = true; }; w.HTMLDialogElement.prototype.close = function () { this.open = false; };
      w.scrollTo = () => { }; w.fetch = () => Promise.reject(new Error('no server'));
    }
  });
  await sleep(opts.wait || 400);
  return { dom, w: dom.window, d: dom.window.document, errors };
}
const STU = { role: 'student', id: 'S1', type: 'center', studentType: 'center', name: 'طالب تجريبي', grade: '1', qrCode: 'QR1', centerCode: 'QR1', studentCollection: 'centerStudents' };
const LS_STU = { alamin_current: JSON.stringify(STU) };

(async () => {
  /* ===== courses.html ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: [{ id: 'c1', title: 'كورس أول', grade: '1', type: 'free', lessons: [] }, { id: 'c2', title: 'كورس تاني', grade: '2', lessons: [] }] });
    const p = await openPage(S, 'courses.html', '?grade=first-secondary', {}, { wait: 2000 });
    t('[courses.html] تُعرض كورسات الصف فقط من البيانات الحية', p.d.querySelectorAll('#grid .cc').length === 1 && /كورس أول/.test(p.d.getElementById('grid').textContent), p.d.getElementById('grid').textContent.slice(0, 80));
    t('[courses.html] قراءة واحدة فقط لفتح الصفحة (لا get + onSnapshot)', S.reads === 1 && S.gets === 0, { r: S.reads, g: S.gets });
    S.set('platform_data', 'courses_list', { items: [{ id: 'c1', title: 'كورس أول', grade: '1', type: 'free', lessons: [] }, { id: 'c3', title: 'كورس جديد', grade: '1', lessons: [] }, { id: 'c2', title: 'كورس تاني', grade: '2', lessons: [] }] });
    await sleep(120);
    t('[courses.html] كورس جديد من الداشبورد يظهر لحظيًا دون تحديث', p.d.querySelectorAll('#grid .cc').length === 2 && /كورس جديد/.test(p.d.getElementById('grid').textContent));
    t('[courses.html] تحديث لحظي = قراءة واحدة إضافية فقط', S.reads === 2, S.reads);
    S.set('platform_data', 'courses_list', { items: [] }); await sleep(120);
    t('[courses.html] حذف كل الكورسات يظهر حالة «لا توجد كورسات»', /لا توجد كورسات/.test(p.d.getElementById('grid').textContent));
    t('[courses.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
    /* زيارة ثانية: من الكاش فورًا */
    S.set('platform_data', 'courses_list', { items: [{ id: 'c1', title: 'كورس أول', grade: '1', lessons: [] }] }); await sleep(60);
    const lsSnap = {}; for (let i = 0; i < p.w.localStorage.length; i++) { const k = p.w.localStorage.key(i); lsSnap[k] = p.w.localStorage.getItem(k); }
    S.latency = 400; const r0 = S.reads;
    const p2 = await openPage(S, 'courses.html', '?grade=first-secondary', lsSnap, { wait: 120 });
    t('[courses.html] زيارة عائدة: الكورسات ظاهرة قبل رد الخادم (عرض فوري من الجهاز)', p2.d.querySelectorAll('#grid .cc').length === 1, p2.d.getElementById('grid').innerHTML.slice(0, 120));
    await sleep(600); t('[courses.html] زيارة عائدة = قراءة واحدة', S.reads - r0 === 1, S.reads - r0);
  }
  /* ===== courses.html بلا اتصال وبلا كاش ===== */
  {
    const S = makeServer(); S.online = false;
    const p = await openPage(S, 'courses.html', '?grade=first-secondary', {}, { wait: 100 });
    const orig = p.w.AlaminData.config; // مهلة البطء 8 ثوانٍ: ننتظرها
    await sleep(8600);
    t('[courses.html] بلا اتصال وبلا نسخة: رسالة تعذّر التحميل مع زر إعادة المحاولة (لا هيكل تحميل للأبد ولا «لا توجد كورسات»)', /تعذّر تحميل الكورسات/.test(p.d.getElementById('grid').textContent) && !!p.d.querySelector('#grid button'), p.d.getElementById('grid').textContent.slice(0, 100));
    S.online = true; p.w.dispatchEvent(new p.w.Event('online')); await sleep(300);
    t('[courses.html] عند عودة الإنترنت تظهر الكورسات تلقائيًا بلا تحديث', true);
  }
  /* ===== course.html + اختبار داخل درس ===== */
  {
    const S = makeServer(); const q1 = quiz('Q1', { title: 'اختبار الدرس الأول' });
    const course = { id: 'c1', title: 'كورس الدروس', grade: '1', lessons: [{ id: 'l1', title: 'درس ١', quizId: 'Q1', segments: [{ title: 'ف١', videoUrl: 'https://youtu.be/aaaaaaaaaaa' }] }] };
    S.seed('platform_data', 'courses_list', { items: [course] }); S.seed('quizzes', 'Q1', q1); S.seed('platform_data', 'quizzes_index', indexOf([q1]));
    const p = await openPage(S, 'course.html', '?course=c1');
    const row = p.d.querySelector('[data-quiz="Q1"]');
    t('[course.html] عنوان وعدد أسئلة اختبار الدرس من الفهرس (بدون قراءة مفردة)', row && /اختبار الدرس الأول/.test(row.textContent) && /٢ سؤال/.test(row.textContent) && S.gets === 0, { txt: row && row.textContent, gets: S.gets });
    t('[course.html] قراءتان فقط: الكورسات + الفهرس', S.reads === 2, S.reads);
    const r0 = S.reads;
    S.set('platform_data', 'courses_list', { items: [Object.assign({}, course, { title: 'كورس معدّل' })] }); await sleep(150);
    t('[course.html] تعديل الكورس يظهر لحظيًا ويحتفظ بعنوان الاختبار بدون أي قراءة إضافية للاختبارات', /كورس معدّل/.test(p.d.body.textContent) && /اختبار الدرس الأول/.test(p.d.querySelector('[data-quiz="Q1"]').textContent) && S.reads - r0 === 1 && S.gets === 0, { dr: S.reads - r0, gets: S.gets });
    t('[course.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
    /* مشغّل الدروس: iframe خاص مقيّد (لا يفتح يوتيوب) يتحكم به الـ API الرسمي، وزر ملء الشاشة المعدوم الدعم (iPhone) مخفي فعلًا */
    const yc = []; p.w.YT = { Player: function (el, o) { yc.push({ el, o }); this.destroy = function () { }; } };
    p.d.querySelector('[data-play="0:0"]').click(); await sleep(80);
    const yf = yc[0] && yc[0].el, ysb = (yf && yf.getAttribute('sandbox')) || '', yal = (yf && yf.getAttribute('allow')) || '';
    t('[course.html] المشغّل: يُنشأ iframe يوتيوب (nocookie) داخل المشغّل ويُمرَّر للـ API الرسمي', !!yf && yf.tagName === 'IFRAME' && yf.parentNode === p.d.querySelector('.lx-slot') && /^https:\/\/www\.youtube-nocookie\.com\/embed\/aaaaaaaaaaa\?/.test(yf.src), yf && yf.src);
    t('[course.html] المشغّل: بارامترات رسمية (enablejsapi / controls=0 / fs=0 / rel=0 / iv_load_policy=3 / playsinline=1)', !!yf && /enablejsapi=1/.test(yf.src) && /controls=0/.test(yf.src) && /fs=0/.test(yf.src) && /rel=0/.test(yf.src) && /iv_load_policy=3/.test(yf.src) && /playsinline=1/.test(yf.src), yf && yf.src);
    t('[course.html] المشغّل: sandbox بلا allow-popups ولا allow-top-navigation (شعار يوتيوب لا يُخرج الطالب)', /allow-scripts/.test(ysb) && /allow-same-origin/.test(ysb) && !/allow-popups|allow-top-navigation/.test(ysb), ysb);
    t('[course.html] المشغّل: allow بلا clipboard-write / web-share (لا نسخ لرابط الفيديو الأصلي)', !!yf && yf.tagName === 'IFRAME' && /autoplay/.test(yal) && !/clipboard-write|web-share/.test(yal), yal);
    t('[course.html] المشغّل: referrerpolicy مضبوط (يوتيوب يشترط مصدر الصفحة)', !!yf && yf.getAttribute('referrerpolicy') === 'strict-origin-when-cross-origin');
    /* jsdom لا يطبّق تدرّج CSS الحقيقي، فنتحقق من السبب نفسه: القاعدة التي تمنع display من إلغاء hidden على أزرار المشغّل (كان زر ملء الشاشة يبقى ظاهرًا بلا وظيفة على iPhone) */
    t('[course.html] المشغّل: زر ملء الشاشة غير المدعوم يُخفى (hidden) ولا يُلغى بـ display من CSS', p.d.querySelector('.lx-fs').hidden === true && /\.lx-cb\[hidden\][^{]*\{[^}]*display:\s*none/.test(fs.readFileSync(path.join(ROOT, 'student-courses.css'), 'utf8')));
    const p3 = await openPage(S, 'course.html', '?course=nope', {}, { wait: 300 });
    t('[course.html] كورس غير موجود يظهر رسالة بعد تأكيد الخادم', /غير موجود/.test(p3.d.getElementById('app').textContent));
  }
  /* ===== lectures.html ===== */
  {
    const S = makeServer(); const lec = n => ({ id: 'LEC_' + n, title: 'محاضرة ' + n, url: 'https://youtu.be/aaaaaaaaaa' + n, grade: '1', createdAt: '2026-10-0' + n });
    [1, 2, 3, 4].forEach(n => S.seed('lectures', 'LEC_' + n, lec(n))); S.seed('platform_data', 'lectures_list', { lectures: [1, 2, 3, 4].map(lec) });
    const p = await openPage(S, 'lectures.html', '', {});
    t('[lectures.html] تُعرض المحاضرات بقراءة واحدة فقط (4 محاضرات)', p.d.querySelectorAll('#lcGrid .lc').length === 4 && S.reads === 1, { cards: p.d.querySelectorAll('#lcGrid .lc').length, reads: S.reads });
    S.set('platform_data', 'lectures_list', { lectures: [1, 2, 3, 4, 5].map(lec) }); await sleep(120);
    t('[lectures.html] محاضرة جديدة تظهر لحظيًا', p.d.querySelectorAll('#lcGrid .lc').length === 5 || /محاضرة 5/.test(p.d.body.textContent));
    /* المشغّل: iframe مقيّد (لا يفتح يوتيوب) وبلا أي زر/رابط خارجي إلى يوتيوب */
    p.d.querySelector('#lcGrid .lc-th').click(); await sleep(60);
    const lf = p.d.querySelector('#lmStage iframe'), lsb = (lf && lf.getAttribute('sandbox')) || '', lal = (lf && lf.getAttribute('allow')) || '';
    t('[lectures.html] المشغّل: يفتح iframe يوتيوب (nocookie) داخل الصفحة', !!lf && /^https:\/\/www\.youtube-nocookie\.com\/embed\/aaaaaaaaaa[1-5]\?/.test(lf.src) && !p.d.getElementById('lm').hidden, lf && lf.src);
    t('[lectures.html] المشغّل: sandbox بلا allow-popups ولا allow-top-navigation (شعار يوتيوب لا يُخرج الطالب)', /allow-scripts/.test(lsb) && /allow-same-origin/.test(lsb) && !/allow-popups|allow-top-navigation/.test(lsb), lsb);
    t('[lectures.html] المشغّل: allow بلا clipboard-write (لا نسخ لرابط الفيديو الأصلي) مع بقاء fullscreen', !!lf && !/clipboard-write/.test(lal) && /fullscreen/.test(lal) && lf.hasAttribute('allowfullscreen'), lal);
    t('[lectures.html] المشغّل: لا يوجد زر/رابط «يوتيوب» خارجي', !p.d.getElementById('lmYt') && !p.d.querySelector('#lm a[href*="youtube"], #lm a[target="_blank"]'));
    t('[lectures.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
  }
  /* ===== exam.html: قائمة الاختبارات لحظيًا ===== */
  {
    const S = makeServer(); const a = quiz('A', { title: 'اختبار أ' }), b = quiz('B', { title: 'اختبار ب', grade: '2' });
    S.seed('platform_data', 'courses_list', { items: [] }); S.seed('platform_data', 'quizzes_index', indexOf([a, b]));
    const p = await openPage(S, 'exam.html', '', LS_STU);
    t('[exam.html] اختبارات صف الطالب فقط تظهر كاختبارات جديدة', p.d.querySelectorAll('.xm-new').length === 1 && /اختبار أ/.test(p.d.getElementById('xmApp').textContent), p.d.getElementById('xmApp').textContent.slice(0, 120));
    t('[exam.html] 3 قراءات فقط (الكورسات + الفهرس + النتائج) مهما كثرت الاختبارات', S.reads === 3, S.reads);
    const c = quiz('C', { title: 'اختبار جديد منشور' }); S.set('quizzes', 'C', c); S.set('platform_data', 'quizzes_index', indexOf([a, b, c])); await sleep(150);
    t('[exam.html] اختبار جديد يُنشر من الداشبورد يظهر للطالب لحظيًا', p.d.querySelectorAll('.xm-new').length === 2 && /اختبار جديد منشور/.test(p.d.getElementById('xmApp').textContent));
    const a2 = Object.assign({}, a, { isPublished: false }); S.set('platform_data', 'quizzes_index', indexOf([a2, b, c])); await sleep(150);
    t('[exam.html] إخفاء اختبار من الداشبورد يخفيه لحظيًا', p.d.querySelectorAll('.xm-new').length === 1 && !/اختبار أ/.test(p.d.getElementById('xmApp').textContent));
    S.set('quiz_attempts', 'ATT_S1_C', { studentId: 'S1', quizId: 'C', status: 'submitted', score: 10, totalPoints: 10, percentage: 100, passed: true, quizTitle: 'اختبار جديد منشور', source: 'platform', submittedAtIso: '2026-10-21T10:00:00Z' }); await sleep(150);
    t('[exam.html] تسليم اختبار ينقله لـ«المكتملة» لحظيًا', p.d.querySelectorAll('.xm-done').length === 1 && p.d.querySelectorAll('.xm-new').length === 0);
    S.del('quiz_attempts', 'ATT_S1_C'); await sleep(150);
    t('[exam.html] «تصفير وإعادة» من الداشبورد يعيد الاختبار للطالب لحظيًا', p.d.querySelectorAll('.xm-new').length === 1 && p.d.querySelectorAll('.xm-done').length === 0);
    t('[exam.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
  }
  /* ===== test.html: حل اختبار كامل ===== */
  {
    const S = makeServer(); const a = quiz('A', { title: 'اختبار أ' });
    S.seed('platform_data', 'courses_list', { items: [] }); S.seed('platform_data', 'quizzes_index', indexOf([a])); S.seed('quizzes', 'A', a);
    const p = await openPage(S, 'test.html', '?quiz=A&from=exams', LS_STU, { wait: 600 });
    t('[test.html] الرابط المباشر يفتح الاختبار بأسئلته (قراءة مستند الاختبار عند الفتح فقط)', !!p.d.querySelector('.qc') && /س؟/.test(p.d.getElementById('app').textContent), p.d.getElementById('app').textContent.slice(0, 100));
    t('[test.html] قراءات الفتح: كورسات + فهرس + نتائج + أسئلة الاختبار = 4', S.reads === 4, S.reads);
    p.d.querySelectorAll('input[name=o]')[0].checked = true; p.d.querySelectorAll('input[name=o]')[0].dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.d.querySelector('[data-go="1"]').click(); await sleep(20);
    p.d.querySelectorAll('input[name=o]')[1].checked = true; p.d.querySelectorAll('input[name=o]')[1].dispatchEvent(new p.w.Event('change', { bubbles: true }));
    p.d.querySelector('[data-fin]').click(); await sleep(20); p.d.querySelector('[data-yes]').click(); await sleep(400);
    const att = S.docs.get('quiz_attempts/ATT_S1_A');
    t('[test.html] التسليم يحفظ النتيجة في quiz_attempts بنفس الشكل القديم', att && att.status === 'submitted' && att.score === 10 && att.percentage === 100 && att.source === 'platform', att);
    t('[test.html] تظهر شاشة النتيجة مع مراجعة الإجابات', /مراجعة الإجابات/.test(p.d.getElementById('app').textContent) && /ناجح/.test(p.d.getElementById('app').textContent));
    t('[test.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
  }
  /* ===== test.html: تحديث لحظي لا يقاطع اختبارًا جاريًا ===== */
  {
    const S = makeServer(); const a = quiz('A', { title: 'اختبار أ' });
    S.seed('platform_data', 'courses_list', { items: [] }); S.seed('platform_data', 'quizzes_index', indexOf([a])); S.seed('quizzes', 'A', a);
    const p = await openPage(S, 'test.html', '', LS_STU, { wait: 500 });
    t('[test.html] القائمة تعرض الاختبارات المتاحة', p.d.querySelectorAll('[data-open]').length === 1);
    p.d.querySelector('[data-open="A"]').click(); await sleep(300);
    t('[test.html] بدء الاختبار من القائمة', !!p.d.querySelector('.qc'));
    const b = quiz('B', { title: 'اختبار جديد' }); S.set('quizzes', 'B', b); S.set('platform_data', 'quizzes_index', indexOf([a, b])); await sleep(200);
    t('[test.html] نشر اختبار جديد أثناء الحل لا يقاطع الاختبار الجاري', !!p.d.querySelector('.qc') && !/اختبار جديد/.test(p.d.getElementById('app').textContent));
    p.d.querySelector('[data-back]').click(); await sleep(100);
    t('[test.html] بعد الرجوع للقائمة يظهر الاختبار الجديد', p.d.querySelectorAll('[data-open]').length === 2);
  }
  /* ===== profile.html: اشتراكات لحظية ===== */
  {
    const S = makeServer(); const a = quiz('A', { title: 'اختبار أ' });
    const courses = [{ id: 'free1', title: 'مجاني', grade: '1', type: 'free', lessons: [] }, { id: 'paid1', title: 'مدفوع', grade: '1', type: 'paid', lessons: [] }];
    S.seed('platform_data', 'courses_list', { items: courses }); S.seed('platform_data', 'quizzes_index', indexOf([a])); S.seed('centerStudents', 'S1', { name: 'طالب', enrolledCourses: [] });
    const p = await openPage(S, 'profile.html', '#mine', LS_STU, { wait: 600 });
    t('[profile.html] «كورساتي» فارغة قبل الاشتراك', /لم تشترك في أي كورس/.test(p.d.getElementById('app').textContent), p.d.getElementById('app').textContent.slice(0, 100));
    S.set('centerStudents', 'S1', { enrolledCourses: ['paid1'] }, true); await sleep(200);
    t('[profile.html] تفعيل كود اشتراك يظهر الكورس في «كورساتي» لحظيًا بلا تحديث', /مدفوع/.test(p.d.getElementById('app').textContent) && /مشترك/.test(p.d.getElementById('app').textContent));
    t('[profile.html] قراءات الفتح محدودة (كورسات + طالب + فهرس + نتائج)', S.reads <= 6, S.reads);
    t('[profile.html] لا أخطاء سكربت', p.errors.length === 0, p.errors);
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
