/* ============================================================
   platform-data.js — طبقة البيانات المشتركة لواجهة الطالب (window.AlaminData)
   منصة مستر أمين الغازي

   الهدف: تحميل سريع + تزامن لحظي + أقل عدد ممكن من قراءات Firebase.

   كيف تعمل:
   1) مصدر واحد لكل نوع بيانات (Store) داخل كل صفحة. أي عدد من الأكواد في الصفحة يشترك في نفس المصدر
      ويتشارك مستمعًا (onSnapshot) واحدًا فقط — لا قراءة مكرّرة ولا مستمعين زائدين.
   2) عرض فوري من نسخة الجهاز (localStorage) ثم مطابقتها مع الخادم لحظيًا (stale-while-revalidate).
      لا توجد بعد الآن قراءة get() ثم onSnapshot لنفس البيانات (كانت تُحسب مرتين).
   3) المصادر المجمَّعة: كل مصدر قدر الإمكان في مستند واحد = قراءة واحدة بدل N قراءة:
        • الكورسات   ← platform_data/courses_list            (مستند واحد)
        • المحاضرات  ← platform_data/lectures_list           (مستند واحد؛ احتياطيًا مجموعة lectures)
        • الاختبارات ← platform_data/quizzes_index           (فهرس خفيف تكتبه لوحة التحكم؛ احتياطيًا استعلام quizzes المنشورة)
      وأسئلة الاختبار الكاملة (quizzes/<id>) تُقرأ فقط عند فتح اختبار أو مراجعة نتيجته، وتُحفظ بنسخة مرتبطة بـ updatedAt.
   4) كاش Firestore الدائم (IndexedDB) يُفعَّل في صفحات الطالب فقط، فيستأنف المستمع بالتغييرات فقط بدل إعادة تنزيل كل شيء،
      ويتشارك بين تبويبات المتصفح. لو فشل التفعيل (متصفح خاص مثلًا) تعمل المنصة بنفس الكفاءة تقريبًا عبر كاش الجهاز.
   5) الموثوقية: لا يتعطّل العرض عند بطء/انقطاع الاتصال — تُعرض آخر نسخة محفوظة مع تنبيه، وتتم إعادة المحاولة تلقائيًا
      (تراجع تدريجي) وعند عودة الاتصال. لقطة فارغة قادمة من الكاش لا تُعتمد أبدًا كحقيقة (لا تمسح بيانات سليمة).
   6) لوحة التحكم لا تُحمِّل هذا الملف ولا تُفعِّل الكاش الدائم (حتى لا تتأثر حمايتها من الكتابة فوق بيانات قديمة).
   ============================================================ */
