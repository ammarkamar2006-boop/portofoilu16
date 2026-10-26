/* ============================================================
   quiz-index-sync.js — لوحة التحكم فقط
   يحدّث مستند «فهرس الاختبارات» platform_data/quizzes_index الذي تقرؤه صفحات الطالب (platform-data.js).

   لماذا؟ صفحات الطالب (الاختبارات، الملف الشخصي، دروس الكورس) كانت تنزّل كل الاختبارات المنشورة بأسئلتها كاملة مع كل زيارة
   (قراءة لكل اختبار × كل صفحة × كل طالب). الفهرس مستند واحد خفيف (العنوان/الصف/الوقت/الدرجات/عدد الأسئلة/حالة النشر/updatedAt)،
   فيقرأه الطالب بقراءة واحدة ويتابعه لحظيًا، ولا يقرأ أسئلة اختبار إلا عند فتحه.

   - لا يغيّر أي بيانات اختبارات ولا منطق الداشبورد: هو مجرد نسخة مشتقة تُعاد بناؤها من مجموعة quizzes الحقيقية (قراءة من الخادم).
   - schedule(): يُستدعى بعد كل حفظ/نسخ/حذف/نشر/إخفاء/استيراد (مؤجَّل 0.7 ثانية لتجميع العمليات المتتالية، ومع إعادة محاولة).
   - reconcile(list): عند فتح الداشبورد يقارن الفهرس بالاختبارات الحقيقية ويصلحه تلقائيًا لو اختلف أو لم يوجد
     (فيُنشأ الفهرس لأول مرة بمجرد فتح الداشبورد بعد تركيب هذا التحديث).
   - لو فشلت الكتابة (قواعد Firestore مثلًا) تظهر رسالة للأدمن، وتبقى صفحات الطالب تعمل بالمصدر القديم (الاختبارات المنشورة)
     ما دام الفهرس غير موجود.
   ============================================================ */
(function (w) {
  'use strict';
  if (w.AlaminQuizIndex) return;

  var timer = null, running = false, again = false, tries = 0, banner = null;

  function numOrNull(v) { var n = parseFloat(v); return isFinite(n) ? n : null; }
  function item(id, q) {
    q = q || {};
    var list = Array.isArray(q.questionsList) ? q.questionsList : null;
    return {
      id: String(id),
      title: String(q.title || ''),
      grade: q.grade == null ? '' : q.grade,
      subject: String(q.subject || ''),
      time: numOrNull(q.time),
      questionsCount: numOrNull(q.questionsCount),
      qn: list ? list.length : (numOrNull(q.questionsCount) || 0),
      totalPoints: numOrNull(q.totalPoints),
      averageGrade: numOrNull(q.averageGrade),
      passingGrade: numOrNull(q.passingGrade),
      isPublished: q.isPublished === true,
      createdAt: String(q.createdAt || ''),
      updatedAt: String(q.updatedAt || '')
    };
  }
  function build(entries) {
    return entries.map(function (e) { return item(e.id, e.data); })
      .sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  }
  var KEYS = ['id', 'title', 'grade', 'subject', 'time', 'questionsCount', 'qn', 'totalPoints', 'averageGrade', 'passingGrade', 'isPublished', 'createdAt', 'updatedAt'];
  function pick(x) { var o = {}; KEYS.forEach(function (k) { o[k] = x && x[k] !== undefined ? x[k] : null; }); o.id = String(o.id); return o; }
  function byId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function ref() { return w.db.collection('platform_data').doc('quizzes_index'); }

  function notify(msg) {
    try {
      if (!banner) {
        banner = document.createElement('div');
        banner.setAttribute('role', 'alert');
        banner.style.cssText = 'position:fixed;bottom:16px;left:16px;right:16px;max-width:520px;margin:0 auto;z-index:99999;background:#7a1f1f;color:#fff;padding:12px 16px;border-radius:10px;font:600 14px/1.6 Cairo,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);direction:rtl;text-align:right';
        document.body.appendChild(banner);
      }
      banner.textContent = msg; banner.hidden = false;
      clearTimeout(banner._t); banner._t = setTimeout(function () { banner.hidden = true; }, 15000);
    } catch (e) { }
  }

  // إعادة بناء الفهرس من مجموعة quizzes الحقيقية (قراءة من الخادم — عملية أدمن نادرة)
  async function rebuild() {
    if (!w.db) return;
    var snap = await w.db.collection('quizzes').get({ source: 'server' });
    var items = build(snap.docs.map(function (d) { return { id: d.id, data: d.data() }; }));
    await ref().set({ items: items, count: items.length, updatedAt: new Date().toISOString() });
    if (banner) banner.hidden = true;
  }

  async function run() {
    if (running) { again = true; return; }
    running = true;
    try { await rebuild(); tries = 0; }
    catch (e) {
      console.warn('[quiz-index] rebuild failed', e);
      if (++tries <= 3) setTimeout(schedule, 2000 * tries);
      else {
        tries = 0;
        notify('تم حفظ الاختبار، لكن تعذّر تحديث فهرس الاختبارات لطلاب المنصة. تأكد من الاتصال وأعد المحاولة (احفظ أي اختبار أو أعد تحميل الصفحة).');
      }
    }
    running = false;
    if (again) { again = false; schedule(); }
  }

  function schedule() { clearTimeout(timer); timer = setTimeout(run, 700); }

  // يقارن الفهرس الحالي بالاختبارات الحقيقية ويُصلحه عند الاختلاف (قراءة مستند واحد)
  async function reconcile(list) {
    if (!w.db || !Array.isArray(list)) return;
    try {
      var snap = await ref().get({ source: 'server' });
      var cur = snap.exists && snap.data() && Array.isArray(snap.data().items) ? snap.data().items : null;
      var want = build(list.filter(function (q) { return q && q.id != null; }).map(function (q) { return { id: q.id, data: q }; }));
      if (!cur || stable(cur.map(pick).sort(byId)) !== stable(want.map(pick).sort(byId))) schedule();
    } catch (e) { console.warn('[quiz-index] reconcile failed', e); }
  }

  w.AlaminQuizIndex = { schedule: schedule, reconcile: reconcile, _build: build, _item: item };
})(window);
