// ============================================================
//  firestore-read-cache.js
//  طبقة تخزين مؤقت (Cache) لتقليل عمليات القراءة من Firebase
//  منصة الأمين
//
//  الفكرة:
//   - قبل أي قراءة متكررة لنفس البيانات (كل الطلاب، كل الاختبارات،
//     قائمة الكورسات...) نتحقق: هل قرأناها قبل شوية؟ لو آه، نستخدم
//     النسخة المحفوظة بدل ما نروح تاني لـ Firebase.
//   - الكاش يتشارك بين الصفحات المختلفة (index/lessons/profile/dashboard)
//     عن طريق sessionStorage، وبين الاستدعاءات المتتالية في نفس الصفحة
//     عن طريق الذاكرة (Map).
//   - لا يغيّر أي بيانات أو منطق — فقط يمنع تكرار نفس القراءة خلال
//     مدة زمنية قصيرة (TTL) قابلة للتخصيص لكل نوع بيانات.
//   - في حالة استدعاء نفس القراءة أكتر من مرة في نفس اللحظة (مثلاً
//     نداءين متوازيين)، بيتم تنفيذ قراءة واحدة فعلية فقط ومشاركة
//     نتيجتها بين النداءين (Request de-duplication).
//
//  الاستخدام:
//    const data = await FBCache.cachedRead('students_full', 3*60*1000, async () => {
//      const snap = await window.db.collection('students').get();
//      return snap.docs.map(d => ({ id: d.id, data: d.data() || {} }));
//    });
//
//    // لإجبار قراءة جديدة (تجاهل الكاش) مرة واحدة:
//    await FBCache.cachedRead('students_full', ttl, fetcher, { force: true });
//
//    // لإفراغ الكاش يدويًا بعد عملية كتابة (Add/Update/Delete):
//    FBCache.invalidate('students_full');
// ============================================================

(function () {
  'use strict';

  const MEM = new Map();          // key -> { data, ts, promise }
  const SESSION_PREFIX = 'alamin_fbcache_';

  function readSession(key) {
    try {
      const raw = sessionStorage.getItem(SESSION_PREFIX + key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.ts !== 'number') return null;
      return parsed;
    } catch (e) { return null; }
  }

  function writeSession(key, entry) {
    try {
      sessionStorage.setItem(SESSION_PREFIX + key, JSON.stringify({ data: entry.data, ts: entry.ts }));
    } catch (e) { /* sessionStorage ممكن تكون ممتلئة أو غير متاحة — تجاهل بأمان */ }
  }

  function removeSession(key) {
    try { sessionStorage.removeItem(SESSION_PREFIX + key); } catch (e) {}
  }

  /**
   * يقرأ من الكاش لو موجود وحديث (خلال ttlMs)، وإلا ينفّذ fetcher()
   * مرة واحدة فقط ويخزّن نتيجته.
   * @param {string} key - معرف فريد لنوع البيانات (مثال: 'students_full')
   * @param {number} ttlMs - مدة صلاحية الكاش بالميلي ثانية
   * @param {Function} fetcher - async () => data  (يُنفَّذ فقط عند الحاجة)
   * @param {{force?: boolean}} opts - force=true يتجاهل الكاش ويقرأ من جديد
   */
  async function cachedRead(key, ttlMs, fetcher, opts) {
    const force = !!(opts && opts.force);
    const now = Date.now();

    if (!force) {
      const mem = MEM.get(key);

      // نتيجة محفوظة في الذاكرة وسليمة
      if (mem && mem.data !== undefined && (now - mem.ts) < ttlMs) {
        return mem.data;
      }
      // طلب شغّال بالفعل لنفس المفتاح — استنى نتيجته بدل تكرار القراءة
      if (mem && mem.promise) {
        return mem.promise;
      }
      // نتيجة محفوظة في sessionStorage من صفحة تانية في نفس الجلسة
      const stored = readSession(key);
      if (stored && (now - stored.ts) < ttlMs) {
        MEM.set(key, stored);
        return stored.data;
      }
    }

    const promise = Promise.resolve()
      .then(fetcher)
      .then((data) => {
        const entry = { data, ts: Date.now() };
        MEM.set(key, entry);
        writeSession(key, entry);
        return data;
      })
      .catch((err) => {
        // فشل القراءة: امسح أي promise معلّق عشان المحاولة الجاية تقدر تعيد المحاولة
        const cur = MEM.get(key);
        if (cur && cur.promise === promise) MEM.delete(key);
        throw err;
      });

    MEM.set(key, { data: (MEM.get(key) || {}).data, ts: (MEM.get(key) || {}).ts || 0, promise });
    return promise;
  }

  function invalidate(key) {
    MEM.delete(key);
    removeSession(key);
  }

  function invalidatePrefix(prefix) {
    Array.from(MEM.keys()).forEach((k) => { if (k.indexOf(prefix) === 0) MEM.delete(k); });
    try {
      Object.keys(sessionStorage).forEach((k) => {
        if (k.indexOf(SESSION_PREFIX + prefix) === 0) sessionStorage.removeItem(k);
      });
    } catch (e) {}
  }

  window.FBCache = { cachedRead, invalidate, invalidatePrefix };
})();
