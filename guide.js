// First-steps guide (Simulator). Visual, minimal words.
(function () {
  var D = document;
  function el(h) { var d = D.createElement('div'); d.innerHTML = h; return d.firstChild; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var css = '' +
  '.bl-ov{position:fixed;inset:0;z-index:60;background:rgba(8,11,6,.72);display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .22s;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
  '.bl-ov.on{opacity:1}' +
  '.bl-card{width:100%;max-width:640px;background:linear-gradient(180deg,#2a3224 0%,#1c2118 100%);color:#eee9da;border-radius:26px 26px 0 0;border:1px solid #3f4a35;border-bottom:0;padding:10px 18px calc(20px + env(safe-area-inset-bottom,0px));transform:translateY(24px);transition:transform .28s cubic-bezier(.2,.8,.2,1);box-shadow:0 -12px 40px rgba(0,0,0,.45)}' +
  '.bl-ov.on .bl-card{transform:none}' +
  '.bl-grab{width:38px;height:5px;border-radius:3px;background:#4a563e;margin:2px auto 10px}' +
  '.bl-top{display:flex;justify-content:flex-end;min-height:30px}' +
  '.bl-skip{background:none;border:0;color:#a9ad9a;font:inherit;font-size:15px;padding:4px 6px;cursor:pointer}' +
  '.bl-track{overflow:hidden}' +
  '.bl-slides{display:flex;transition:transform .35s cubic-bezier(.3,.8,.2,1)}' +
  '.bl-slide{min-width:100%;text-align:center}' +
  '.bl-art{height:230px;border-radius:20px;background:#12160f;border:1px solid #38422e;overflow:hidden;margin:2px 0 16px;position:relative}' +
  '.bl-art svg{width:100%;height:100%;display:block}' +
  '.bl-n{display:inline-flex;width:26px;height:26px;border-radius:13px;background:#d9822b;color:#1d1407;font-weight:800;font-size:14px;align-items:center;justify-content:center;margin-bottom:6px}' +
  '.bl-h{font-size:26px;font-weight:800;letter-spacing:.2px;margin:0 0 4px}' +
  '.bl-s{font-size:16px;color:#a9ad9a;margin:0 0 14px;min-height:22px}' +
  '.bl-dots{display:flex;gap:7px;justify-content:center;margin:2px 0 14px}' +
  '.bl-dots i{width:7px;height:7px;border-radius:4px;background:#46513a;transition:all .25s}' +
  '.bl-dots i.on{width:22px;background:#d9822b}' +
  '.bl-go{width:100%;min-height:54px;border-radius:15px;border:0;background:#d9822b;color:#1d1407;font:inherit;font-weight:800;font-size:17px;cursor:pointer}' +
  '.bl-go.alt{background:#323a2a;color:#eee9da;border:1px solid #46513a}' +
  '.bl-help{width:38px;height:38px;border-radius:19px;border:1px solid #46513a;background:#252b20;color:#f0a456;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer}' +
  '.bl-help svg{width:22px;height:22px}' +
  /* animations */
  '@keyframes blPulse{0%{r:6;opacity:.9}100%{r:26;opacity:0}}' +
  '@keyframes blTap{0%,100%{transform:scale(1);opacity:.95}50%{transform:scale(1.55);opacity:.2}}' +
  '@keyframes blBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}' +
  '@keyframes blDrop{0%{transform:translateY(-40px);opacity:0}30%{opacity:1}60%{transform:translateY(0)}75%{transform:translateY(-6px)}100%{transform:translateY(0);opacity:1}}' +
  '@keyframes blWind{0%{transform:translateX(-60px);opacity:0}25%{opacity:.9}100%{transform:translateX(260px);opacity:0}}' +
  '@keyframes blScent{0%,100%{opacity:.25}50%{opacity:.6}}' +
  '@keyframes blDash{to{stroke-dashoffset:-24}}' +
  '.a-pulse{animation:blPulse 1.8s ease-out infinite}.a-pulse2{animation:blPulse 1.8s ease-out .9s infinite}' +
  '.a-tap{transform-box:fill-box;transform-origin:center;animation:blTap 1.4s ease-in-out infinite}' +
  '.a-bob{animation:blBob 1.8s ease-in-out infinite}' +
  '.a-drop1{animation:blDrop 2.6s ease-out infinite}.a-drop2{animation:blDrop 2.6s ease-out .5s infinite}.a-drop3{animation:blDrop 2.6s ease-out 1s infinite}' +
  '.a-wind{animation:blWind 3.2s linear infinite}.a-wind2{animation:blWind 3.2s linear 1.1s infinite}.a-wind3{animation:blWind 3.2s linear 2.1s infinite}' +
  '.a-scent{animation:blScent 2.4s ease-in-out infinite}' +
  '.a-dash{stroke-dasharray:6 6;animation:blDash 1s linear infinite}' +
  '@media (prefers-reduced-motion:reduce){.bl-art *{animation:none!important}}';
  var st = D.createElement('style'); st.textContent = css; D.head.appendChild(st);

  var ICON = {
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9.5"/><path d="M9.5 9.3a2.6 2.6 0 1 1 3.7 2.4c-.8.4-1.2 1-1.2 1.8"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>',
    restore: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20"><path d="M20 12a8 8 0 1 1-2.5-5.8"/><path d="M20 4v4h-4"/></svg>',
  };

  // ---- illustrations ----
  var TERR = '<defs><linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d3a24"/><stop offset="1" stop-color="#1a2214"/></linearGradient></defs><rect width="360" height="230" fill="url(#g1)"/>';
  var ART = [
    // 1 pin your spot
    TERR + '<g stroke="#3a4a2e" stroke-width="1" opacity=".7"><path d="M0 60H360M0 120H360M0 180H360M70 0V230M150 0V230M230 0V230M310 0V230"/></g>' +
    '<path d="M-10 170C60 120 110 190 190 140S300 110 370 150V240H-10Z" fill="#26331d"/><path d="M20 70C90 40 140 90 220 60S320 30 360 50" stroke="#4680aa" stroke-width="7" fill="none" opacity=".8" stroke-linecap="round"/>' +
    '<circle class="a-pulse" cx="180" cy="128" r="6" fill="none" stroke="#d9822b" stroke-width="3"/><circle class="a-pulse2" cx="180" cy="128" r="6" fill="none" stroke="#d9822b" stroke-width="3"/>' +
    '<g class="a-bob"><path d="M180 128c-14-20-22-30-22-42a22 22 0 0 1 44 0c0 12-8 22-22 42z" fill="#d9822b" stroke="#1d1407" stroke-width="2.5"/><circle cx="180" cy="86" r="8" fill="#1d1407"/></g>',
    // 2 use this box
    TERR + '<rect x="70" y="26" width="220" height="130" rx="10" fill="#3b4d2c" stroke="#f0a456" stroke-width="3" class="a-dash"/>' +
    '<g opacity=".8"><rect x="96" y="52" width="60" height="38" rx="8" fill="#345c2e"/><rect x="190" y="84" width="70" height="44" rx="8" fill="#c4a84e" opacity=".8"/><circle cx="170" cy="112" r="6" fill="#fff"/></g>' +
    '<g><rect x="80" y="172" width="200" height="44" rx="14" fill="#d9822b"/><text x="180" y="200" text-anchor="middle" font-family="-apple-system,Helvetica" font-weight="800" font-size="19" fill="#1d1407">Use this box</text></g>' +
    '<circle class="a-tap" cx="262" cy="206" r="15" fill="#fff" opacity=".9"/><circle class="a-tap" cx="262" cy="206" r="7" fill="#1d1407"/>',
    // 3 stands
    TERR + '<rect x="30" y="30" width="130" height="80" rx="14" fill="#345c2e" opacity=".9"/><rect x="190" y="110" width="130" height="80" rx="14" fill="#c4a84e" opacity=".85"/>' +
    '<path d="M0 150C70 120 120 170 190 140" stroke="#4680aa" stroke-width="6" fill="none" opacity=".6" stroke-linecap="round"/>' +
    [[96, 124, 'a-drop1'], [196, 70, 'a-drop2'], [292, 58, 'a-drop3']].map(function (s) { return '<g class="' + s[2] + '"><path d="M' + s[0] + ' ' + s[1] + 'l-13-4v-22h26v22z" fill="#fff" stroke="#1d1407" stroke-width="2"/><path d="M' + (s[0] - 9) + ' ' + (s[1] - 26) + 'h18" stroke="#1d1407" stroke-width="3"/></g>'; }).join('') +
    '<text x="95" y="68" text-anchor="middle" font-family="-apple-system,Helvetica" font-weight="700" font-size="14" fill="#cfe5c5">Bedding</text><text x="255" y="154" text-anchor="middle" font-family="-apple-system,Helvetica" font-weight="700" font-size="14" fill="#2a2b22">Food</text>',
    // 4 wind
    TERR + '<path d="M-10 170C50 90 120 150 190 100S310 60 370 110V240H-10Z" fill="#33442a"/><path d="M-10 200C70 150 130 200 200 160S310 140 370 170V240H-10Z" fill="#26331d"/>' +
    '<ellipse class="a-scent" cx="250" cy="112" rx="70" ry="22" fill="#c8553d" transform="rotate(-8 250 112)"/>' +
    [[70, 70, 'a-wind'], [50, 110, 'a-wind2'], [60, 150, 'a-wind3']].map(function (w) { return '<g class="' + w[2] + '"><path d="M' + w[0] + ' ' + w[1] + 'h70" stroke="#8fd3e8" stroke-width="4" stroke-linecap="round"/><path d="M' + (w[0] + 58) + ' ' + (w[1] - 8) + 'l12 8-12 8" stroke="#8fd3e8" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></g>'; }).join('') +
    '<g><circle cx="130" cy="140" r="13" fill="#2fb7a6" stroke="#fff" stroke-width="3"/><circle cx="210" cy="95" r="13" fill="#e0a22c" stroke="#fff" stroke-width="3"/><circle cx="300" cy="125" r="13" fill="#c8553d" stroke="#fff" stroke-width="3"/></g>'
  ];
  var STEPS = [['Pin your spot', 'More → Property location'], ['Use this box', 'Simulator → Use this box'], ['Place stands', 'Bedding, food, stands'], ['See the wind', 'Teal, amber, crimson']];

  var open = null;
  function overlay(inner, cls) {
    close();
    var o = el('<div class="bl-ov ' + (cls || '') + '" role="dialog" aria-modal="true"><div class="bl-card"><div class="bl-grab"></div>' + inner + '</div></div>');
    D.body.appendChild(o); open = o; requestAnimationFrame(function () { o.classList.add('on'); });
    o.addEventListener('click', function (e) { if (e.target === o) close(); });
    return o;
  }
  function close() { if (!open) return; var o = open; open = null; o.classList.remove('on'); setTimeout(function () { if (o.parentNode) o.parentNode.removeChild(o); }, 220); }

  function guide() {
    var i = 0, n = STEPS.length;
    var slides = STEPS.map(function (s, k) { return '<div class="bl-slide"><div class="bl-art"><svg viewBox="0 0 360 230" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' + ART[k] + '</svg></div><span class="bl-n">' + (k + 1) + '</span><h2 class="bl-h">' + esc(s[0]) + '</h2><p class="bl-s">' + esc(s[1]) + '</p></div>'; }).join('');
    var o = overlay('<div class="bl-top"><button class="bl-skip" data-g="skip">Skip</button></div><div class="bl-track"><div class="bl-slides" id="bl-slides">' + slides + '</div></div><div class="bl-dots">' + STEPS.map(function () { return '<i></i>'; }).join('') + '</div><button class="bl-go" data-g="next">Next</button>');
    var sl = o.querySelector('#bl-slides'), dots = o.querySelectorAll('.bl-dots i'), go = o.querySelector('[data-g=next]'), skip = o.querySelector('[data-g=skip]');
    function show() { sl.style.transform = 'translateX(' + (-100 * i) + '%)'; [].forEach.call(dots, function (d, k) { d.className = k === i ? 'on' : ''; }); go.textContent = i === n - 1 ? 'Got it' : 'Next'; skip.style.visibility = i === n - 1 ? 'hidden' : 'visible'; }
    o.addEventListener('click', function (e) { var b = e.target.closest('[data-g]'); if (!b) return; var a = b.getAttribute('data-g'); if (a === 'skip') close(); else if (i < n - 1) { i++; show(); } else close(); });
    var x0 = null; o.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    o.addEventListener('touchend', function (e) { if (x0 === null) return; var dx = e.changedTouches[0].clientX - x0; x0 = null; if (dx < -40 && i < n - 1) { i++; show(); } else if (dx > 40 && i > 0) { i--; show(); } });
    show();
  }

  window.BLGuide = {
    open: guide,
    auto: function (settings, save) { if (settings.simGuideSeen) return; settings.simGuideSeen = true; save(); setTimeout(guide, 350); },
    helpBtn: '<button class="bl-help" data-bl="guide" aria-label="First steps">' + ICON.help + '</button>'
  };
  D.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-bl]'); if (!b) return;
    e.preventDefault(); var a = b.getAttribute('data-bl'); if (a === 'guide') guide();
  });
})();
