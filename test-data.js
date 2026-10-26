'use strict';
/* اختبارات طبقة البيانات المشتركة platform-data.js بدون أي مكتبات خارجية.
   نشغّل الملف الحقيقي داخل بيئة معزولة (vm) مع «فايرستور مزيّف» يحاكي الاحتساب الحقيقي للقراءات:
     • get() = قراءة لكل مستند راجع (حدّ أدنى 1)
     • onSnapshot الأولى = قراءة لكل مستند في النتيجة (حدّ أدنى 1)
     • كل تغيير يصل لمستمع نشط = قراءة لكل مستند تغيّر
   ثم نتحقق من العرض الفوري من الكاش، والتحديث اللحظي، ومشاركة المستمع، والاسترجاع عند الخطأ، وعدد القراءات.
   التشغيل:  node test-data.js   (أو npm run test:data) */
const fs = require('fs'), vm = require('vm'), path = require('path');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? pass++ : fail++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (!cond && extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); };
const SRC = fs.readFileSync(path.join(__dirname, 'platform-data.js'), 'utf8');

const { makeServer, makeLS, COURSES, quiz, indexOf, sleep } = require('./test-fake-firestore');
/* صفحة جديدة = سياق جديد (ذاكرة نظيفة) لكن بنفس localStorage والخادم (زيارة عائدة) */
function page(S, ls) {
  const handlers = {}, docHandlers = {};
  const ctx = { setTimeout, clearTimeout, setInterval, clearInterval, console, Date, localStorage: ls || makeLS(), navigator: { onLine: true }, db: S.db };
  ctx.window = ctx;
  ctx.addEventListener = (n, f) => (handlers[n] = handlers[n] || []).push(f);
  ctx.document = { hidden: false, addEventListener: (n, f) => (docHandlers[n] = docHandlers[n] || []).push(f) };
  ctx.fire = (n, e) => (handlers[n] || []).forEach(f => f(e || {}));
  vm.createContext(ctx); vm.runInContext(SRC, ctx);
  const AD = ctx.AlaminData; Object.assign(AD.config, { SLOW_MS: 300, GRACE_MS: 120, RETRY: [60, 120, 240, 480, 960] });
  return { ctx, AD, ls: ctx.localStorage };
}
(async () => {
  /* ===== الكورسات: بداية باردة ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES, lastUpdated: 'a' });
    const { AD, ls, ctx } = page(S); const got = [];
    t('الكاش الدائم يُفعَّل مرة واحدة بوضع تعدد التبويبات وقبل أي مستمع', S.persistCalls.length === 1 && S.persistCalls[0].o.synchronizeTabs === true && S.persistCalls[0].attachesBefore === 0);
    const un = AD.courses.subscribe(p => got.push(p));
    await sleep(5); t('بدون كاش: لا يُعرض شيء قبل وصول البيانات (يبقى الهيكل التحميلي)', got.length === 0);
    await sleep(60);
    t('تصل البيانات مؤكَّدة من الخادم', got.length === 1 && got[0].live && got[0].ok && got[0].data.length === 2, got.length);
    t('قراءة واحدة فقط لتحميل الكورسات (لا get ثم onSnapshot)', S.reads === 1 && S.gets === 0 && S.attaches === 1, { reads: S.reads, gets: S.gets });
    t('تُحفظ نسخة الجهاز بنفس مفتاح المنصة القديم + ختم وقت', JSON.parse(ls.getItem('alamin_courses')).length === 2 && JSON.parse(ls.getItem('alamin_pd_m_courses')).ts > 0);
    /* لحظي */
    S.set('platform_data', 'courses_list', { items: COURSES.concat([{ id: 'c3', title: 'جديد', grade: '3', lessons: [] }]), lastUpdated: 'b' }, true);
    await sleep(60);
    t('كورس جديد من الداشبورد يصل للطالب لحظيًا بلا تحديث', got.length === 2 && got[1].data.length === 3 && got[1].data[2].id === 'c3');
    t('التحديث اللحظي كلّف قراءة واحدة فقط', S.reads === 2, S.reads);
    S.set('platform_data', 'courses_list', { items: COURSES.map(c => Object.assign({}, c, { title: c.title + '!' })), lastUpdated: 'c' }, true);
    await sleep(60); t('تعديل عنوان كورس ينعكس لحظيًا', got.length === 3 && got[2].data[0].title === 'كورس ١!');
    un();
  }
  /* ===== زيارة عائدة: عرض فوري من الكاش ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES, lastUpdated: 'a' }); S.latency = 120;
    const first = page(S); first.AD.courses.subscribe(() => { }); await sleep(250);
    const reads1 = S.reads;
    const second = page(S, first.ls); const got = []; const t0 = Date.now(); let tFirst = 0;
    second.AD.courses.subscribe(p => { if (!tFirst) tFirst = Date.now() - t0; got.push(p); });
    await sleep(30);
    t('زيارة عائدة: الكورسات تظهر فورًا من نسخة الجهاز قبل ردّ الخادم', got.length === 1 && got[0].data.length === 2 && !got[0].live && got[0].ok && tFirst < 60, { n: got.length, tFirst });
    await sleep(300);
    t('عند وصول نفس البيانات من الخادم لا تُعاد الرسم ولا يظهر تنبيه انقطاع', got.length === 1 && got[0].ok, got.length);
    t('الزيارة العائدة = قراءة واحدة', S.reads - reads1 === 1, S.reads - reads1);
  }
  /* ===== مشاركة المستمع بين عدة مشتركين + مهلة السماح ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES }); const { AD } = page(S);
    const a = AD.courses.subscribe(() => { }), b = AD.courses.subscribe(() => { }), c = AD.courses.subscribe(() => { });
    await sleep(60);
    t('3 اشتراكات في الصفحة = مستمع واحد وقراءة واحدة', S.attaches === 1 && S.reads === 1, { a: S.attaches, r: S.reads });
    a(); b(); c(); await sleep(30);
    const d = AD.courses.subscribe(() => { }); await sleep(30);
    t('إعادة الاشتراك خلال مهلة السماح لا تفتح مستمعًا جديدًا ولا تقرأ', S.attaches === 1 && S.reads === 1, { a: S.attaches, r: S.reads });
    d(); await sleep(250);
    t('بعد خروج آخر مشترك يُغلق المستمع', AD.stats().activeListeners === 0);
    AD.courses.subscribe(() => { }); await sleep(60);
    t('اشتراك جديد بعد الإغلاق يفتح مستمعًا واحدًا', S.attaches === 2, S.attaches);
  }
  /* ===== أخطاء الاتصال: لا تعليق، نسخة محفوظة، إعادة محاولة تلقائية ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES });
    const first = page(S); first.AD.courses.subscribe(() => { }); await sleep(80);
    S.failNext = 'unavailable';
    const second = page(S, first.ls); const got = [];
    second.AD.courses.subscribe(p => got.push({ ok: p.ok, live: p.live, n: p.data && p.data.length, state: p.state }));
    await sleep(40);
    t('عند فشل الاتصال تبقى الكورسات ظاهرة من الكاش مع تنبيه (لا تعليق)', got.some(g => g.n === 2 && g.ok === false && g.state === 'error'), got);
    await sleep(300);
    const last = got[got.length - 1];
    t('إعادة المحاولة التلقائية تنجح وتعود الحالة سليمة بلا تدخل', last.ok === true && last.live === true && last.n === 2, last);
  }
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES });
    const first = page(S); first.AD.courses.subscribe(() => { }); await sleep(80);
    S.online = false; const second = page(S, first.ls); second.ctx.navigator.onLine = false; const got = [];
    second.AD.courses.subscribe(p => got.push(p));
    await sleep(500);
    t('بدون إنترنت: لقطة فارغة من الكاش لا تمسح الكورسات المحفوظة', got.length >= 1 && got.every(g => g.data && g.data.length === 2) && JSON.parse(second.ls.getItem('alamin_courses')).length === 2);
    t('بدون إنترنت: تُعرض النسخة المحفوظة مع تنبيه الانقطاع', got[got.length - 1].ok === false && got[got.length - 1].live === false);
    S.online = true; second.ctx.navigator.onLine = true; second.ctx.fire('online'); await sleep(120);
    t('عند عودة الإنترنت يعود التزامن فورًا', got[got.length - 1].live === true && got[got.length - 1].ok === true);
  }
  {
    const S = makeServer(); const { AD } = page(S); let p0;
    AD.courses.subscribe(p => { p0 = p; }); await sleep(400); // مستند الكورسات غير موجود فعليًا على الخادم
    t('مستند كورسات غير موجود فعليًا (من الخادم) = قائمة فارغة حقيقية وليس خطأ', p0 && p0.live && p0.data.length === 0 && p0.ok);
  }
  {
    const S = makeServer(); S.online = false; const { AD, ctx } = page(S); ctx.navigator.onLine = false; const got = [];
    AD.courses.subscribe(p => got.push(p)); await sleep(500);
    t('أول زيارة بلا إنترنت ولا كاش: حالة صريحة (بطيء/خطأ) بدل الهيكل التحميلي للأبد', got.length >= 1 && !got[got.length - 1].hasData && (got[got.length - 1].state === 'slow' || got[got.length - 1].state === 'error') && got[got.length - 1].ok === false, got.map(g => g.state));
  }
  /* ===== once(): لا تتعلّق ولا ترفض ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES }); S.latency = 40; const { AD } = page(S);
    const r = await AD.courses.once({ timeout: 2000 });
    t('once() تنتظر الرد المؤكَّد وتُرجع البيانات', r.live && r.data.length === 2 && S.reads === 1);
    const S2 = makeServer(); S2.online = false; const q = page(S2); const t0 = Date.now(); const r2 = await q.AD.courses.once({ timeout: 150 });
    t('once() عند الانقطاع تنتهي بالمهلة ولا ترفض', !r2.live && Date.now() - t0 < 1000);
  }
  /* ===== المحاضرات: مستند واحد بدل N قراءة ===== */
  {
    const S = makeServer(); const lec = n => ({ id: 'LEC_' + n, title: 'م' + n, url: 'https://youtu.be/aaaaaaaaaaa', grade: '1', createdAt: '2026-10-0' + n });
    [1, 2, 3, 4, 5].forEach(n => S.seed('lectures', 'LEC_' + n, lec(n)));
    S.seed('platform_data', 'lectures_list', { lectures: [1, 2, 3, 4, 5].map(lec), updatedAt: 'x' });
    const { AD } = page(S); const got = [];
    AD.lectures.subscribe(p => got.push(p)); await sleep(80);
    t('5 محاضرات = قراءة واحدة (مستند lectures_list) وليس 5 ولا 10', got.length === 1 && got[0].data.length === 5 && S.reads === 1, { n: got.length, r: S.reads });
    S.set('platform_data', 'lectures_list', { lectures: [1, 2, 3, 4, 5, 6].map(lec), updatedAt: 'y' }); await sleep(60);
    t('محاضرة جديدة تظهر لحظيًا بقراءة واحدة', got.length === 2 && got[1].data.length === 6 && S.reads === 2, { n: got.length, r: S.reads });
  }
  {
    const S = makeServer(); const lec = n => ({ id: 'LEC_' + n, title: 'م' + n, url: 'https://youtu.be/aaaaaaaaaaa', grade: '1' });
    [1, 2, 3].forEach(n => S.seed('lectures', 'LEC_' + n, lec(n)));
    const { AD } = page(S); const got = [];
    AD.lectures.subscribe(p => got.push(p)); await sleep(80);
    t('لو lectures_list غير موجود نرجع لمجموعة lectures كما كان (لا فقدان محاضرات)', got.length >= 1 && got[got.length - 1].data.length === 3 && got[got.length - 1].live);
    S.set('platform_data', 'lectures_list', { lectures: [1, 2, 3].map(lec) }); await sleep(80);
    const r0 = S.reads; S.set('lectures', 'LEC_9', lec(9)); await sleep(60);
    t('بعد ظهور lectures_list يُغلق المستمع الاحتياطي (لا مستمعين زائدين)', S.reads === r0 && AD.stats().activeListeners === 1, { dr: S.reads - r0, ls: AD.stats().activeListeners });
  }
  {
    const S = makeServer(); const { AD } = page(S); const got = [];
    S.seed('platform_data', 'lectures_list', { lectures: [], updatedAt: 'x' });
    AD.lectures.subscribe(p => got.push(p)); await sleep(100);
    t('لا محاضرات إطلاقًا = قائمة فارغة حقيقية بحد أدنى من القراءات', got.length >= 1 && got[got.length - 1].data.length === 0 && got[got.length - 1].live && S.reads <= 2, S.reads);
  }
  /* ===== فهرس الاختبارات + أسئلة كاملة بنسخة مرتبطة بـ updatedAt ===== */
  {
    const S = makeServer(); const q1 = quiz('1'), q2 = quiz('2', { isPublished: false });
    S.seed('quizzes', '1', q1); S.seed('quizzes', '2', q2); S.seed('platform_data', 'quizzes_index', indexOf([q1, q2]));
    const { AD } = page(S); const got = [];
    AD.quizzes.subscribe(p => got.push(p)); await sleep(80);
    t('فهرس الاختبارات = قراءة واحدة مهما كان عدد الاختبارات', got.length === 1 && got[0].data.via === 'index' && got[0].data.items.length === 2 && S.reads === 1, S.reads);
    t('الفهرس لا يحمل الأسئلة (خفيف) لكنه يحمل عدد الأسئلة', !('questionsList' in got[0].data.items[0]) && got[0].data.items[0].qn === 2);
    const full = await AD.quizzes.getFull('1', { fresh: true });
    t('فتح اختبار = قراءة مستند واحد فقط', full.questionsList.length === 2 && S.reads === 2, S.reads);
    await AD.quizzes.getFull('1', { fresh: true }); await AD.quizzes.getFull('1');
    t('إعادة فتح/مراجعة نفس الاختبار بلا تعديل = صفر قراءات (نسخة مطابقة لـ updatedAt)', S.reads === 2, S.reads);
    const q1b = quiz('1', { title: 'معدّل', updatedAt: '2026-10-05T10:00:00Z' }); S.set('quizzes', '1', q1b); S.set('platform_data', 'quizzes_index', indexOf([q1b, q2])); await sleep(80);
    const full2 = await AD.quizzes.getFull('1', { fresh: true });
    t('تعديل الاختبار من الداشبورد: الفهرس يتحدّث لحظيًا وتُجلب النسخة الجديدة فقط', got.length === 2 && full2.title === 'معدّل', got.length);
    t('ما يخصّ اختبارًا غير مفهرس لا يُقرأ: اختبار غير موجود بالفهرس الحي = null بلا قراءة', (() => { const r = S.reads; const m = AD.quizzes.metaOf('999'); return m === null && S.reads === r; })());
  }
  {
    const S = makeServer(); const q1 = quiz('1'), q2 = quiz('2', { isPublished: false }), q3 = quiz('3');
    S.seed('quizzes', '1', q1); S.seed('quizzes', '2', q2); S.seed('quizzes', '3', q3);
    const { AD } = page(S); const got = [];
    AD.quizzes.subscribe(p => got.push(p)); await sleep(80);
    t('قبل أن تنشئ الداشبورد الفهرس: الرجوع للاختبارات المنشورة فقط كما كان', got.length === 1 && got[0].data.via === 'query' && got[0].data.items.map(i => i.id).sort().join() === '1,3');
    const r = S.reads; const full = await AD.quizzes.getFull('1', { fresh: true });
    t('في هذا الوضع الأسئلة التي نزلت مع الاستعلام لا تُقرأ مرة ثانية', full.questionsList.length === 2 && S.reads === r, S.reads - r);
    const rr = S.reads; await AD.quizzes.ensureMeta(['2']); await AD.quizzes.ensureMeta(['2']);
    t('اختبار مربوط بدرس وغير منشور يُقرأ مرة واحدة ثم يُحفظ', AD.quizzes.metaOf('2') && AD.quizzes.metaOf('2').id === '2' && S.reads - rr === 1, S.reads - rr);
    S.set('quizzes', '4', quiz('4')); await sleep(60);
    t('اختبار جديد منشور يصل لحظيًا في وضع الاستعلام أيضًا', got[got.length - 1].data.items.some(i => i.id === '4'));
  }
  {
    const S = makeServer(); const { AD } = page(S); S.seed('platform_data', 'quizzes_index', { items: [], updatedAt: 'x' });
    AD.quizzes.subscribe(() => { }); await sleep(80); const r = S.reads;
    const res = await AD.quizzes.ensureMeta(['77']);
    t('الفهرس الحي كامل: روابط دروس لاختبارات محذوفة لا تسبب قراءات', S.reads === r && AD.quizzes.metaOf('77') === null, S.reads - r);
  }
  {
    const S = makeServer(); const q1 = quiz('1'); S.seed('quizzes', '1', q1); S.seed('platform_data', 'quizzes_index', indexOf([q1]));
    const a = page(S); a.AD.quizzes.subscribe(() => { }); await sleep(80); await a.AD.quizzes.getFull('1', { fresh: true });
    const r0 = S.reads; const b = page(S, a.ls); b.AD.quizzes.subscribe(() => { }); await sleep(80);
    const full = await b.AD.quizzes.getFull('1', { fresh: true });
    t('زيارة عائدة: الاختبار نفسه يُفتح من نسخة الجهاز (قراءة الفهرس فقط)', full.questionsList.length === 2 && S.reads - r0 === 1, S.reads - r0);
  }
  /* ===== نتائج الطالب ===== */
  {
    const S = makeServer(); const att = (qid, extra) => Object.assign({ studentId: 'web-1', quizId: qid, status: 'submitted', score: 5, totalPoints: 10, percentage: 50, passed: true }, extra || {});
    S.seed('quiz_attempts', 'ATT_web-1_1', att('1')); S.seed('quiz_attempts', 'ATT_web-1_2', att('2', { status: 'absent' })); S.seed('quiz_attempts', 'ATT_web-9_1', att('1', { studentId: 'web-9' }));
    const a = page(S); const got = [];
    a.AD.attempts('web-1').subscribe(p => got.push(p)); await sleep(80);
    t('نتائج الطالب فقط (استعلام بمعرّفه) بقراءة لكل نتيجة وبدون نتائج غيره', got.length === 1 && Object.keys(got[0].data).sort().join() === '1,2' && S.reads === 2, S.reads);
    S.set('quiz_attempts', 'ATT_web-1_3', att('3')); /* الحفظ على الخادم يسبق patch المحلي كما في test.html */ a.AD.attempts('web-1').patch('3', att('3')); await sleep(5);
    t('تسليم اختبار يظهر فورًا في كل الصفحات (patch محلي)', got.length === 2 && got[1].data['3'].quizId === '3');
    S.del('quiz_attempts', 'ATT_web-1_1'); await sleep(60);
    t('«تصفير وإعادة» من الداشبورد يصل للطالب لحظيًا', got[got.length - 1].data['1'] === undefined);
    const b = page(S, a.ls); const g2 = []; b.AD.attempts('web-1').subscribe(p => g2.push(p)); await sleep(5);
    t('نتائج الطالب تظهر فورًا من الكاش في الصفحة التالية', g2.length === 1 && !g2[0].live && g2[0].ok && Object.keys(g2[0].data).length >= 2);
  }
  /* ===== اشتراكات الطالب ===== */
  {
    const S = makeServer(); S.seed('students', '5', { name: 'x', enrolledCourses: ['c1'] });
    const { AD } = page(S); const got = [];
    AD.student('students', '5').subscribe(p => got.push(p)); await sleep(60);
    t('اشتراكات الطالب بقراءة واحدة', got.length === 1 && got[0].data.enrolledCourses[0] === 'c1' && S.reads === 1);
    S.set('students', '5', { enrolledCourses: ['c1', 'c2'] }, true); await sleep(50);
    t('تفعيل كود اشتراك جديد ينعكس لحظيًا في «كورساتي»', got.length === 2 && got[1].data.enrolledCourses.length === 2);
  }
  /* ===== تنظيف عند مغادرة الصفحة ===== */
  {
    const S = makeServer(); S.seed('platform_data', 'courses_list', { items: COURSES }); const { AD, ctx } = page(S);
    AD.courses.subscribe(() => { }); await sleep(60); ctx.fire('pagehide');
    t('عند مغادرة الصفحة تُغلق كل المستمعات', AD.stats().activeListeners === 0);
    ctx.fire('pageshow', { persisted: true }); await sleep(60);
    t('الرجوع من الكاش الخلفي (bfcache) يعيد الاتصال', AD.stats().activeListeners === 1);
  }
  /* ===== فحوصات ثابتة لربط الصفحات (تمنع الرجوع للقراءات المكررة) ===== */
  {
    const read = f => fs.readFileSync(path.join(__dirname, f), 'utf8');
    const pages = ['courses.html', 'course.html', 'exam.html', 'test.html', 'profile.html', 'lectures.html'];
    const bad = pages.filter(pg => { const h = read(pg); const a = h.indexOf('firebase-config.js'), b = h.indexOf('platform-data.js'), c = h.indexOf('student-courses.js'); return !(a > -1 && b > a && (c === -1 || b < c)) || (h.match(/<script src="platform-data\.js">/g) || []).length !== 1; });
    t('كل صفحات الطالب تحمّل platform-data.js مباشرة بعد firebase-config.js وقبل أي كود يقرأ البيانات' + (bad.length ? ' (' + bad.join(', ') + ')' : ''), !bad.length);
    t('لوحة التحكم لا تحمّل طبقة الطالب ولا تفعّل الكاش الدائم (حمايتها من الكتابة فوق بيانات قديمة تعتمد على فشل القراءة بلا اتصال)', !/platform-data\.js/.test(read('dashboard.html')) && !/enablePersistence/.test(read('dashboard.html')) && !/enablePersistence/.test(read('firebase-config.js')));
    const dup = ['student-courses.js', 'lectures.js', 'exams.js', 'course-lessons.js'].filter(f => /source:\s*'server'/.test(read(f)));
    t('لا قراءات get({source:server}) تسبق المستمعات في ملفات الطالب' + (dup.length ? ' (' + dup.join(', ') + ')' : ''), !dup.length);
    t('تلميحات preconnect لتسريع أول اتصال بفايرستور في صفحات الطالب', pages.every(pg => /rel="preconnect" href="https:\/\/firestore\.googleapis\.com"/.test(read(pg))));
    t('server.js يخدم platform-data.js ضمن القائمة البيضاء', /'platform-data\.js'/.test(read('server.js')));
    t('الداشبورد تُحدّث فهرس الاختبارات بعد كل حفظ/نسخ/حذف/نشر/استيراد', (read('dashboard.html').match(/AlaminQuizIndex\.schedule\(\)/g) || []).length >= 5 && /AlaminQuizIndex\.reconcile\(/.test(read('dashboard.html')));
  }
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
