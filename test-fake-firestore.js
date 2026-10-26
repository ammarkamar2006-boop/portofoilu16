'use strict';
/* فايرستور مزيّف يحاكي الاحتساب الحقيقي للقراءات — يستخدمه test-data.js و test-pages.js (بدون أي مكتبات).
     • get() = قراءة لكل مستند راجع (حدّ أدنى 1)
     • onSnapshot الأولى = قراءة لكل مستند في النتيجة (حدّ أدنى 1)
     • كل تغيير يصل لمستمع نشط = قراءة لكل مستند تغيّر
   S.reads هو العدّاد، و S.set/S.del/S.seed تحاكي ما تكتبه لوحة التحكم، و S.online لمحاكاة الانقطاع، و S.failNext لمحاكاة خطأ مستمع. */
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* ---------- فايرستور مزيّف ---------- */
function makeServer() {
  const docs = new Map(), subs = new Set();
  const S = { docs, reads: 0, gets: 0, attaches: 0, online: true, latency: 15, failNext: null, persistCalls: [], log: [] };
  const key = (c, id) => c + '/' + id;
  const inCol = c => [...docs.entries()].filter(([k]) => k.startsWith(c + '/')).map(([k, v]) => ({ id: k.slice(c.length + 1), data: v }));
  const match = (d, filters) => filters.every(([f, op, v]) => op === '==' && d[f] === v);
  const later = fn => setTimeout(fn, S.latency);
  const docSnap = (c, id, fc) => ({ id, exists: docs.has(key(c, id)), data: () => JSON.parse(JSON.stringify(docs.get(key(c, id)) || {})), metadata: { fromCache: !!fc } });
  const qSnap = (c, filters, fc, changes) => {
    const ds = inCol(c).filter(x => match(x.data, filters)).map(x => ({ id: x.id, data: () => JSON.parse(JSON.stringify(x.data)) }));
    return { empty: !ds.length, size: ds.length, docs: ds, forEach: f => ds.forEach(f), docChanges: () => changes || ds, metadata: { fromCache: !!fc } };
  };
  function notify(c, id, removed) {
    for (const l of [...subs]) {
      if (!l.alive || l.col !== c) continue;
      if (l.id !== undefined) { if (l.id !== id) continue; S.reads += removed ? 0 : 1; const s = docSnap(c, id, false); l.next(s); }
      else { const d = docs.get(key(c, id)); const was = l.has.has(id), is = !removed && d && match(d, l.filters); if (!was && !is) continue; if (is) { l.has.add(id); S.reads += 1; } else l.has.delete(id); l.next(qSnap(c, l.filters, false, [{ id }])); }
    }
  }
  S.set = (c, id, data, merge) => { docs.set(key(c, id), merge ? Object.assign({}, docs.get(key(c, id)) || {}, data) : JSON.parse(JSON.stringify(data))); later(() => notify(c, id, false)); };
  S.del = (c, id) => { docs.delete(key(c, id)); later(() => notify(c, id, true)); };
  S.seed = (c, id, data) => docs.set(key(c, id), JSON.parse(JSON.stringify(data)));
  function listen(l, errCb) {
    S.attaches++; l.alive = true; subs.add(l);
    later(() => {
      if (!l.alive) return;
      if (S.failNext) { const code = S.failNext; S.failNext = null; l.alive = false; subs.delete(l); const e = new Error(code); e.code = code; return errCb && errCb(e); }
      if (!S.online) { // بدون اتصال: لقطة فارغة من الكاش (كما يفعل SDK الحقيقي بعد مهلة)
        return l.id !== undefined ? l.next(docSnap(l.col, l.id, true)) : l.next(qSnap(l.col, l.filters, true));
      }
      if (l.id !== undefined) { S.reads += 1; l.next(docSnap(l.col, l.id, false)); }
      else { const s = qSnap(l.col, l.filters, false); s.docs.forEach(d => l.has.add(d.id)); S.reads += Math.max(1, s.size); l.next(s); }
    });
    return () => { l.alive = false; subs.delete(l); };
  }
  const argsOf = (a) => typeof a[0] === 'function' ? { next: a[0], err: a[1] } : { next: a[1], err: a[2] };
  function query(c, filters) {
    return {
      where: (f, op, v) => query(c, filters.concat([[f, op, v]])),
      onSnapshot: (...a) => { const x = argsOf(a); return listen({ col: c, filters, has: new Set(), next: x.next }, x.err); },
      get: async () => { S.gets++; await sleep(S.latency); if (!S.online) throw new Error('offline'); const s = qSnap(c, filters, false); S.reads += Math.max(1, s.size); return s; }
    };
  }
  S.db = {
    enablePersistence: (o) => { S.persistCalls.push({ o, attachesBefore: S.attaches }); return Promise.resolve(); },
    collection: (c) => ({
      doc: (id) => ({
        get: async () => { S.gets++; await sleep(S.latency); if (!S.online) throw new Error('offline'); S.reads += 1; return docSnap(c, String(id), false); },
        onSnapshot: (...a) => { const x = argsOf(a); return listen({ col: c, id: String(id), next: x.next }, x.err); },
        set: async (d, o) => S.set(c, String(id), d, o && o.merge)
      }),
      where: (f, op, v) => query(c, [[f, op, v]]),
      onSnapshot: (...a) => query(c, []).onSnapshot(...a),
      get: () => query(c, []).get()
    })
  };
  return S;
}
function makeLS(init) {
  const m = new Map(Object.entries(init || {}));
  return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => { m.set(k, String(v)); }, removeItem: k => { m.delete(k); }, _m: m };
}
const COURSES = [{ id: 'c1', title: 'كورس ١', grade: '1', lessons: [] }, { id: 'c2', title: 'كورس ٢', grade: '2', lessons: [] }];
const quiz = (id, extra) => Object.assign({ id, title: 'اختبار ' + id, grade: '1', isPublished: true, time: 20, totalPoints: 10, averageGrade: 50, questionsCount: 2, createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', questionsList: [{ q: 'س؟', opts: ['أ', 'ب'], correctOpt: 0, points: 5 }, { q: 'س٢؟', opts: ['أ', 'ب'], correctOpt: 1, points: 5 }] }, extra || {});
const indexOf = (qs) => ({ items: qs.map(q => ({ id: q.id, title: q.title, grade: q.grade, time: q.time, questionsCount: q.questionsCount, qn: q.questionsList.length, totalPoints: q.totalPoints, averageGrade: q.averageGrade, isPublished: q.isPublished, createdAt: q.createdAt, updatedAt: q.updatedAt })), updatedAt: 'x' });


module.exports = { makeServer, makeLS, COURSES, quiz, indexOf, sleep };
