// ============================================================
//  lesson-progress.js
//  نظام متابعة مشاهدة الدروس — منصة الأمين
//
//  المصدر الرئيسي والوحيد لحالة المشاهدة هو Firestore (collection:
//  "lessonProgress")، ولا يُعتمد على LocalStorage لحفظ الحالة —
//  LocalStorage هنا يُستخدم فقط كتلميح فوري للاستئناف قبل وصول رد
//  Firestore، ثم يُستبدل بقيمة Firestore الحقيقية فور وصولها.
//
//  كل مشاهدة (طالب + كورس + درس + مقطع فيديو) تُخزَّن في مستند واحد
//  ثابت المعرّف حتى تتحدّث بدل ما تتكرر، وأي جهاز يفتح نفس الفيديو
//  يقرأ ويكتب لنفس المستند.
// ============================================================

(function () {
  'use strict';

  const COLLECTION = 'lessonProgress';
  const TICK_THROTTLE_MS = 8000;       // أقصى تردد للكتابة لكل مقطع فيديو
  const COMPLETE_PCT = 90;             // % الاعتبار "تمت المشاهدة"

  const lastWriteAt = {};   // key -> timestamp آخر كتابة فعلية
  const memCache = {};      // key -> آخر نسخة معروفة من المستند (لتقليل القراءات)

  function safePart(v) {
    return String(v == null ? '' : v).replace(/[^a-zA-Z0-9\u0600-\u06FF_\-]/g, '_').slice(0, 80);
  }

  function docKey(studentId, courseId, lessonId, segmentId) {
    return `${safePart(studentId)}__${safePart(courseId)}__${safePart(lessonId)}__${safePart(segmentId)}`;
  }

  function nowIso() { return new Date().toISOString(); }

  function baseFields(ctx) {
    return {
      studentId: String(ctx.studentId || ''),
      studentName: ctx.studentName || '',
      grade: ctx.grade || '',
      groupId: ctx.groupId || '',
      courseId: String(ctx.courseId || ''),
      courseTitle: ctx.courseTitle || '',
      lessonId: String(ctx.lessonId || ''),
      lessonTitle: ctx.lessonTitle || '',
      segmentId: String(ctx.segmentId || ''),
      segmentTitle: ctx.segmentTitle || ''
    };
  }

  function validCtx(ctx) {
    return ctx && ctx.studentId && ctx.courseId && ctx.lessonId && ctx.segmentId;
  }

  /**
   * يُستدعى عند ضغط "ابدأ الآن" أو فتح أي فيديو.
   * يقرأ المستند الحالي (لو موجود) ويعيد آخر نقطة توقف عندها الطالب،
   * ويُنشئ/يُحدّث حالة "قيد المشاهدة" فوراً في Firestore.
   * يُرجع بيانات المستند (بما فيها lastPosition) لاستخدامها في استئناف التشغيل.
   */
  async function startWatch(ctx) {
    if (!validCtx(ctx)) return null;
    if (!window.db) return null; // بدون Firebase لا يوجد تتبّع رسمي
    const key = docKey(ctx.studentId, ctx.courseId, ctx.lessonId, ctx.segmentId);
    const ref = window.db.collection(COLLECTION).doc(key);
    try {
      const snap = await ref.get();
      const existing = snap.exists ? snap.data() : null;
      const payload = Object.assign(baseFields(ctx), {
        status: (existing && existing.status === 'completed') ? 'completed' : 'in_progress',
        percent: existing ? (existing.percent || 0) : 0,
        lastPosition: existing ? (existing.lastPosition || 0) : 0,
        duration: existing ? (existing.duration || 0) : 0,
        watchCount: (existing && existing.watchCount ? existing.watchCount : 0) + 1,
        updatedAt: nowIso()
      });
      if (!existing) payload.startedAt = nowIso();
      await ref.set(payload, { merge: true });
      const merged = Object.assign({}, existing, payload);
      memCache[key] = merged;
      return merged;
    } catch (e) {
      console.warn('LessonProgress.startWatch failed:', e);
      return null;
    }
  }

  /**
   * يُستدعى دورياً أثناء تشغيل الفيديو (مرة كل بضع ثواني بحد أقصى) لتحديث:
   * آخر نقطة وصول إليها، ونسبة المشاهدة (أعلى قيمة وصل إليها الطالب فعلياً)،
   * وحالة الدرس (قيد المشاهدة / تمت المشاهدة).
   */
  function tick(ctx, currentSeconds, durationSeconds) {
    if (!validCtx(ctx)) return;
    if (!window.db) return;
    if (!currentSeconds || currentSeconds < 3) return;
    const key = docKey(ctx.studentId, ctx.courseId, ctx.lessonId, ctx.segmentId);
    const t = Date.now();
    if (lastWriteAt[key] && (t - lastWriteAt[key]) < TICK_THROTTLE_MS) return;
    lastWriteAt[key] = t;

    const prev = memCache[key] || {};
    const dur = durationSeconds || prev.duration || 0;
    const pctNow = dur ? Math.min(100, Math.round((currentSeconds / dur) * 100)) : (prev.percent || 0);
    const bestPct = Math.max(prev.percent || 0, pctNow);
    const status = bestPct >= COMPLETE_PCT ? 'completed' : 'in_progress';

    const payload = Object.assign(baseFields(ctx), {
      status,
      percent: bestPct,
      lastPosition: Math.round(currentSeconds),
      duration: Math.round(dur),
      updatedAt: nowIso()
    });
    if (status === 'completed' && prev.status !== 'completed') payload.completedAt = nowIso();

    memCache[key] = Object.assign({}, prev, payload);
    window.db.collection(COLLECTION).doc(key).set(payload, { merge: true })
      .catch(e => console.warn('LessonProgress.tick failed:', e));
  }

  window.LessonProgress = { startWatch, tick, docKey, COLLECTION };
})();
