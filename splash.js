/* Monalingo loading screen. Visuals live in splash.css; this file decides when it shows, draws it, runs the
   4-second timeline, keeps the page hidden until it is ready, then closes the screen like an iris to reveal it.

   Usage: two tags in <head>, before any other CSS (they are the only things added to index.html):
       <link rel="stylesheet" href="splash.css"><script src="splash.js"></script>
   If either file fails to load, or JavaScript is off, the page simply opens normally. The screen can never block it.

   Settings are in CFG. Testing: add ?splash=1 to the URL to force the screen, ?splash=0 to hide it. */
(function (w, d) {
  'use strict';
  if (w.MonalingoSplash) return;

  var CFG = {
    SHOW: 'entry',     /* 'entry' = only when the platform is opened by link or refresh (not when moving between its pages) | 'always' | 'never' */
    DURATION: 4000,    /* how long the screen runs before it starts to close (ms) */
    HOLD: 280,         /* pause on "Ready" at 100% before closing (ms) */
    EXIT: 900,         /* iris duration (ms) */
    FONT_GRACE: 2500,  /* extra time allowed after DURATION for web fonts to finish */
    MAX_WAIT: 16000    /* after this the platform opens anyway, once the page and its core styles are ready */
  };
  var STEPS = [['Speak', 'Warming up your speaking'], ['Listen', 'Tuning your listening'], ['Read', 'Opening your reading list'], ['Write', 'Sharpening your pen']];
  var R = d.documentElement;

  /* ---------- 1) Should it show? ---------- */
  function shouldShow() {
    var m = /[?&]splash=([01])(?:&|$)/.exec(w.location.search);
    if (m) return m[1] === '1';
    if (CFG.SHOW === 'always') return true;
    if (CFG.SHOW === 'never') return false;
    var type = '';
    try { var n = w.performance.getEntriesByType('navigation')[0]; type = n ? n.type : ''; } catch (e) { }
    if (type === 'back_forward') return false;
    if (type === 'navigate') {                                   /* a click from another page of this platform */
      try { var ref = d.referrer; if (ref && new w.URL(ref).origin === w.location.origin) return false; } catch (e) { }
    }
    return true;
  }
  if (!shouldShow()) return;

  /* ---------- 2) Markup ---------- */
  var ICON = {
    Speak: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0014 0M12 18v3"/>',
    Listen: '<path d="M4 15v-3a8 8 0 0116 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
    Read: '<path d="M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2 2-1.5 5-2 8-2V4c-3 0-6 .5-8 2zM12 6v14"/>',
    Write: '<path d="M4 20l1-4L16 5a2.1 2.1 0 013 3L8 19zM14 7l3 3"/>'
  };
  var GLYPHS = [['Aa', 6, 14, 'clamp(46px,8vw,104px)', -9, 0], ['?', 86, 10, 'clamp(40px,6vw,84px)', 10, 1.2], ['Bb', 80, 66, 'clamp(40px,7vw,92px)', 7, .6],
    ['"', 10, 70, 'clamp(56px,9vw,120px)', 0, 2], ['Hi', 44, 4, 'clamp(30px,5vw,64px)', -6, .3], ['!', 92, 40, 'clamp(40px,6vw,80px)', 8, 1.7],
    ['Cc', 22, 84, 'clamp(34px,6vw,76px)', 6, .9], ['ABC', 62, 86, 'clamp(26px,4.4vw,56px)', -5, 1.4], ['&', 3, 42, 'clamp(40px,6vw,84px)', -10, 2.2]];

  function markup() {
    var g = GLYPHS.map(function (x) { return '<span style="--x:' + x[1] + '%;--y:' + x[2] + '%;--s:' + x[3] + ';--r:' + x[4] + 'deg;--d:-' + x[5] + 's">' + x[0] + '</span>'; }).join('');
    var sk = STEPS.map(function (s) { return '<li><svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[s[0]] + '</svg>' + s[0] + '</li>'; }).join('');
    return '<div class="spl__bg" aria-hidden="true">' + g + '</div>' +
      '<div class="spl__st">' +
      '<div class="spl__bird" aria-hidden="true"><i></i><i></i><i></i></div>' +
      '<h1 class="spl__word" aria-label="Monalingo"><span class="spl__tx" aria-hidden="true"><span class="spl__gh">MONALINGO</span><span class="spl__ink">MONALINGO</span><span class="spl__nib"></span></span></h1>' +
      '<p class="spl__tag">ENGLISH LANGUAGE ACADEMY</p>' +
      '<ul class="spl__sk" aria-hidden="true">' + sk + '</ul>' +
      '<p class="spl__msg" aria-hidden="true"><span class="spl__t">' + STEPS[0][1] + '</span><b class="spl__pct">0%</b></p>' +
      '<span class="spl__sr" role="status" aria-live="polite">Loading Monalingo</span>' +
      '</div>';
  }

  /* ---------- 3) State and helpers ---------- */
  var host, tEl, pEl, srEl, chips, st = { phase: 'run', t0: 0, step: -1, pct: -1 };
  var killer = 0;
  function raf(fn) { w.requestAnimationFrame(fn); }
  function ease(x) { return x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; }   /* slow start, smooth landing on 100% */
  function sameOrigin(u) { try { return new w.URL(u, w.location.href).origin === w.location.origin; } catch (e) { return false; } }

  /* Critical readiness: the page is fully parsed and every stylesheet of this platform is applied,
     so the reveal never shows a half-styled page. */
  function critical() {
    if (d.readyState === 'loading') return false;
    var ls = d.querySelectorAll('link[rel~="stylesheet"]');
    for (var i = 0; i < ls.length; i++) { if (ls[i].href && sameOrigin(ls[i].href) && !ls[i].sheet) return false; }
    return true;
  }
  function ready(e) {
    if (!critical() || d.readyState !== 'complete') return false;
    if (d.fonts && d.fonts.status === 'loading' && e < CFG.DURATION + CFG.FONT_GRACE) return false;
    return true;
  }
  function setStep(i) {
    if (i === st.step) return; st.step = i;
    for (var k = 0; k < chips.length; k++) { chips[k].className = k < i ? 'dn' : (k === i ? 'on' : ''); }
    if (i < STEPS.length) tEl.textContent = STEPS[i][1];
  }

  /* ---------- 4) Finish (safe to call more than once) ---------- */
  function finish() {
    if (st.phase === 'done') return;
    st.phase = 'done';
    w.clearTimeout(killer);
    try { R.classList.add('spl-go'); } catch (e) { }
    try { if (d.body) { d.body.inert = false; d.body.removeAttribute('inert'); } } catch (e) { }
    try { R.classList.remove('spl-lock', 'spl-go', 'spl-vis'); } catch (e) { }
    try { if (host && host.parentNode) host.parentNode.removeChild(host); } catch (e) { }
    w.MonalingoSplash.done = true;
    try { w.dispatchEvent(new w.CustomEvent('monalingo:splash-done')); } catch (e) { }
  }

  /* ---------- 5) Exit: the iris closes and the platform is revealed ---------- */
  function startExit() {
    if (st.phase === 'exit' || st.phase === 'done') return;
    st.phase = 'exit';
    host.style.setProperty('--p', 1);
    host.classList.remove('is-wait');
    setStep(STEPS.length); tEl.textContent = 'Ready. Let\u2019s begin.'; pEl.textContent = '100%';
    srEl.textContent = 'Monalingo is ready';
    w.setTimeout(function () {
      R.classList.add('spl-go');                                  /* the page's own entrance animations start as the iris opens */
      if (w.matchMedia && w.matchMedia('(prefers-reduced-motion:reduce)').matches) { host.classList.add('is-fade'); w.setTimeout(finish, 560); return; }
      host.classList.add('is-exit');
      host.addEventListener('animationend', function (ev) { if (ev.target === host && ev.animationName === 'spl-iris') finish(); });
      w.setTimeout(finish, CFG.EXIT + 300);                      /* fallback if animationend never fires */
    }, CFG.HOLD);
  }

  /* ---------- 6) Clock: drives progress, then decides when to open ---------- */
  function tick(now) {
    if (st.phase === 'done' || st.phase === 'exit') return;
    if (!st.t0) { st.t0 = now; w.MonalingoSplash.startedAt = now; }
    var e = now - st.t0;

    if (st.phase === 'run') {
      var p = ease(Math.min(e / CFG.DURATION, 1)), pc = Math.round(p * 100);
      host.style.setProperty('--p', p.toFixed(4));
      if (pc !== st.pct) { st.pct = pc; pEl.textContent = pc + '%'; }
      setStep(Math.min(STEPS.length - 1, Math.floor(p * STEPS.length)));
      if (e >= CFG.DURATION) {
        if (ready(e)) { startExit(); return; }
        st.phase = 'wait'; host.classList.add('is-wait'); pEl.textContent = '100%';
      }
    } else if (st.phase === 'wait') {
      if (ready(e) || (e > CFG.MAX_WAIT && critical())) { startExit(); return; }
      tEl.textContent = w.navigator.onLine === false ? 'Waiting for your connection\u2026' : 'Almost there\u2026';
    }
    raf(tick);
  }

  /* ---------- 7) Start ---------- */
  try {
    w.MonalingoSplash = { done: false, config: CFG };
    killer = w.setTimeout(finish, CFG.MAX_WAIT + 14000);          /* absolute safety net: the page is never blocked longer than this */

    host = d.createElement('div');
    host.id = 'spl'; host.className = 'spl';
    host.setAttribute('dir', 'ltr'); host.setAttribute('lang', 'en');
    host.innerHTML = markup();
    R.appendChild(host);
    if (w.getComputedStyle(host).position !== 'fixed') throw new Error('splash.css missing');   /* no stylesheet: do not block anything */

    R.classList.add('spl-lock');
    tEl = host.querySelector('.spl__t'); pEl = host.querySelector('.spl__pct');
    srEl = host.querySelector('.spl__sr'); chips = host.querySelectorAll('.spl__sk li');
    setStep(0);

    /* The Google Fonts stylesheet would block the first paint of the whole page, this screen included.
       Make it non-blocking: it still loads and applies the moment it arrives. */
    if (w.MutationObserver) {
      var mo = new w.MutationObserver(function (ms) {
        ms.forEach(function (m) {
          for (var i = 0; i < m.addedNodes.length; i++) {
            var n = m.addedNodes[i];
            if (n.nodeType === 1 && n.tagName === 'LINK' && /(^|\s)stylesheet(\s|$)/.test(n.rel) && /fonts\.googleapis\.com/.test(n.href) && n.media !== 'print') {
              (function (l) { l.media = 'print'; var on = function () { l.media = 'all'; }; l.addEventListener('load', on); l.addEventListener('error', on); })(n);
            }
          }
        });
      });
      mo.observe(R, { childList: true, subtree: true });
      d.addEventListener('DOMContentLoaded', function () { mo.disconnect(); });
    }

    /* The page behind the screen is not reachable by keyboard or screen reader */
    if (d.body) d.body.inert = true;
    else d.addEventListener('DOMContentLoaded', function () { if (st.phase !== 'done' && d.body) d.body.inert = true; });

    /* The screen must be the very first thing painted: the page stays hidden until the first frame is drawn,
       and the 4 seconds start from the moment the screen is actually visible. */
    var shown = false, started = false;
    function showPage() { if (shown) return; shown = true; R.classList.add('spl-vis'); }
    function go() { if (started || st.phase === 'done') return; started = true; host.classList.add('is-run'); raf(tick); w.setTimeout(showPage, 300); }
    try {
      new w.PerformanceObserver(function (list, ob) { if (list.getEntries().length) { ob.disconnect(); go(); } }).observe({ type: 'paint', buffered: true });
    } catch (e) { w.setTimeout(go, 100); }
    w.setTimeout(go, 1200);
    w.setTimeout(showPage, 2500);
  } catch (err) {
    finish();
  }
})(window, document);
