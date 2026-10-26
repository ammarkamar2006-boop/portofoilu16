/* اختبارات الجلسة الدائمة (خادم حقيقي + Firestore REST مزيّف): تشغيل  node test-session.js */
'use strict';
const { spawn } = require('child_process'), http = require('http'), fs = require('fs'), Database = require('better-sqlite3');
const B = p => 'http://127.0.0.1:' + p, DB = '/tmp/student-session-test.db', FP = 3461;
for (const x of ['', '-wal', '-shm']) fs.rmSync(DB + x, { force: true });
let pass = 0, fail = 0; const t = (n, c, x) => { c ? pass++ : fail++; console.log((c ? 'PASS ' : 'FAIL ') + n + (!c && x !== undefined ? '  → ' + JSON.stringify(x) : '')); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Firestore REST fake ----
const docs = { centerStudents: { S1: { name: 'Ali Hassan', centerCode: 'ABC123', grade: '1', phone: '01011112222' }, S2: { fullName: 'Mona Adel', qrCode: '777888', grade: '2' },
  D1: { name: 'Dup One', centerCode: 'DUP1' }, D2: { name: 'Dup Two', offlineCode: 'DUP1' }, B1: { name: 'Blocked Kid', centerCode: 'BLK1', blocked: true } }, students: {} };
const fv = v => typeof v === 'number' ? { integerValue: String(v) } : typeof v === 'boolean' ? { booleanValue: v } : { stringValue: String(v) };
const fdoc = (c, id) => ({ name: `projects/p/databases/(default)/documents/${c}/${id}`, fields: Object.fromEntries(Object.entries(docs[c][id]).map(([k, v]) => [k, fv(v)])) });
let fsUp = true, fsSrv;
const startFs = () => new Promise(ok => { fsSrv = http.createServer((q, r) => { let b = ''; q.on('data', d => b += d); q.on('end', () => {
  const u = new URL(q.url, 'http://x'), send = (s, o) => { r.writeHead(s, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(o)); };
  if (q.method === 'POST' && u.pathname.endsWith(':runQuery')) { const sq = JSON.parse(b).structuredQuery, col = sq.from[0].collectionId, want = sq.where.compositeFilter.filters.map(f => f.fieldFilter);
    return send(200, Object.keys(docs[col] || {}).filter(id => want.some(w => { const x = docs[col][id][w.field.fieldPath]; const v = w.value.stringValue !== undefined ? w.value.stringValue : Number(w.value.integerValue); return x !== undefined && x === v; })).map(id => ({ document: fdoc(col, id) }))); }
  const m = u.pathname.match(/\/documents\/(\w+)\/([^/]+)$/); if (m && docs[m[1]] && docs[m[1]][decodeURIComponent(m[2])]) return send(200, fdoc(m[1], decodeURIComponent(m[2])));
  send(404, { error: { code: 404 } }); }); }).listen(FP, '127.0.0.1', ok); });
const stopFs = () => new Promise(ok => fsSrv.close(ok)); // (closeAllConnections not needed: node fetch uses fresh sockets)

// ---- server runner ----
async function boot(port, env = {}) {
  const p = spawn('node', ['server.js'], { env: { ...process.env, PORT: port, DB_FILE: DB, FIRESTORE_BASE: `http://127.0.0.1:${FP}/documents`, FIREBASE_API_KEY: '', ...env }, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { try { await fetch(B(port) + '/auth.html'); break; } catch { await sleep(150); } }
  return p;
}
const kill = p => new Promise(ok => { p.once('exit', ok); p.kill(); });
const client = port => { let ck = ''; const c = async (m, path, body) => { const r = await fetch(B(port) + path, { method: m, redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(ck ? { cookie: ck } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.getSetCookie(); if (sc.length) { ck = sc.map(x => x.split(';')[0]).join('; '); c.set = sc.join('\n'); } let j = null; try { j = await r.json(); } catch { } return { s: r.status, j, loc: r.headers.get('location') }; }; c.ck = () => ck; return c; };

(async () => {
  await startFs();
  let srv = await boot(3460, { CENTER_RECHECK_MS: '300' }); const P = 3460;
  const a = client(P);
  let r = await a('POST', '/api/center-session', { code: '!!' }); t('rejects malformed code (400)', r.s === 400);
  r = await a('POST', '/api/center-session', { code: 'NOPE999' }); t('unknown center code rejected (404)', r.s === 404);
  r = await a('POST', '/api/center-session', { code: 'dup1' }); t('code shared by two records rejected (409)', r.s === 409);
  r = await a('POST', '/api/center-session', { code: 'BLK1' }); t('blocked student cannot sign in (403)', r.s === 403);
  r = await a('GET', '/api/me'); t('no session before a valid login (401)', r.s === 401);
  r = await a('POST', '/api/center-session', { code: ' abc123 ' }); t('valid code (any case/spacing) signs in', r.s === 200 && r.j.ok && r.j.student.id === 'S1');
  t('code is NOT returned to the browser', !JSON.stringify(r.j).match(/ABC123/i) && !('centerCode' in r.j.student) && !('qrCode' in r.j.student));
  t('cookie is HttpOnly + SameSite=Lax', /sid=/.test(a.set) && /HttpOnly/i.test(a.set) && /SameSite=Lax/i.test(a.set));
  const exp = Date.parse((a.set.match(/Expires=([^;]+)/i) || [])[1]), age = (exp - Date.now()) / 1000; t('cookie lifetime is long (≥ 60 days)', age >= 60 * 86400, age);
  t('cookie value holds no student data or code', !/ABC123|S1|Ali/i.test(decodeURIComponent(a.ck())));
  r = await a('GET', '/api/me'); t('/api/me returns the student (session works)', r.s === 200 && r.j.full_name === 'Ali Hassan' && r.j.local === 1 && r.j.collection === 'centerStudents' && r.j.id === 'S1');
  r = await a('GET', '/login'); t('/login redirects a signed-in center student home', r.s === 302 && r.loc === '/');
  r = await a('GET', '/api/me'); t('session still valid on later requests', r.s === 200);

  // SQLite (phone) student too
  const good = { fullName: 'Ahmed Mohamed Ali', phone: '01012345678', parentPhone: '01198765432', password: '123456', confirmPassword: '123456', grade: 'First Secondary', accountType: 'external' };
  const b = client(P); r = await b('POST', '/api/register', good); t('phone student registers and is signed in', r.s === 201);
  const bCk = b.ck(), aCk = a.ck();

  // restart: sessions survive
  await kill(srv); srv = await boot(P, { CENTER_RECHECK_MS: '300' });
  const a2 = client(P), b2 = client(P); a2.ck = () => aCk; const withCk = (ck) => async (m, p) => (await fetch(B(P) + p, { method: m, headers: { cookie: ck } }).then(async x => ({ s: x.status, j: await x.json().catch(() => null) })));
  r = await withCk(aCk)('GET', '/api/me'); t('center session survives a server restart', r.s === 200 && r.j.full_name === 'Ali Hassan', r);
  r = await withCk(bCk)('GET', '/api/me'); t('phone-student session survives a server restart', r.s === 200 && r.j.phone === '01012345678', r);

  // revocation of a center student (record deleted) and Firestore outage
  await sleep(400); await stopFs();
  r = await withCk(aCk)('GET', '/api/me'); t('Firestore outage does not log the student out', r.s === 200, r);
  await startFs(); await sleep(400);
  const c = client(P); await c('POST', '/api/center-session', { code: '777888' });
  r = await c('GET', '/api/me'); t('second center student (qrCode) signs in', r.s === 200 && r.j.full_name === 'Mona Adel');
  docs.centerStudents.S2.blocked = true; await sleep(400);
  r = await c('GET', '/api/me'); t('blocked in Firestore → session revoked (401)', r.s === 401);
  r = await c('GET', '/api/me'); t('revoked session stays dead', r.s === 401);
  const d = client(P); await d('POST', '/api/center-session', { code: 'ABC123' }); delete docs.centerStudents.S1; await sleep(400);
  r = await d('GET', '/api/me'); t('record deleted in Firestore → session revoked (401)', r.s === 401);

  // phone student revoked
  const w = new Database(DB); w.prepare('UPDATE students SET active = 0').run(); w.close();
  r = await withCk(bCk)('GET', '/api/me'); t('deactivated phone student loses access (401)', r.s === 401);
  r = await client(P)('POST', '/api/login', { phone: '01012345678', password: '123456' }); t('deactivated phone student cannot log in (403)', r.s === 403);
  const w2 = new Database(DB); w2.prepare('UPDATE students SET active = 1').run(); w2.close();

  // explicit logout
  const e = client(P); await e('POST', '/api/login', { phone: '01012345678', password: '123456' });
  r = await e('GET', '/api/me'); t('phone login works', r.s === 200);
  r = await e('POST', '/api/logout'); t('logout succeeds', r.s === 200);
  r = await e('GET', '/api/me'); t('after logout the session is gone (401)', r.s === 401);

  // no secrets in the DB session rows' cookie, passwords never stored in sessions
  const rows = new Database(DB, { readonly: true }).prepare('SELECT sess FROM sessions').all().map(x => x.sess).join('');
  t('no password is stored in any session record', !/123456/.test(rows));
  await kill(srv);

  // expiry: idle lifetime and absolute cap
  let s2 = await boot(3462, { SESSION_DAYS: '0.00002' }); let x = client(3462); await x('POST', '/api/login', { phone: '01012345678', password: '123456' });
  r = await x('GET', '/api/me'); t('fresh session valid before idle expiry', r.s === 200); await sleep(2600);
  r = await x('GET', '/api/me'); t('idle session expires (401)', r.s === 401); await kill(s2);
  s2 = await boot(3463, { SESSION_MAX_DAYS: '0.00002' }); x = client(3463); await x('POST', '/api/login', { phone: '01012345678', password: '123456' });
  r = await x('GET', '/api/me'); t('fresh session valid before absolute cap', r.s === 200); await sleep(2600);
  r = await x('GET', '/api/me'); t('session older than the absolute cap is rejected (401)', r.s === 401); await kill(s2);
  await stopFs();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