(function (w) {
  'use strict';
  if (w.AlaminData) return;

  var CFG = {
    GRACE_MS: 3000,                 // إبقاء المستمع شغّالًا بعد خروج آخر مشترك (تنقّل سريع/إعادة اشتراك بلا قراءة جديدة)
    SLOW_MS: 8000,                  // بعدها نعتبر الاتصال بطيئًا ونعرض ما لدينا مع تنبيه
    FRESH_MAX_AGE: 7 * 864e5,       // أقصى عمر لنسخة الجهاز لتُعرض فورًا قبل ردّ الخادم
    RETRY: [1500, 4000, 10000, 30000, 60000],
    MAX_RETRIES: 6,                 // بعدها ننتظر عودة الاتصال/ظهور الصفحة بدل الاستمرار بالمحاولة
    QUIZ_FRESH_MS: 5 * 60e3,        // عمر نسخة أسئلة اختبار نثق بها بدون تأكيد من الفهرس اللحظي
    META_TTL_MS: 6 * 3600e3,        // عمر بيانات اختبار مفرد (غير موجود بالفهرس)
    META_NEG_TTL_MS: 10 * 60e3,     // عمر نتيجة «غير موجود»
    QUIZ_LS_MAX: 15,                // أقصى عدد نسخ أسئلة محفوظة على الجهاز
    QUIZ_LS_BYTES: 900000           // لا نحفظ اختبارًا أكبر من هذا الحجم في localStorage
  };

  /* ---------- أدوات ---------- */
  function now() { return Date.now(); }
  function lsGet(k) { try { var v = w.localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }
  function lsSet(k, v) { try { w.localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { w.localStorage.removeItem(k); } catch (e) { } }
  function isArr(a) { return Array.isArray(a); }
  // تمثيل نصي مستقر (ترتيب المفاتيح ثابت) لمقارنة البيانات: فايرستور يرجّع الحقول بترتيب مختلف عن الإدخال المحلي
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (isArr(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function offline() { return typeof w.navigator !== 'undefined' && w.navigator.onLine === false; }

  var stats = { listens: 0, unlistens: 0, gets: 0, serverDocs: 0, errors: 0, emits: 0, persistence: 'pending' };
  function dbg() { try { if (w.localStorage.getItem('alamin_debug') === '1' && w.console) w.console.info.apply(w.console, ['[AlaminData]'].concat([].slice.call(arguments))); } catch (e) { } }

  /* ---------- قاعدة البيانات + الكاش الدائم (لصفحات الطالب فقط) ---------- */
  function initPersistence(db) {
    if (!db || db.__alaminPersist) return;
    db.__alaminPersist = 1;
    try {
      if (typeof db.enablePersistence === 'function') {
        db.enablePersistence({ synchronizeTabs: true }).then(
          function () { stats.persistence = 'on'; dbg('persistence on'); },
          function (e) { stats.persistence = 'off:' + (e && e.code || 'error'); dbg('persistence off', e && e.code); }
        );
      } else stats.persistence = 'off:unsupported';
    } catch (e) { stats.persistence = 'off:error'; }
  }
  function getDb(ms) {
    return new Promise(function (res) {
      if (w.db) { initPersistence(w.db); return res(w.db); }
      var t0 = now(), t = setInterval(function () {
        if (w.db || now() - t0 > ms) { clearInterval(t); if (w.db) initPersistence(w.db); res(w.db || null); }
      }, 80);
    });
  }
  initPersistence(w.db); // لازم قبل أي استخدام آخر لقاعدة البيانات — هذا الملف يُحمَّل مباشرة بعد firebase-config.js

  /* ============================================================
     Store: مصدر بيانات واحد مشترك (مستمع واحد + كاش + إعادة محاولة)
     def = { key, cacheRead() -> {data, ts}|null, cacheWrite(data, ts), attach(db, h) -> unsubscribe }
     attach يستدعي h.next({data, fromCache, count, skip}) أو h.error(err)
     ============================================================ */
  var ALL = [];
  function Store(def) {
    this.def = def; this.data = undefined; this.fallback = undefined; this.sig = null; this.version = 0;
    this.live = false; this.state = 'idle'; this.err = null; this.slow = false;
    this.subs = []; this.unsub = null; this.attaching = false; this.primed = false;
    this.attempt = 0; this.retryT = null; this.slowT = null; this.graceT = null; this.liveWaiters = [];
    ALL.push(this);
  }
  Store.prototype._prime = function () {
    if (this.primed) return; this.primed = true;
    var c = null; try { c = this.def.cacheRead(); } catch (e) { }
    if (!c || c.data === undefined) return;
    this.fallback = c.data; // نسخة أقدم: تُستخدم فقط عند تعذّر الاتصال (سلوك المنصة السابق)
    if (c.ts && now() - c.ts < CFG.FRESH_MAX_AGE) { this.data = c.data; this.sig = stable(c.data); this.version++; this.state = 'cached'; }
  };
  // ok = لا توجد مشكلة اتصال معروفة (تُعرض النسخة المحفوظة بدون تنبيه أثناء الانتظار القصير لردّ الخادم)
  Store.prototype._ok = function () { return this.live || (this.state !== 'error' && !this.slow && !offline()); };
  Store.prototype._payload = function () {
    return { data: this.data, hasData: this.data !== undefined, live: this.live, ok: this._ok(), state: this.state, error: this.err, version: this.version };
  };
  Store.prototype._deliver = function (entry, force) {
    var k = this.version + ':' + (this._ok() ? 1 : 0) + ':' + (this.state === 'error' ? 1 : 0) + ':' + (this.data !== undefined ? 1 : 0);
    if (!force && entry.k === k) return;
    entry.k = k; stats.emits++;
    try { entry.cb(this._payload()); } catch (e) { if (w.console) w.console.error('[AlaminData] subscriber failed', e); }
  };
  Store.prototype._emit = function () { var s = this.subs.slice(), i; for (i = 0; i < s.length; i++) this._deliver(s[i], false); };

  Store.prototype.subscribe = function (cb) {
    var self = this, entry = { cb: cb, k: null };
    this._prime();
    this.subs.push(entry);
    if (this.graceT) { clearTimeout(this.graceT); this.graceT = null; }
    if (this.data !== undefined || this.state === 'error') Promise.resolve().then(function () { if (self.subs.indexOf(entry) > -1) self._deliver(entry, true); });
    this._ensureAttached();
    var gone = false;
    return function unsubscribe() {
      if (gone) return; gone = true;
      var i = self.subs.indexOf(entry); if (i > -1) self.subs.splice(i, 1);
      if (!self.subs.length && !self.graceT) self.graceT = setTimeout(function () { self.graceT = null; if (!self.subs.length) self._detach(); }, CFG.GRACE_MS);
    };
  };

  Store.prototype._ensureAttached = function () {
    var self = this;
    if (this.unsub || this.attaching || !this.subs.length) return;
    this.attaching = true;
    getDb(6000).then(function (db) {
      self.attaching = false;
      if (!self.subs.length || self.unsub) return;
      if (!db) { self._fail(new Error('no-db')); return; }
      if (self.data === undefined && self.state !== 'error') self.state = 'loading';
      self._armSlow();
      var h = { next: function (r) { self._onNext(r); }, error: function (e) { self._onError(e); } };
      try { stats.listens++; self.unsub = self.def.attach(db, h) || function () { }; dbg('attach', self.def.key); }
      catch (e) { self.unsub = null; self._fail(e); }
    });
  };
  Store.prototype._armSlow = function () {
    var self = this; clearTimeout(this.slowT);
    this.slowT = setTimeout(function () {
      if (self.live) return;
      self.slow = true;
      if (self.data === undefined && self.fallback !== undefined) { self.data = self.fallback; self.sig = stable(self.fallback); self.version++; self.state = 'cached'; }
      else if (self.data === undefined) self.state = 'slow';
      self._emit();
    }, CFG.SLOW_MS);
  };
  Store.prototype._detach = function () {
    clearTimeout(this.slowT); clearTimeout(this.retryT); this.retryT = null;
    if (this.unsub) { try { this.unsub(); } catch (e) { } this.unsub = null; stats.unlistens++; dbg('detach', this.def.key); }
  };
  Store.prototype._accept = function (data, live, count) {
    var sig = stable(data), changed = sig !== this.sig;
    if (changed) { this.data = data; this.sig = sig; this.version++; if (live) stats.serverDocs += (count || 0); }
    if (live) {
      this.live = true; this.slow = false; this.err = null; this.attempt = 0; this.state = 'live';
      clearTimeout(this.slowT);
      try { this.def.cacheWrite(changed ? data : null, now()); } catch (e) { } // البيانات لو تغيّرت، وإلا ختم الوقت فقط
    } else {
      this.live = false;
      if (this.state !== 'error') this.state = this.data === undefined ? 'loading' : 'cached';
    }
    var wt = live ? this.liveWaiters.splice(0) : [], i;
    this._emit();
    for (i = 0; i < wt.length; i++) wt[i]();
  };
  Store.prototype._onNext = function (r) {
    if (!r || r.skip) return;
    this._accept(r.data, !r.fromCache, r.count);
  };
  Store.prototype._onError = function (e) {
    stats.errors++; this.err = e || new Error('unknown'); this.live = false; this.state = 'error';
    if (this.unsub) { try { this.unsub(); } catch (x) { } this.unsub = null; }
    this._fail(this.err);
  };
  Store.prototype._fail = function (e) {
    var self = this; this.err = e; this.state = 'error'; this.live = false; clearTimeout(this.slowT);
    if (this.data === undefined && this.fallback !== undefined) { this.data = this.fallback; this.sig = stable(this.fallback); this.version++; }
    var wt = this.liveWaiters.splice(0), i;
    this._emit(); for (i = 0; i < wt.length; i++) wt[i]();
    if (this.attempt < CFG.MAX_RETRIES && this.subs.length) {
      var d = CFG.RETRY[Math.min(this.attempt, CFG.RETRY.length - 1)]; this.attempt++;
      clearTimeout(this.retryT); this.retryT = setTimeout(function () { self.retryT = null; self._ensureAttached(); }, d);
    }
  };
  // إعادة اتصال فورية (عودة الإنترنت / ظهور الصفحة / الرجوع من bfcache)
  Store.prototype.refresh = function () {
    if (!this.subs.length) return;
    this._detach(); this.attempt = 0; this._ensureAttached();
  };
  // ينتظر أول رد مؤكَّد من الخادم؛ لا يرفض ولا يتعلّق أبدًا (عند المهلة/الخطأ يُرجع ما لدينا مع live=false)
  Store.prototype.once = function (opts) {
    var self = this; opts = opts || {};
    var timeout = opts.timeout != null ? opts.timeout : 9000;
    this._prime();
    return new Promise(function (resolve) {
      if (self.live) return resolve(self._payload());
      var done = false, t = null, un = null;
      function fin() {
        if (done) return; done = true; clearTimeout(t);
        var i = self.liveWaiters.indexOf(fin); if (i > -1) self.liveWaiters.splice(i, 1);
        if (un) un();
        resolve(self._payload());
      }
      t = setTimeout(fin, timeout);
      self.liveWaiters.push(fin);
      un = self.subscribe(function () { }); // يضمن وجود مستمع حتى يصل الرد
    });
  };
  Store.prototype.peek = function () { this._prime(); return this._payload(); };
  Store.prototype.api = function () {
    var s = this;
    return {
      subscribe: function (cb) { return s.subscribe(cb); },
      once: function (o) { return s.once(o); },
      peek: function () { return s.peek(); },
      refresh: function () { s.refresh(); }
    };
  };

  /* ---------- مُحوِّلات Firestore ---------- */
  function docOpts() { return { includeMetadataChanges: true }; }
  // مستند واحد. لقطة «غير موجود» من الكاش/بدون اتصال لا تُعتمد (قد تكون مجرد غياب نسخة محلية).
  function docSource(refFn, map) {
    return function (db, h) {
      return refFn(db).onSnapshot(docOpts(), function (snap) {
        var fc = !!(snap.metadata && snap.metadata.fromCache);
        if (!snap.exists) { if (fc) return; h.next({ data: map(null), fromCache: false, count: 0 }); return; }
        h.next({ data: map(snap.data() || {}), fromCache: fc, count: 1 });
      }, h.error);
    };
  }
  function querySource(queryFn, map) {
    return function (db, h) {
      return queryFn(db).onSnapshot(docOpts(), function (snap) {
        var fc = !!(snap.metadata && snap.metadata.fromCache);
        if (fc && snap.empty) return; // لقطة فارغة من الكاش ليست حقيقة
        h.next({ data: map(snap), fromCache: fc, count: !fc && typeof snap.docChanges === 'function' ? snap.docChanges().length : (snap.size || 0) });
      }, h.error);
    };
  }
  function cacheOf(dataKey, metaKey) {
    return {
      cacheRead: function () {
        var d = lsGet(dataKey), m = lsGet(metaKey);
        return d == null ? null : { data: d, ts: m && m.ts || 0 };
      },
      cacheWrite: function (data, ts) { if (data !== null) lsSet(dataKey, data); lsSet(metaKey, { ts: ts }); }
    };
  }
  function mix(def, cache) { def.cacheRead = cache.cacheRead; def.cacheWrite = cache.cacheWrite; return def; }

  /* ---------- 1) الكورسات: platform_data/courses_list ---------- */
  var coursesStore = new Store(mix({
    key: 'courses',
    attach: docSource(function (db) { return db.collection('platform_data').doc('courses_list'); },
      function (d) { return d && isArr(d.items) ? d.items : []; })
  }, cacheOf('alamin_courses', 'alamin_pd_m_courses'))); // نفس مفتاح النسخة القديمة (التوافق)

  /* ---------- 2) المحاضرات: platform_data/lectures_list (مستند واحد) — احتياطيًا مجموعة lectures ---------- */
  var lecturesStore = new Store(mix({
    key: 'lectures',
    attach: function (db, h) {
      var col = null;
      function stopCol() { if (col) { try { col(); } catch (e) { } col = null; } }
      function startCol() {
        if (col) return;
        col = querySource(function (d) { return d.collection('lectures'); },
          function (s) { return s.docs.map(function (d) { return d.data(); }); })(db, h);
      }
      var unsub = db.collection('platform_data').doc('lectures_list').onSnapshot(docOpts(), function (snap) {
        var fc = !!(snap.metadata && snap.metadata.fromCache), d = snap.exists ? snap.data() : null;
        var list = d && isArr(d.lectures) ? d.lectures : null;
        if (list && list.length) { stopCol(); h.next({ data: list, fromCache: fc, count: 1 }); return; }
        if (!snap.exists && fc) return;
        startCol(); // المستند غير موجود/فارغ → المصدر الأصلي (مجموعة lectures) كما كان
      }, function () { startCol(); }); // لو القواعد تمنع المستند نرجع للمجموعة بدل الفشل
      return function () { stopCol(); try { unsub(); } catch (e) { } };
    }
  }, cacheOf('alamin_lectures', 'alamin_pd_m_lectures')));

  /* ---------- 3) الاختبارات: فهرس خفيف + أسئلة كاملة عند الحاجة ---------- */
  function metaFrom(id, q) {
    q = q || {};
    return {
      id: String(id), title: q.title || '', grade: q.grade == null ? '' : q.grade, subject: q.subject || '',
      time: q.time, questionsCount: q.questionsCount,
      qn: typeof q.qn === 'number' ? q.qn : (isArr(q.questionsList) ? q.questionsList.length : (parseInt(q.questionsCount, 10) || 0)),
      totalPoints: q.totalPoints, averageGrade: q.averageGrade, passingGrade: q.passingGrade,
      isPublished: q.isPublished === true, createdAt: q.createdAt || '', updatedAt: q.updatedAt || ''
    };
  }
  var QMEM = {};      // id -> { data, updatedAt, ts }   أسئلة كاملة (ذاكرة الصفحة)
  var EXTRA = {};     // id -> meta | null               اختبارات خارج الفهرس (مربوطة بدرس مثلًا)
  var EXTRA_P = {};   // id -> Promise                    قراءة جارية
  var quizzesStore = new Store(mix({
    key: 'quizzes',
    attach: function (db, h) {
      var q = null;
      function stopQ() { if (q) { try { q(); } catch (e) { } q = null; } }
      function startQ() {
        if (q) return;
        // لا يوجد فهرس منشور من الداشبورد بعد → المصدر القديم: الاختبارات المنشورة (قراءة كاملة، لحين إنشاء الفهرس)
        q = querySource(function (d) { return d.collection('quizzes').where('isPublished', '==', true); },
          function (s) {
            var items = []; s.forEach(function (doc) {
              var data = doc.data() || {};
              QMEM[doc.id] = { data: data, updatedAt: data.updatedAt || '', ts: now() };
              items.push(metaFrom(doc.id, data));
            });
            return { via: 'query', items: items };
          })(db, h);
      }
      var unsub = db.collection('platform_data').doc('quizzes_index').onSnapshot(docOpts(), function (snap) {
        var fc = !!(snap.metadata && snap.metadata.fromCache), d = snap.exists ? snap.data() : null;
        if (d && isArr(d.items)) { stopQ(); h.next({ data: { via: 'index', items: d.items.map(function (m) { return metaFrom(m && m.id, m); }) }, fromCache: fc, count: 1 }); return; }
        if (!snap.exists && fc) return;
        startQ();
      }, function () { startQ(); });
      return function () { stopQ(); try { unsub(); } catch (e) { } };
    }
  }, cacheOf('alamin_pd_quiz_index', 'alamin_pd_m_quiz_index')));

  var mapMemo = { v: -1, m: {} };
  function indexMap() {
    var p = quizzesStore.peek();
    if (mapMemo.v === p.version) return mapMemo.m;
    var m = {}, d = p.data;
    if (d && isArr(d.items)) d.items.forEach(function (x) { if (x && x.id != null) m[String(x.id)] = x; });
    mapMemo = { v: p.version, m: m }; return m;
  }
  // undefined = غير معروف بعد، null = غير موجود، كائن = بيانات الاختبار الخفيفة
  function metaOf(id) {
    id = String(id);
    var m = indexMap()[id]; if (m) return m;
    var e = EXTRA[id]; if (e !== undefined) return e;
    var p = quizzesStore.peek();
    if (p.data && p.data.via === 'index' && p.live) return null; // الفهرس الحي كامل: غير موجود فيه = غير موجود
    return undefined;
  }
  function readMetaLs(id) {
    var c = lsGet('alamin_pd_qm_' + id); if (!c || !c.ts) return undefined;
    var age = now() - c.ts;
    if (c.meta === null) return age < CFG.META_NEG_TTL_MS ? null : undefined;
    return age < CFG.META_TTL_MS ? c.meta : undefined;
  }
  var FAILED = {}; // id -> وقت آخر فشل (لا نعيد المحاولة قبل 15 ثانية)
  function ensureMeta(ids) {
    var list = (ids || []).map(String);
    if (!list.some(function (id) { return metaOf(id) === undefined; })) return Promise.resolve();
    // ننتظر الفهرس الحي أولًا: غالبًا يحتوي كل شيء فلا نقرأ اختبارات مفردة بلا داعٍ
    return quizzesStore.once({ timeout: 9000 }).then(function () {
      var jobs = [];
      list.forEach(function (id) {
        if (metaOf(id) !== undefined) return;
        var c = readMetaLs(id); if (c !== undefined) { EXTRA[id] = c; return; }
        if (FAILED[id] && now() - FAILED[id] < 15000) return;
        if (!EXTRA_P[id]) {
          EXTRA_P[id] = getDb(6000).then(function (db) {
            if (!db) { FAILED[id] = now(); return; }
            stats.gets++;
            return db.collection('quizzes').doc(id).get().then(function (snap) {
              if (snap.exists) {
                var data = snap.data() || {}, meta = metaFrom(id, data);
                EXTRA[id] = meta; QMEM[id] = { data: data, updatedAt: data.updatedAt || '', ts: now() };
                lsSet('alamin_pd_qm_' + id, { ts: now(), meta: meta });
              } else { EXTRA[id] = null; lsSet('alamin_pd_qm_' + id, { ts: now(), meta: null }); }
            });
          }).catch(function () { FAILED[id] = now(); }) // تعذّر الاتصال: تبقى «غير معروف» وتُعاد المحاولة لاحقًا
            .then(function () { delete EXTRA_P[id]; });
        }
        jobs.push(EXTRA_P[id]);
      });
      return Promise.all(jobs);
    });
  }
  function saveQuizLs(id, rec) {
    var keys = lsGet('alamin_pd_q_keys') || [];
    var s; try { s = JSON.stringify(rec); } catch (e) { return; }
    if (s.length > CFG.QUIZ_LS_BYTES) return;
    keys = keys.filter(function (k) { return k !== id; }); keys.push(id);
    while (keys.length > CFG.QUIZ_LS_MAX) lsDel('alamin_pd_q_' + keys.shift());
    if (!lsSet('alamin_pd_q_' + id, rec)) { lsDel('alamin_pd_q_' + keys.shift()); lsSet('alamin_pd_q_' + id, rec); }
    lsSet('alamin_pd_q_keys', keys);
  }
  // أسئلة اختبار كاملة. opts.fresh = عند بدء اختبار: لا نعتمد نسخة إلا لو طابقها الفهرس اللحظي (updatedAt)
  function getFull(id, opts) {
    id = String(id); opts = opts || {};
    var rec = QMEM[id] || lsGet('alamin_pd_q_' + id), meta = metaOf(id), want = meta && meta.updatedAt;
    if (rec && rec.data && !opts.force) {
      var p = quizzesStore.peek();
      var byIndex = !!(want && p.live && String(rec.updatedAt || '') === String(want));
      var recent = !opts.fresh && (now() - (rec.ts || 0)) < CFG.QUIZ_FRESH_MS;
      if (byIndex || recent) { QMEM[id] = rec; return Promise.resolve(rec.data); }
    }
    return getDb(6000).then(function (db) {
      if (!db) throw new Error('no-db');
      stats.gets++;
      return db.collection('quizzes').doc(id).get().then(function (snap) {
        if (!snap.exists) { var e = new Error('quiz-not-found'); e.code = 'not-found'; throw e; }
        var data = snap.data() || {}, r = { data: data, updatedAt: data.updatedAt || '', ts: now() };
        QMEM[id] = r; saveQuizLs(id, r); return data;
      });
    }).catch(function (err) {
      if (rec && rec.data && !(err && err.code === 'not-found')) { QMEM[id] = rec; return rec.data; } // بدون اتصال: آخر نسخة محفوظة
      throw err;
    });
  }
  var quizzesApi = quizzesStore.api();
  quizzesApi.map = indexMap;
  quizzesApi.metaOf = metaOf;
  quizzesApi.ensureMeta = ensureMeta;
  quizzesApi.getFull = getFull;
  quizzesApi.complete = function () { var p = quizzesStore.peek(); return !!(p.data && p.data.via === 'index'); };

  /* ---------- 4) نتائج الطالب: quiz_attempts للطالب فقط ---------- */
  var ATT = {};
  function attemptsStore(sid) {
    sid = String(sid);
    if (!ATT[sid]) ATT[sid] = new Store(mix({
      key: 'attempts:' + sid,
      attach: querySource(function (db) { return db.collection('quiz_attempts').where('studentId', '==', sid); },
        function (s) {
          var o = {}; s.forEach(function (d) {
            var a = d.data(); if (a && a.quizId != null && (a.status === 'submitted' || a.status === 'absent')) o[String(a.quizId)] = a;
          }); return o;
        })
    }, cacheOf('alamin_exam_done_' + sid, 'alamin_pd_m_att_' + sid)));
    return ATT[sid];
  }
  function attemptsApi(sid) {
    var s = attemptsStore(sid), a = s.api();
    // تسجيل نتيجة سُلّمت للتو محليًا فتظهر في كل الصفحات فورًا (المستمع يؤكدها لاحقًا بلا إعادة رسم)
    a.patch = function (quizId, rec) {
      s._prime();
      var cur = s.data || {}, n = {}; Object.keys(cur).forEach(function (k) { n[k] = cur[k]; }); n[String(quizId)] = rec;
      s._accept(n, s.live, 0);
    };
    return a;
  }

  /* ---------- 5) مستند الطالب (الاشتراكات enrolledCourses) ---------- */
  var STU = {};
  function studentApi(collection, id) {
    var key = collection + '/' + id;
    if (!STU[key]) STU[key] = new Store({
      key: 'student:' + key,
      attach: docSource(function (db) { return db.collection(collection).doc(String(id)); }, function (d) { return d || {}; }),
      cacheRead: function () { var c = lsGet('alamin_pd_stu_' + key), m = lsGet('alamin_pd_m_stu_' + key); return c == null ? null : { data: c, ts: m && m.ts || 0 }; },
      // لا نخزّن إلا الاشتراكات (بيانات الطالب الكاملة تُدمج في alamin_current كما كان)
      cacheWrite: function (data, ts) { if (data !== null) lsSet('alamin_pd_stu_' + key, { enrolledCourses: isArr(data.enrolledCourses) ? data.enrolledCourses : [] }); lsSet('alamin_pd_m_stu_' + key, { ts: ts }); }
    });
    return STU[key].api();
  }

  /* ---------- أحداث عامة: إعادة الاتصال فور عودة الإنترنت/ظهور الصفحة، وتنظيف المستمعين عند المغادرة ---------- */
  function each(fn) { ALL.slice().forEach(fn); }
  try {
    w.addEventListener('online', function () { each(function (s) { if (s.subs.length && (!s.live || s.state === 'error')) s.refresh(); }); });
    w.document.addEventListener('visibilitychange', function () { if (!w.document.hidden) each(function (s) { if (s.subs.length && s.state === 'error') s.refresh(); }); });
    w.addEventListener('pageshow', function (e) { if (e && e.persisted) each(function (s) { s.refresh(); }); });
    w.addEventListener('pagehide', function () { each(function (s) { s._detach(); }); });
  } catch (e) { }

  w.AlaminData = {
    courses: coursesStore.api(),
    lectures: lecturesStore.api(),
    quizzes: quizzesApi,
    attempts: attemptsApi,
    student: studentApi,
    ready: getDb,
    stats: function () { return Object.assign({}, stats, { stores: ALL.length, activeListeners: ALL.filter(function (s) { return !!s.unsub; }).length }); },
    config: CFG,
    _Store: Store
  };
})(window);
