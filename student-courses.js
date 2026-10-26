/* student-courses.js — طبقة بيانات الكورسات لواجهة الطالب.
   المصدر الوحيد: مستند Firestore  platform_data/courses_list  { items: [...] }
   (نفس المستند الذي تكتب فيه لوحة التحكم). لا توجد كورسات ثابتة هنا.
   القراءة تتم عبر الطبقة المشتركة platform-data.js (AlaminData.courses): مستمع واحد لكل صفحة، عرض فوري من نسخة الجهاز
   'alamin_courses'، وتحديث لحظي عند أي إضافة/تعديل/حذف من الداشبورد — بقراءة واحدة بدل قراءتين لكل صفحة.
   ما بقي من الكود المباشر (legacyLoad / legacyWatch) احتياطي فقط لو لم يُحمَّل platform-data.js. */
(function () {
  'use strict';

  // تصنيفات الكورسات: كورسات الكبار (CEFR) وكورسات الأطفال + التوافق مع الصفوف القديمة
  var GRADES = [
    // ── كورسات الكبار — Adult English Courses ──
    { slug: 'pre-a1', code: 'pre-a1', server: 'Pre-A1', title: 'Pre-A1 (للمبتدئين تمامًا)' },
    { slug: 'a1', code: 'a1', server: 'A1', title: 'A1 (مبتدئ)' },
    { slug: 'a2', code: 'a2', server: 'A2', title: 'A2 (ما دون المتوسط)' },
    { slug: 'b1', code: 'b1', server: 'B1', title: 'B1 (متوسط)' },
    { slug: 'b2', code: 'b2', server: 'B2', title: 'B2 (فوق المتوسط)' },
    { slug: 'c1', code: 'c1', server: 'C1', title: 'C1 (متقدم)' },

    // ── كورسات الأطفال — Kids English Courses ──
    { slug: 'phonics', code: 'phonics', server: 'Phonics', title: 'Phonics Course (تعليم الأصوات)' },
    { slug: 'kids-level-1', code: 'kids-level-1', server: 'Kids Level 1', title: 'Kids Level 1 (المستوى الأول للأطفال)' },
    { slug: 'kids-level-2', code: 'kids-level-2', server: 'Kids Level 2', title: 'Kids Level 2 (المستوى الثاني للأطفال)' },
    { slug: 'kids-level-3', code: 'kids-level-3', server: 'Kids Level 3', title: 'Kids Level 3 (المستوى الثالث للأطفال)' },

    // ── الصفوف القديمة كـ Fallback للتوافق مع البيانات السابقة ──
    { slug: 'first-secondary', code: '1', server: 'First Secondary', title: 'الصف الأول الثانوي (سابقاً)' },
    { slug: 'second-secondary', code: '2', server: 'Second Secondary – Baccalaureate', title: 'الصف الثاني الثانوي — البكالوريا (سابقاً)' },
    { slug: 'third-secondary', code: '3', server: 'Third Secondary', title: 'الصف الثالث الثانوي (سابقاً)' }
  ];

  function gradeBySlug(v) {
    v = String(v || '').trim();
    for (var i = 0; i < GRADES.length; i++) {
      var g = GRADES[i];
      if (v === g.slug || v === g.server || v === g.code) return g;
    }
    return null;
  }
  // يوحّد أي قيمة grade مخزّنة (كود، كود قديم، اسم عربي) عبر grade-mapping.js الأصلي
  function courseGradeCode(c) {
    var raw = c && c.grade;
    return typeof window.normalizeGrade === 'function' ? window.normalizeGrade(raw) : String(raw == null ? '' : raw).trim();
  }
  function gradeOfCourse(c) {
    var code = courseGradeCode(c);
    for (var i = 0; i < GRADES.length; i++) if (GRADES[i].code === code) return GRADES[i];
    return null;
  }
  function coursesForGrade(courses, grade) {
    return (courses || []).filter(function (c) { return c && courseGradeCode(c) === grade.code; });
  }

  // ---------- أدوات ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function safeUrl(u) {
    u = String(u || '').trim();
    return /^(https?:\/\/|data:image\/|\/|[\w.-]+\.(jpe?g|png|webp|gif|avif)(\?|$))/i.test(u) ? u : '';
  }
  function num(v, d) { v = parseFloat(v); return isFinite(v) ? v : d; }
  function secs(d) {
    if (!d) return 0;
    var p = String(d).split(':').map(Number);
    if (p.some(isNaN)) return 0;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : (p[0] || 0);
  }
  function fmtDur(t) {
    if (!t) return '';
    var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') : m + ':' + String(s).padStart(2, '0');
  }
  var AR = '٠١٢٣٤٥٦٧٨٩';
  function ar(n) { return String(n).replace(/\d/g, function (d) { return AR[d]; }); }

  // الدروس مرتّبة حسب position (يعدّله الأدمن من لوحة التحكم) ثم ترتيب الإضافة
  function lessonsOf(c) {
    var ls = Array.isArray(c && c.lessons) ? c.lessons.slice() : [];
    return ls.map(function (l, i) { return { l: l, i: i }; })
      .sort(function (a, b) { return (num(a.l.position, a.i + 1) - num(b.l.position, b.i + 1)) || (a.i - b.i); })
      .map(function (x) { return x.l; });
  }
  function segmentsOf(l) {
    if (Array.isArray(l.segments) && l.segments.length) {
      return l.segments.slice().sort(function (a, b) { return num(a.position, 0) - num(b.position, 0); });
    }
    return l.videoUrl || l.bunnyVideoId ? [{ title: l.title || 'المقطع الأول', duration: l.duration || '' }] : [];
  }
  function courseSecs(c) {
    return lessonsOf(c).reduce(function (sum, l) {
      return sum + segmentsOf(l).reduce(function (s, g) { return s + secs(g.duration); }, 0);
    }, 0);
  }
  function courseUrl(c) { return 'course.html?course=' + encodeURIComponent(c.id); }
  function gradeUrl(g) { return 'courses.html?grade=' + g.slug; }

  // ---------- التحميل ----------
  function readLocal() {
    try { var a = JSON.parse(localStorage.getItem('alamin_courses') || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function waitDb(ms) {
    return new Promise(function (res) {
      if (window.db) return res(window.db);
      var t0 = Date.now(), t = setInterval(function () {
        if (window.db || Date.now() - t0 > ms) { clearInterval(t); res(window.db || null); }
      }, 80);
    });
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, ms); })]);
  }
  function itemsOf(doc) { var d = doc && doc.exists ? doc.data() : null; return d && Array.isArray(d.items) ? d.items : []; }
  function persist(items) { try { localStorage.setItem('alamin_courses', JSON.stringify(items)); } catch (e) {} }

  /* ---------- الطبقة المشتركة ---------- */
  // load(): انتظار أول رد مؤكَّد من الخادم (لا تتعلّق: عند المهلة/الانقطاع تُرجع آخر نسخة محفوظة مع live:false)
  function load() {
    var AD = window.AlaminData;
    if (!AD) return legacyLoad();
    return AD.courses.once({ timeout: 9000 }).then(function (p) {
      return { courses: p.hasData ? p.data : readLocal(), live: p.live, state: p.state, hasData: p.hasData };
    });
  }
  // watch(cb): عرض فوري من نسخة الجهاز (لو وُجدت) ثم متابعة لحظية — يُرجع دالة لإلغاء الاشتراك.
  // r = { courses, live (لا مشكلة اتصال), fresh (مؤكَّد من الخادم الآن), state, hasData }
  // hasData=false تعني لا نسخة محفوظة ولم يصل رد بعد (تحميل/بطء/خطأ) — على الصفحة أن تعرض حالة تحميل أو زر إعادة محاولة.
  function watch(cb) {
    var AD = window.AlaminData;
    if (!AD) { legacyWatch(cb); return function () { }; }
    return AD.courses.subscribe(function (p) {
      cb({ courses: p.hasData ? p.data : [], live: p.ok, fresh: p.live, state: p.state, hasData: p.hasData });
    });
  }

  /* ---------- احتياطي (بدون platform-data.js): قراءة واحدة أو مستمع واحد فقط، بلا قراءة مزدوجة ---------- */
  async function legacyLoad() {
    var db = await waitDb(6000);
    if (db) {
      try {
        var items = itemsOf(await withTimeout(db.collection('platform_data').doc('courses_list').get(), 10000));
        persist(items);
        return { courses: items, live: true, hasData: true };
      } catch (e) { console.warn('[courses] read failed', e); }
    }
    return { courses: readLocal(), live: false, hasData: true };
  }
  async function legacyWatch(cb) {
    var db = await waitDb(6000), got = false;
    if (!db) return cb({ courses: readLocal(), live: false, hasData: true });
    setTimeout(function () { if (!got) cb({ courses: readLocal(), live: false, hasData: true }); }, 10000);
    try {
      db.collection('platform_data').doc('courses_list').onSnapshot(function (doc) {
        if (doc.metadata && doc.metadata.fromCache && !doc.exists) return;
        got = true;
        var items = itemsOf(doc);
        persist(items);
        cb({ courses: items, live: !(doc.metadata && doc.metadata.fromCache), hasData: true });
      }, function (e) { console.warn('[courses] listener', e); if (!got) { got = true; cb({ courses: readLocal(), live: false, hasData: true }); } });
    } catch (e) { console.warn('[courses] watch', e); }
  }

  var ICON = {
    book: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2zM4 19a2 2 0 012-2h13"/></svg>',
    play: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3"/></svg>',
    clock: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    arrow: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>',
    chev: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    gift: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v9h14v-9M8 8a2.5 2.5 0 110-5c2 0 4 2 4 5 0-3 2-5 4-5a2.5 2.5 0 110 5"/></svg>',
    file: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5"/></svg>',
    quiz: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11l3 3 8-8M20 12v7a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h9"/></svg>'
  };

  // صورة الغلاف كما حفظتها لوحة التحكم (مع تموضع وتكبير الصورة)، وإلا غلاف افتراضي بهوية المنصة الجديدة
  function coverHtml(c) {
    var src = safeUrl(c.thumbnail);
    if (!src) return ICON.book;
    var x = num(c.thumbnailX, 50), y = num(c.thumbnailY, 50), z = num(c.thumbnailZoom, 1);
    return '<img src="' + esc(src) + '" alt="" loading="lazy" style="object-position:' + x + '% ' + y + '%;transform-origin:' + x + '% ' + y + '%;' + (z > 1 ? 'transform:scale(' + z + ')' : '') + '" onerror="this.remove()">';
  }
  function isFree(c) { return c.type === 'free'; }
  function priceText(c) { return num(c.price, 0) > 0 ? ar(num(c.price, 0)) + ' ج.م' : ''; }

  function isCourseUnlocked(c, user) {
    if (!c) return true;
    if (c.type === 'free') return true;
    if (!user) {
      try { user = JSON.parse(localStorage.getItem('alamin_current') || 'null'); } catch (e) {}
    }
    if (!user) return false;
    if (user.role === 'admin') return true;
    var enrolled = (user.enrolledCourses || []).map(String);
    return enrolled.includes(String(c.id));
  }

  async function redeemActivationCode(code, studentUser) {
    code = String(code || '').trim().toUpperCase();
    if (!code) return { ok: false, msg: 'يرجى إدخال كود التفعيل' };
    if (!studentUser || !studentUser.id) {
      try {
        studentUser = JSON.parse(localStorage.getItem('alamin_current') || 'null');
      } catch (e) {}
    }
    if (!studentUser || !studentUser.id) {
      return { ok: false, msg: 'يرجى تسجيل الدخول أولاً لتفعيل الكورس بحسابك' };
    }

    if (!window.db) {
      for (var i = 0; i < 25 && !window.db; i++) {
        await new Promise(function(r) { setTimeout(r, 100); });
      }
    }
    if (!window.db) {
      return { ok: false, msg: 'تعذّر الاتصال بقاعدة البيانات. تحقّق من اتصالك بالإنترنت وحاول مرة أخرى.' };
    }

    var codeRef = window.db.collection('vouchers').doc(code);
    var vData = null;

    try {
      // تنفيذ عملية المعاملة الذرية (Atomic Database Transaction) لمنع استخدام الكود لأكثر من طالب
      await window.db.runTransaction(async function(transaction) {
        var snap = await transaction.get(codeRef);
        if (!snap.exists) {
          throw new Error('CODE_NOT_FOUND');
        }
        vData = snap.data();
        if (vData.status === 'مستخدم' || vData.used === true) {
          throw new Error('ALREADY_USED');
        }
        if (vData.linkedStudentId && String(vData.linkedStudentId) !== String(studentUser.id)) {
          throw new Error('LINKED_OTHER');
        }

        var now = new Date().toISOString();
        transaction.update(codeRef, {
          status: 'مستخدم',
          used: true,
          usedBy: String(studentUser.id),
          usedByStudentId: String(studentUser.id),
          usedByStudentName: String(studentUser.full_name || studentUser.name || 'طالب'),
          usedByStudentPhone: String(studentUser.phone || ''),
          usedAt: now
        });
      });
    } catch (err) {
      if (err.message === 'CODE_NOT_FOUND') {
        return { ok: false, msg: 'الكود غير صحيح أو غير موجود.' };
      }
      if (err.message === 'ALREADY_USED') {
        return { ok: false, msg: 'هذا الكود تم استخدامه بالفعل، ولا يمكن استخدامه مرة أخرى.' };
      }
      if (err.message === 'LINKED_OTHER') {
        return { ok: false, msg: 'هذا الكود مخصص لحساب طالب آخر.' };
      }
      console.error('Activation transaction error:', err);
      return { ok: false, msg: 'حدث خطأ أثناء معالجة كود التفعيل. حاول مرة أخرى.' };
    }

    var unlockedCourseIds = (vData.courseIds && vData.courseIds.length)
      ? vData.courseIds.map(String)
      : (vData.courseId ? [String(vData.courseId)] : []);

    if (!unlockedCourseIds.length) {
      return { ok: false, msg: 'هذا الكود غير مرتبط بأي كورس.' };
    }

    try {
      var studentDocRef = window.db.collection('students').doc(String(studentUser.id));
      var sSnap = await studentDocRef.get();
      var enrolled = sSnap.exists && Array.isArray(sSnap.data().enrolledCourses)
        ? sSnap.data().enrolledCourses.map(String)
        : (studentUser.enrolledCourses || []).map(String);

      unlockedCourseIds.forEach(function(cid) {
        if (!enrolled.includes(cid)) enrolled.push(cid);
      });

      await studentDocRef.set({ enrolledCourses: enrolled }, { merge: true });

      studentUser.enrolledCourses = enrolled;
      try {
        localStorage.setItem('alamin_current', JSON.stringify(studentUser));
        var users = JSON.parse(localStorage.getItem('alamin_users') || '[]');
        var uIdx = users.findIndex(function(u) { return String(u.id) === String(studentUser.id); });
        if (uIdx > -1) {
          users[uIdx].enrolledCourses = enrolled;
          localStorage.setItem('alamin_users', JSON.stringify(users));
        }
      } catch (e) {}

      try {
        var vList = JSON.parse(localStorage.getItem('alamin_vouchers') || '[]');
        var vMatch = vList.find(function(v) { return v.code === code; });
        if (vMatch) {
          vMatch.status = 'مستخدم';
          vMatch.used = true;
          vMatch.usedByStudentId = String(studentUser.id);
          vMatch.usedByStudentName = String(studentUser.full_name || studentUser.name || '');
          vMatch.usedAt = new Date().toISOString();
          localStorage.setItem('alamin_vouchers', JSON.stringify(vList));
        }
      } catch (e) {}

      return {
        ok: true,
        courseIds: unlockedCourseIds,
        courseTitles: vData.courseTitles || [vData.courseTitle || '']
      };
    } catch (err) {
      console.error('Error saving student enrollment:', err);
      return { ok: false, msg: 'تم التحقق من الكود بنجاح ولكن حدث خطأ أثناء الحفظ. تواصل مع الدعم الفني.' };
    }
  }

  window.redeemActivationCode = redeemActivationCode;

  window.AlaminCourses = {
    GRADES: GRADES, ICON: ICON, esc: esc, ar: ar, fmtDur: fmtDur, secs: secs,
    gradeBySlug: gradeBySlug, gradeOfCourse: gradeOfCourse, coursesForGrade: coursesForGrade,
    lessonsOf: lessonsOf, segmentsOf: segmentsOf, courseSecs: courseSecs,
    courseUrl: courseUrl, gradeUrl: gradeUrl, coverHtml: coverHtml, isFree: isFree, priceText: priceText,
    isCourseUnlocked: isCourseUnlocked, redeemActivationCode: redeemActivationCode,
    load: load, watch: watch
  };
})();
