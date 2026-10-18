/* Buck Ledger: a hunter's logbook that fills itself in from your SD card.
 * Everything is stored on the device (IndexedDB). No accounts, no server. */
(function () {
  'use strict';
  var C = window.BUCKLEDGER_CONFIG || {};
  var APP = C.APP_NAME || 'Buck Ledger';
  var SCHEMA = 2;
  var KINDS = [
    { id: 'buck', label: 'Buck' }, { id: 'doe', label: 'Doe' }, { id: 'fawn', label: 'Fawn' },
    { id: 'other', label: 'Other' }, { id: 'empty', label: 'Empty' }
  ];
  var KIND_LABEL = {}; KINDS.forEach(function (t) { KIND_LABEL[t.id] = t.label; });
  /* ---------------- utils ---------------- */
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function plural(n, w, pl) { return n + ' ' + (n === 1 ? w : (pl || w + 's')); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function clampStr(s, n) { return String(s == null ? '' : s).slice(0, n); }
  // Local wall-clock times are stored as "YYYY-MM-DDTHH:MM:SS" strings (trail cams have no time zone).
  function parseLocal(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s || '');
    if (!m) return null;
    var d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    return isNaN(d) ? null : d;
  }
  function toLocalStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function fmtTime(d) { var h = d.getHours(), m = d.getMinutes(); return ((h % 12) || 12) + ':' + pad(m) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function fmtHour(h) { return h === 0 ? '12a' : h < 12 ? h + 'a' : h === 12 ? '12p' : (h - 12) + 'p'; }
  function fmtHourLong(h) { h = ((h % 24) + 24) % 24; return ((h % 12) || 12) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function fmtDate(d) { return MON[d.getMonth()] + ' ' + d.getDate() + (d.getFullYear() !== new Date().getFullYear() ? ', ' + d.getFullYear() : ''); }
  function fmtDT(d) { return d ? fmtDate(d) + ' · ' + fmtTime(d) : 'No time'; }
  function fmtDay(ms) { return fmtDate(new Date(ms)); }
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function isStandalone() { return (window.matchMedia && matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true; }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('#toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2200);
  }
  function sheet(html, onClick) {
    var root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true">' + html + '</div></div>';
    var back = $('.sheet-back', root);
    return new Promise(function (resolve) {
      function close(v) { root.innerHTML = ''; resolve(v); }
      back.addEventListener('click', function (e) {
        if (e.target === back) return close(null);
        var b = e.target.closest('[data-x]'); if (!b) return;
        var x = b.getAttribute('data-x');
        if (onClick) { var r = onClick(x, b, close); if (r === false) return; }
        if (x === 'close' || x === 'no') close(null); else if (x === 'yes') close(true);
      });
    });
  }
  function closeSheet() { $('#sheet-root').innerHTML = ''; }
  function confirmSheet(title, body, yes, danger) {
    return sheet('<h2>' + esc(title) + '</h2><p class="muted">' + esc(body) + '</p><div class="btn-row"><button class="btn" data-x="no">Cancel</button><button class="btn ' + (danger ? 'danger' : 'primary') + '" data-x="yes">' + esc(yes || 'OK') + '</button></div>');
  }

  /* ---------------- storage (IndexedDB) ---------------- */
  var DB = null;
  function openDB() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) return rej(new Error('no-idb'));
      var r = indexedDB.open('buckledger', 1);
      r.onupgradeneeded = function () {
        var db = r.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      };
      r.onsuccess = function () { DB = r.result; res(DB); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function tx(store, mode, fn) {
    return new Promise(function (res, rej) {
      var t = DB.transaction(store, mode), s = t.objectStore(store), out;
      out = fn(s);
      t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error || new Error('abort')); };
    });
  }
  function kvGet(k) { return tx('kv', 'readonly', function (s) { return s.get(k); }); }
  function kvPut(k, v) { return tx('kv', 'readwrite', function (s) { s.put(v, k); }); }
  function photoPut(p) { return tx('photos', 'readwrite', function (s) { s.put(p); }); }
  function photosPutMany(arr) { return tx('photos', 'readwrite', function (s) { arr.forEach(function (p) { s.put(p); }); }); }
  function photoDel(ids) { return tx('photos', 'readwrite', function (s) { ids.forEach(function (id) { s.delete(id); }); }); }
  function photosAll() { return tx('photos', 'readonly', function (s) { return s.getAll(); }); }
  function photosClear() { return tx('photos', 'readwrite', function (s) { s.clear(); }); }

  /* ---------------- state ---------------- */
  var S = null;       // { schema, cameras:[], deer:[], pulls:[], settings:{} }
  var P = [];         // photo records (with thumb Blobs)
  var PI = {};        // id -> photo
  function defaults() {
    return { schema: SCHEMA, cameras: [], deer: [], pulls: [], pins: [], map: null, bait: [], preds: [], t3: null, settings: { lat: null, lng: null, shootMin: 30, gapMin: 20, license: null, deviceId: null, lastBackup: null, lastCam: null, installDismissed: false, createdAt: Date.now(), states: [], areas: {}, hideSmall: true, smallMax: 5, statesAsked: false } };
  }
  function num(v, lo, hi, def) { v = Number(v); return (v !== null && v !== '' && isFinite(v) && v >= lo && v <= hi) ? v : def; }
  function migrate(s) {
    var d = defaults();
    if (!s || typeof s !== 'object') return d;
    var out = { schema: SCHEMA, cameras: [], deer: [], pulls: [], pins: [], map: null, bait: [], preds: [], t3: null, settings: d.settings };
    var st = (s.settings && typeof s.settings === 'object') ? s.settings : {};
    ['license', 'deviceId', 'lastBackup', 'lastCam', 'installDismissed', 'createdAt'].forEach(function (k) { if (st[k] !== undefined) out.settings[k] = st[k]; });
    out.settings.lat = (st.lat === null || st.lat === undefined || st.lat === '') ? null : num(st.lat, -90, 90, null);
    out.settings.lng = (st.lng === null || st.lng === undefined || st.lng === '') ? null : num(st.lng, -180, 180, null);
    if (out.settings.lat === null || out.settings.lng === null) { out.settings.lat = null; out.settings.lng = null; }
    out.settings.shootMin = num(st.shootMin, 0, 90, 30);
    out.settings.gapMin = num(st.gapMin, 1, 240, 20);
    out.settings.lastCam = typeof out.settings.lastCam === 'string' ? out.settings.lastCam.slice(0, 40) : null;
    var SD = (window.BL_STATES && window.BL_STATES.states) || {};
    out.settings.states = (Array.isArray(st.states) ? st.states : []).filter(function (a, i, arr) { return typeof a === 'string' && SD.hasOwnProperty(a) && arr.indexOf(a) === i; }).slice(0, 10);
    out.settings.areas = {};
    if (st.areas && typeof st.areas === 'object') out.settings.states.forEach(function (a) { var r = SD[a].rut, v = st.areas[a]; if (r && r.areas && typeof v === 'string' && r.areas.some(function (x) { return x.name === v; })) out.settings.areas[a] = v; });
    out.settings.hideSmall = st.hideSmall === undefined ? true : !!st.hideSmall;
    out.settings.smallMax = num(st.smallMax, 0, 30, 5);
    out.settings.statesAsked = !!st.statesAsked;
    var seen = {};
    (Array.isArray(s.cameras) ? s.cameras : []).forEach(function (c) {
      if (!c || typeof c !== 'object') return;
      var id = clampStr(c.id || uid(), 40); if (seen[id]) return; seen[id] = 1;
      var zones = (Array.isArray(c.zones) ? c.zones : []).filter(function (z) { return z && typeof z === 'object'; }).slice(0, 8).map(function (z, i) { return { name: clampStr(z.name || ('View ' + (i + 1)), 30), facing: num(z.facing, 0, 359, 0) }; });
      out.cameras.push({ id: id, name: clampStr(c.name || 'Camera', 60), offsetMin: Math.round(num(c.offsetMin, -5256000, 5256000, 0)), created: num(c.created, 0, 1e14, Date.now()),
        facing: (c.facing === null || c.facing === undefined || c.facing === '') ? null : num(c.facing, 0, 359, null), rotating: !!c.rotating && zones.length > 0, zones: zones });
    });
    (Array.isArray(s.deer) ? s.deer : []).forEach(function (b) {
      if (!b || typeof b !== 'object') return;
      var id = clampStr(b.id || uid(), 40); if (seen[id]) return; seen[id] = 1;
      out.deer.push({ id: id, name: clampStr(b.name || 'Buck', 60), notes: clampStr(b.notes, 2000), created: num(b.created, 0, 1e14, Date.now()),
        points: (b.points === null || b.points === undefined || b.points === '') ? null : num(b.points, 0, 40, null), photo: typeof b.photo === 'string' ? b.photo.slice(0, 40) : null,
        renames: (Array.isArray(b.renames) ? b.renames : []).filter(function (r) { return r && typeof r === 'object'; }).slice(-50).map(function (r) { return { from: clampStr(r.from, 60), at: num(r.at, 0, 1e14, 0) }; }) });
    });
    (Array.isArray(s.pulls) ? s.pulls : []).forEach(function (u) {
      if (!u || typeof u !== 'object') return;
      out.pulls.push({ id: clampStr(u.id || uid(), 40), cam: clampStr(u.cam, 40), at: num(u.at, 0, 1e14, Date.now()), count: num(u.count, 0, 1e7, 0), noTime: num(u.noTime, 0, 1e7, 0) });
    });
    var L = out.settings.license;
    if (L && (typeof L !== 'object' || (L.ok && (!L.source || (L.source === 'dev' && !C.DEV_MODE))))) out.settings.license = null;
    L = out.settings.license;
    if (L && L.ok) {
      if (L.tier !== 'elite' && L.tier !== 'pro') L.tier = 'pro';
      if (L.upgrade && (typeof L.upgrade !== 'object' || !L.upgrade.key)) L.upgrade = null;
      if (L.tier === 'elite' && L.source === 'gumroad' && !L.upgrade && !L.product) L.tier = 'pro';
    }
    out.map = (window.BuckSim && s.map) ? window.BuckSim.clean(s.map) : null;
    var camOk = {}; out.cameras.forEach(function (c) { camOk[c.id] = 1; });
    var deerOk = {}; out.deer.forEach(function (b) { deerOk[b.id] = 1; });
    out.pins = window.BLPins ? window.BLPins.clean(s.pins, camOk, deerOk, uid) : [];   // Bring Your Pins (older data has none)
    (Array.isArray(s.bait) ? s.bait : []).slice(0, 2000).forEach(function (b) {
      if (!b || typeof b !== 'object' || !camOk[b.cam] || !/^\d{4}-\d\d-\d\d$/.test(String(b.day))) return;
      out.bait.push({ id: clampStr(b.id || uid(), 40), cam: b.cam, day: String(b.day), what: clampStr(b.what, 60) });
    });
    (Array.isArray(s.preds) ? s.preds : []).slice(0, 2000).forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var who = typeof p.who === 'string' && p.who ? p.who.slice(0, 40) : null;   // kept even if the buck/camera was removed later (shown as not scorable)
      if (!who || typeof p.cam !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(String(p.from)) || !/^\d{4}-\d\d-\d\d$/.test(String(p.to))) return;
      out.preds.push({ id: clampStr(p.id || uid(), 40), who: who, whoName: clampStr(p.whoName, 60), cam: p.cam.slice(0, 40), camName: clampStr(p.camName, 60), from: String(p.from), to: String(p.to),
        m0: Math.round(num(p.m0, 0, 1439, 0)), m1: Math.round(num(p.m1, 0, 1439, 0)), made: num(p.made, 0, 1e14, 0), basis: (Array.isArray(p.basis) ? p.basis : []).slice(0, 12).map(function (x) { return clampStr(x, 300); }),
        photosBefore: Math.round(num(p.photosBefore, 0, 1e8, 0)), lastAdded: num(p.lastAdded, 0, 1e14, 0), hash: /^[0-9a-f]{64}$/.test(String(p.hash)) ? p.hash : '' });
    });
    if (s.t3 && typeof s.t3 === 'object' && s.t3.box && typeof s.t3.box === 'object') {
      var bx = s.t3.box, la = num(bx.lat, 18, 72, null), lo = num(bx.lng, -180, -60, null);
      if (la !== null && lo !== null) out.t3 = { box: { lat: la, lng: lo, acres: num(bx.acres, 5, 5000, 160) }, parking: (Array.isArray(s.t3.parking) ? s.t3.parking : []).filter(function (p) { return p && Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < 20 && p.y < 26; }).slice(0, 6).map(function (p) { return { x: p.x, y: p.y }; }) };
    }
    return out;
  }
  function cleanPhoto(p, camIds, deerIds) {
    if (!p || typeof p !== 'object' || !p.id) return null;
    var tags = (Array.isArray(p.tags) ? p.tags : []).filter(function (t) { return KIND_LABEL[t]; });
    var dr = (Array.isArray(p.deer) ? p.deer : []).filter(function (d) { return deerIds[d]; });
    return {
      id: clampStr(p.id, 40), cam: camIds[p.cam] ? p.cam : null, pull: clampStr(p.pull, 40), name: clampStr(p.name, 200), size: num(p.size, 0, 1e11, 0),
      t: parseLocal(p.t) ? clampStr(p.t, 19) : null, tsrc: ['exif', 'stamp', 'file'].indexOf(p.tsrc) >= 0 ? p.tsrc : null,
      fileT: parseLocal(p.fileT) ? clampStr(p.fileT, 19) : null,
      tags: tags, deer: dr, done: !!p.done && (tags.length + dr.length > 0),
      thumb: p.thumb instanceof Blob ? p.thumb : null, added: num(p.added, 0, 1e14, Date.now()),
      temp: (p.temp === null || p.temp === undefined || p.temp === '') ? null : num(p.temp, -40, 130, null), tempSrc: p.tempSrc === 'ocr' ? 'ocr' : (p.temp !== null && p.temp !== undefined && p.temp !== '' ? 'typed' : null),
      dir: ['L', 'R', 'T', 'A'].indexOf(p.dir) >= 0 ? p.dir : null, zone: typeof p.zone === 'string' ? p.zone.slice(0, 30) : null,
      hash: /^[0-9a-f]{64}$/.test(String(p.hash)) ? p.hash : '', dh: /^[0-9a-f]{16}$/.test(String(p.dh)) ? p.dh : '', w: num(p.w, 0, 100000, 0), h: num(p.h, 0, 100000, 0),
      stamp: p.stamp && typeof p.stamp === 'object' ? { date: clampStr(p.stamp.date, 10), time: clampStr(p.stamp.time, 8), name: clampStr(p.stamp.name, 24) } : null
    };
  }
  var saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 120); }
  function flush() { clearTimeout(saveTimer); saveTimer = null; return DB ? kvPut('state', S).catch(function () { toast('Couldn’t save. Is your phone storage full?', 4000); }) : Promise.resolve(); }
  function cam(id) { for (var i = 0; i < S.cameras.length; i++) if (S.cameras[i].id === id) return S.cameras[i]; return null; }
  function deer(id) { for (var i = 0; i < S.deer.length; i++) if (S.deer[i].id === id) return S.deer[i]; return null; }
  function camName(id) { var c = cam(id); return c ? c.name : 'No camera'; }
  // Corrected time of a photo: recorded time + its camera's Clock Check correction.
  function eff(p) {
    var d = parseLocal(p.t); if (!d) return null;
    // The time printed on the photo comes from the same camera clock, so the correction applies to every source.
    var c = cam(p.cam); if (c && c.offsetMin) d = new Date(d.getTime() + c.offsetMin * 60000);
    return d;
  }
  function isSorted(p) { return p.done; }

  /* thumbnails: object URLs cached by id */
  var urlCache = {};
  function thumbURL(p) {
    if (!p || !p.thumb) return '';
    if (!urlCache[p.id]) { try { urlCache[p.id] = URL.createObjectURL(p.thumb); } catch (e) { return ''; } }
    return urlCache[p.id];
  }
  function dropURL(id) { if (urlCache[id]) { URL.revokeObjectURL(urlCache[id]); delete urlCache[id]; } }
  /* ---------------- EXIF (JPEG) date/time reader ---------------- */
  // Returns { dt: "YYYY-MM-DDTHH:MM:SS"|null, make, model } or null if no EXIF.
  function readExif(buf) {
    try {
      var v = new DataView(buf), len = v.byteLength;
      if (len < 4 || v.getUint16(0) !== 0xFFD8) return null;
      var off = 2;
      while (off + 4 <= len) {
        var marker = v.getUint16(off);
        if ((marker & 0xFF00) !== 0xFF00) return null;
        if (marker === 0xFFD9 || marker === 0xFFDA) return null;
        var segLen = v.getUint16(off + 2);
        if (marker === 0xFFE1 && off + 10 <= len && v.getUint32(off + 4) === 0x45786966 && v.getUint16(off + 8) === 0) return parseTiff(v, off + 10, Math.min(len, off + 2 + segLen));
        off += 2 + segLen;
      }
    } catch (e) {}
    return null;
  }
  function parseTiff(v, t, end) {
    var bo = v.getUint16(t); if (bo !== 0x4949 && bo !== 0x4D4D) return null;
    var le = bo === 0x4949;
    function u16(o) { return v.getUint16(o, le); }
    function u32(o) { return v.getUint32(o, le); }
    if (u16(t + 2) !== 42) return null;
    function ascii(entry) {
      var type = u16(entry + 2), count = u32(entry + 4);
      if (type !== 2 || count > 200) return '';
      var start = count <= 4 ? entry + 8 : t + u32(entry + 8), s = '';
      for (var i = 0; i < count && start + i < end; i++) { var ch = v.getUint8(start + i); if (ch === 0) break; s += String.fromCharCode(ch); }
      return s.trim();
    }
    function readIFD(o, want) {
      var out = {};
      if (o + 2 > end) return out;
      var n = u16(o); if (n > 500) return out;
      for (var i = 0; i < n; i++) {
        var e = o + 2 + i * 12; if (e + 12 > end) break;
        var tag = u16(e);
        if (want.indexOf(tag) >= 0) out[tag] = (tag === 0x8769) ? u32(e + 8) : ascii(e);
      }
      return out;
    }
    var ifd0 = readIFD(t + u32(t + 4), [0x010F, 0x0110, 0x0132, 0x8769]);
    var ex = ifd0[0x8769] ? readIFD(t + ifd0[0x8769], [0x9003, 0x9004]) : {};
    var dt = exifDate(ex[0x9003]) || exifDate(ex[0x9004]) || exifDate(ifd0[0x0132]);
    return { dt: dt, make: ifd0[0x010F] || '', model: ifd0[0x0110] || '' };
  }
  function exifDate(s) {
    var m = /^(\d{4})[:\-\/](\d{2})[:\-\/](\d{2})[ T](\d{2}):(\d{2}):?(\d{2})?/.exec(s || '');
    if (!m) return null;
    var y = +m[1], mo = +m[2], d = +m[3], h = +m[4], mi = +m[5], se = +(m[6] || 0);
    if (y < 1995 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || se > 59) return null;
    return m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + pad(se);
  }

  /* ---------------- sunrise / sunset (computed on the phone) ---------------- */
  // Sunrise/sunset (standard -0.833° altitude), after the well-known suncalc formulas.
  var RAD = Math.PI / 180, DAYMS = 864e5, J1970 = 2440588, J2000 = 2451545, OBL = RAD * 23.4397;
  function toDays(date) { return date.valueOf() / DAYMS - 0.5 + J1970 - J2000; }
  function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAYMS); }
  var sunCache = {};
  function sunTimes(date, lat, lng) {
    var key = date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate() + '|' + lat + '|' + lng;
    if (sunCache[key]) return sunCache[key];
    var noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0);
    var lw = RAD * -lng, phi = RAD * lat, d = toDays(noon);
    var n = Math.round(d - 0.0009 - lw / (2 * Math.PI));
    var ds = 0.0009 + lw / (2 * Math.PI) + n;
    var M = RAD * (357.5291 + 0.98560028 * ds);
    var Cc = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + Cc + RAD * 102.9372 + Math.PI;
    var dec = Math.asin(Math.sin(OBL) * Math.sin(L));
    var Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
    var cosw = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    var r;
    if (cosw > 1) r = { rise: null, set: null, polar: 'night' };
    else if (cosw < -1) r = { rise: null, set: null, polar: 'day' };
    else {
      var w = Math.acos(cosw);
      var a = 0.0009 + (w + lw) / (2 * Math.PI) + n;
      var Jset = J2000 + a + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
      r = { rise: fromJulian(Jnoon - (Jset - Jnoon)), set: fromJulian(Jset) };
    }
    sunCache[key] = r; return r;
  }
  function hasLoc() { return S.settings.lat !== null && S.settings.lng !== null; }
  // 'day' (sunrise..sunset), 'light' (shooting light: shootMin before sunrise / after sunset), 'dark', or null (no location set)
  function lightOf(d) {
    if (!d || !hasLoc()) return null;
    var st = sunTimes(d, S.settings.lat, S.settings.lng);
    if (st.polar) return st.polar === 'day' ? 'day' : 'dark';
    var t = d.getTime(), m = S.settings.shootMin * 60000;
    if (t >= st.rise.getTime() && t <= st.set.getTime()) return 'day';
    if ((t >= st.rise.getTime() - m && t < st.rise.getTime()) || (t > st.set.getTime() && t <= st.set.getTime() + m)) return 'light';
    return 'dark';
  }
  function sunNote(d) {
    if (!d || !hasLoc()) return '';
    var st = sunTimes(d, S.settings.lat, S.settings.lng); if (st.polar) return '';
    var t = d.getTime(), toR = Math.round((t - st.rise.getTime()) / 60000), toS = Math.round((t - st.set.getTime()) / 60000);
    function hm(x) { x = Math.abs(x); return x >= 60 ? Math.floor(x / 60) + ' hr ' + (x % 60) + ' min' : x + ' min'; }
    if (Math.abs(toR) <= Math.abs(toS)) return hm(toR) + (toR < 0 ? ' before' : ' after') + ' sunrise (' + fmtTime(st.rise) + ')';
    return hm(toS) + (toS < 0 ? ' before' : ' after') + ' sunset (' + fmtTime(st.set) + ')';
  }
  var LIGHT_LABEL = { day: 'Daylight', light: 'Shooting light', dark: 'Dark' };
  /* ---------------- License tiers: Free / Pro / Elite (Gumroad one-time keys) ----------------
   * Option A: ONE Gumroad product (GUMROAD_PRODUCT_ID) with versions named "Pro", "Elite", "Elite Upgrade".
   *           The version comes back in the verify reply as purchase.variants.
   * Option B: separate products (PRO_PRODUCT_ID / ELITE_PRODUCT_ID / UPGRADE_PRODUCT_ID).
   * An Elite Upgrade key only unlocks Elite when this phone already holds a valid Pro key (both re-checked). */
  function maskKey(k) { k = String(k || ''); return k.length > 8 ? k.slice(0, 4) + '…' + k.slice(-4) : k; }
  function tier() { var L = S.settings.license; return L && L.ok ? (L.tier === 'elite' ? 'elite' : 'pro') : 'free'; }
  function isPro() { return tier() !== 'free'; }
  function isElite() { return tier() === 'elite'; }
  var TIER_NAME = { free: 'Free', pro: 'Pro', elite: 'Elite' };
  function normCode(c) { return String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function products() {   // [{id, kind}] in the order keys are tried
    var out = [];
    if (C.GUMROAD_PRODUCT_ID) out.push({ id: C.GUMROAD_PRODUCT_ID, kind: 'versions' });
    if (C.ELITE_PRODUCT_ID) out.push({ id: C.ELITE_PRODUCT_ID, kind: 'elite' });
    if (C.PRO_PRODUCT_ID) out.push({ id: C.PRO_PRODUCT_ID, kind: 'pro' });
    if (C.UPGRADE_PRODUCT_ID) out.push({ id: C.UPGRADE_PRODUCT_ID, kind: 'upgrade' });
    return out;
  }
  function proOnSale() { return products().length > 0; }
  function tierOnSale(t) { return !!(C.GUMROAD_PRODUCT_ID || C[{ pro: 'PRO', elite: 'ELITE', upgrade: 'UPGRADE' }[t] + '_PRODUCT_ID']); }
  function checkoutFor(t) {
    var own = C[{ pro: 'PRO', elite: 'ELITE', upgrade: 'UPGRADE' }[t] + '_CHECKOUT_URL'];
    if (own && tierOnSale(t)) return own;
    return C.GUMROAD_PRODUCT_ID && C.CHECKOUT_URL ? C.CHECKOUT_URL : '';
  }
  function priceOf(t) { return C[{ pro: 'PRO', elite: 'ELITE', upgrade: 'UPGRADE' }[t] + '_PRICE'] || ''; }
  function camLimit() { var t = tier(); return t === 'elite' ? 0 : t === 'pro' ? (C.PRO_CAMERA_LIMIT || 0) : (C.FREE_CAMERA_LIMIT || 0); }
  function buckLimit() { var t = tier(); return t === 'elite' ? 0 : t === 'pro' ? (C.PRO_BUCK_LIMIT || 0) : (C.FREE_BUCK_LIMIT || 0); }
  function canAddCam() { var l = camLimit(); return !l || S.cameras.length < l; }
  function canAddBuck() { var l = buckLimit(); return !l || S.deer.length < l; }
  function sha256Hex(str) {
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    return Promise.resolve('');
  }
  function deviceId() { if (!S.settings.deviceId) { S.settings.deviceId = uid() + uid(); save(); } return S.settings.deviceId; }
  function supportLine() { return ' For help, contact the seller through your Gumroad receipt.'; }
  function gumroadVerify(productId, key, increment) {
    var body = new URLSearchParams();
    body.set('product_id', productId || '');
    body.set('license_key', key);
    body.set('increment_uses_count', increment ? 'true' : 'false');
    var ctrl = window.AbortController ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 15000);
    return fetch(C.LICENSE_VERIFY_URL || 'https://api.gumroad.com/v2/licenses/verify', { method: 'POST', body: body, signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' })
      .then(function (r) { clearTimeout(to); return r.json().catch(function () { return { success: false, message: 'Unexpected reply from Gumroad (HTTP ' + r.status + ').', _http: r.status }; }).then(function (j) { j._http = r.status; return j; }); })
      .catch(function (e) { clearTimeout(to); return { _network: true, message: String(e && e.message || e) }; });
  }
  function variantTier(v) {
    v = String(v || '').toLowerCase();
    if (/upgrade/.test(v)) return 'upgrade';
    if (/elite/.test(v)) return 'elite';
    if (/\bpro\b/.test(v)) return 'pro';
    return null;
  }
  function judge(j, prod) {
    if (!j || j._network) return { state: 'network', msg: 'Couldn’t reach Gumroad. Connect to the internet once to activate your key; after that it stays unlocked on this phone.' };
    if (!j.success) {
      if (j._http >= 500) return { state: 'network', msg: 'Gumroad is having trouble right now. Please try again in a few minutes.' };
      var m = String(j.message || '');
      if (/disabled|revoked/i.test(m)) return { state: 'revoked', msg: 'This license key has been disabled.' + supportLine() };
      return { state: 'invalid', msg: 'That key wasn’t recognized for ' + APP + '. Check it against your Gumroad receipt.' + supportLine() };
    }
    var pu = j.purchase || {};
    if (pu.refunded) return { state: 'revoked', msg: 'This purchase was refunded, so the key no longer unlocks anything.' + supportLine() };
    if (pu.chargebacked || (pu.disputed && !pu.dispute_won)) return { state: 'revoked', msg: 'This purchase was disputed or charged back, so the key no longer unlocks anything.' + supportLine() };
    if (pu.subscription_ended_at || pu.subscription_cancelled_at || pu.subscription_failed_at) return { state: 'revoked', msg: 'This purchase is no longer active.' + supportLine() };
    if (prod && pu.product_id && pu.product_id !== prod.id) return { state: 'invalid', msg: 'That key belongs to a different product.' };
    var t = prod && prod.kind !== 'versions' ? prod.kind : variantTier(pu.variants);
    // A versions product where the version can't be read: grant the lowest paid tier, never more.
    var guessed = false; if (!t) { t = 'pro'; guessed = true; }
    return { state: 'valid', tier: t, guessed: guessed, uses: typeof j.uses === 'number' ? j.uses : null, sale: pu.sale_id || pu.id || null, product: prod ? prod.id : null };
  }
  // Try each configured product until one recognizes the key (or says it was refunded/disabled).
  function verifyAny(key, increment, onlyProduct) {
    var list = products().filter(function (p) { return !onlyProduct || p.id === onlyProduct; }), i = 0, firstBad = null;
    function next() {
      if (i >= list.length) return Promise.resolve(firstBad || { state: 'invalid', msg: 'That key wasn’t recognized for ' + APP + '. Check it against your Gumroad receipt.' + supportLine() });
      var prod = list[i++];
      return gumroadVerify(prod.id, key, increment).then(function (j) {
        var r = judge(j, prod);
        if (r.state === 'valid' || r.state === 'revoked' || r.state === 'network') return r;
        if (!firstBad) firstBad = r;
        return next();
      });
    }
    return next();
  }
  function devUnlock(n) {
    if (!C.DEV_MODE) return Promise.resolve(false);
    return sha256Hex('buckledger:' + n).then(function (h) { return (C.DEV_UNLOCK_CODE_SHA256 || []).map(function (x) { return String(x).toLowerCase(); }).indexOf(h) !== -1; });
  }
  function tryUnlock(code) {
    var key = String(code || '').trim(), n = normCode(key);
    if (n.length < 4) return Promise.resolve({ ok: false, msg: 'Please enter your license key.' });
    return devUnlock(n).then(function (isDev) {
      if (isDev) { S.settings.license = { ok: true, tier: 'elite', key: key.toUpperCase(), at: Date.now(), source: 'dev', verifiedAt: Date.now() }; flush(); return { ok: true, msg: 'Dev unlock: Elite (DEV_MODE is on).' }; }
      if (!proOnSale()) return { ok: false, msg: 'Pro and Elite aren’t on sale yet, so keys can’t be checked. Please check back soon.' };
      if (navigator.onLine === false) return { ok: false, msg: 'You’re offline. Connect to the internet once to activate your key; after that it stays unlocked on this phone.' };
      var cur = S.settings.license;
      var sameMain = cur && cur.ok && cur.source === 'gumroad' && normCode(cur.key) === n;
      var sameUp = cur && cur.ok && cur.upgrade && normCode(cur.upgrade.key) === n;
      return verifyAny(key, !(sameMain || sameUp)).then(function (r) {
        if (r.state !== 'valid') {
          if (r.state === 'revoked' && sameMain) { S.settings.license = null; flush(); }
          else if (r.state === 'revoked' && sameUp) { cur.tier = 'pro'; cur.upgrade = null; flush(); }
          return { ok: false, msg: r.msg };
        }
        var max = C.MAX_ACTIVATIONS || 0;
        if (!(sameMain || sameUp) && max && r.uses !== null && r.uses > max) {
          return { ok: false, msg: 'This key has already been activated on ' + r.uses + ' devices (limit ' + max + '). If you got a new phone, contact the seller through your Gumroad receipt to reset it.' };
        }
        if (r.tier === 'upgrade') return applyUpgrade(key, r);
        var keepUp = sameMain && cur.upgrade && r.tier === 'pro' ? cur.upgrade : null;
        S.settings.license = { ok: true, tier: keepUp ? 'elite' : r.tier, key: key.toUpperCase(), at: (sameMain && cur.at) || Date.now(), source: 'gumroad', verifiedAt: Date.now(), uses: r.uses, sale: r.sale, product: r.product, device: deviceId(), upgrade: keepUp };
        flush();
        if (sameMain) return { ok: true, msg: 'Key re-checked. ' + TIER_NAME[tier()] + ' is active.' };
        return { ok: true, msg: (r.tier === 'elite' ? 'Elite unlocked: unlimited cameras and bucks, plus the 3D Terrain Sim.' : 'Pro unlocked: ' + C.PRO_CAMERA_LIMIT + ' cameras and ' + C.PRO_BUCK_LIMIT + ' named bucks.') + (r.guessed ? ' (Couldn’t read the version on this key, so it unlocked Pro. If you bought Elite, contact the seller through your Gumroad receipt.)' : '') + ' Good luck this season! 🦌' };
      });
    });
  }
  // Elite Upgrade: valid only on top of a valid Pro key on this phone. Re-check the Pro key right now too.
  function applyUpgrade(upKey, ru) {
    var cur = S.settings.license;
    if (!cur || !cur.ok || cur.source !== 'gumroad' || cur.tier === 'elite' && !cur.upgrade) {
      if (cur && cur.ok && cur.tier === 'elite' && !cur.upgrade) return Promise.resolve({ ok: false, msg: 'Elite is already unlocked on this phone. The upgrade key isn’t needed.' });
      return Promise.resolve({ ok: false, msg: 'That’s an Elite Upgrade key. It works on top of a Pro key: enter your Pro key first, then this upgrade key.' });
    }
    return verifyAny(cur.key, false, cur.product || null).then(function (rp) {
      if (rp.state === 'network') return { ok: false, msg: rp.msg };
      if (rp.state !== 'valid' || rp.tier !== 'pro') {
        if (rp.state === 'revoked') { S.settings.license = { ok: false, key: cur.key, revokedAt: Date.now(), reason: rp.msg }; flush(); }
        return { ok: false, msg: 'The upgrade needs a valid Pro key on this phone, and your Pro key didn’t check out. ' + (rp.msg || '') };
      }
      cur.verifiedAt = Date.now(); cur.tier = 'elite';
      cur.upgrade = { key: upKey.toUpperCase(), product: ru.product, verifiedAt: Date.now(), uses: ru.uses, sale: ru.sale };
      flush();
      return { ok: true, msg: 'Upgraded to Elite: unlimited cameras and bucks, plus the 3D Terrain Sim.' };
    });
  }
  function recheckLicense() {
    var L = S.settings.license, days = C.RECHECK_DAYS;
    if (!L || !L.ok || L.source !== 'gumroad' || !days || !proOnSale() || navigator.onLine === false) return Promise.resolve(null);
    if (L.verifiedAt && Date.now() - L.verifiedAt < days * DAYMS) return Promise.resolve(null);
    return verifyAny(L.key, false, L.product || null).then(function (r) {
      if (r.state === 'revoked') { S.settings.license = { ok: false, key: L.key, revokedAt: Date.now(), reason: r.msg }; save(); render(); toast(r.msg, 6000); return r.state; }
      if (r.state !== 'valid') return r.state;
      L.verifiedAt = Date.now(); if (r.uses !== null) L.uses = r.uses; save();
      if (!L.upgrade) return 'valid';
      return verifyAny(L.upgrade.key, false, L.upgrade.product || null).then(function (u) {
        if (u.state === 'revoked') { L.tier = 'pro'; L.upgrade = null; save(); render(); toast('Your Elite Upgrade is no longer active, so this phone is back to Pro.', 6000); }
        else if (u.state === 'valid') { L.upgrade.verifiedAt = Date.now(); save(); }
        return u.state;
      });
    });
  }

  /* ---------------- visits + reads ---------------- */
  var SUBJECTS = [['all', 'All deer'], ['bucks', 'All bucks'], ['doe', 'Does'], ['fawn', 'Fawns'], ['other', 'Other animals'], ['any', 'Everything']];
  function subjectLabel(sub) {
    if (sub.indexOf('deer:') === 0) { var b = deer(sub.slice(5)); return b ? b.name : 'Buck'; }
    for (var i = 0; i < SUBJECTS.length; i++) if (SUBJECTS[i][0] === sub) return SUBJECTS[i][1];
    return sub;
  }
  function matches(p, sub) {
    if (!p.done) return false;
    if (sub.indexOf('deer:') === 0) return p.deer.indexOf(sub.slice(5)) >= 0;
    if (sub === 'any') return p.tags.indexOf('empty') < 0;
    if (sub === 'all') return p.deer.length > 0 || p.tags.indexOf('buck') >= 0 || p.tags.indexOf('doe') >= 0 || p.tags.indexOf('fawn') >= 0;
    if (sub === 'bucks') return p.deer.length > 0 || p.tags.indexOf('buck') >= 0;
    return p.tags.indexOf(sub) >= 0;
  }
  // A visit = matching photos at one camera, each within gapMin minutes of the one before.
  function visits(sub, camFilter) {
    var gap = S.settings.gapMin * 60000, byCam = {}, noTime = 0;
    P.forEach(function (p) {
      if (!matches(p, sub) || (camFilter && p.cam !== camFilter)) return;
      var d = eff(p); if (!d) { noTime++; return; }
      (byCam[p.cam || '_'] = byCam[p.cam || '_'] || []).push({ p: p, d: d });
    });
    var out = [];
    Object.keys(byCam).forEach(function (k) {
      var cur = null;
      byCam[k].sort(function (a, b) { return a.d - b.d; }).forEach(function (x) {
        if (cur && x.d - cur.end <= gap) { cur.photos.push(x.p); cur.end = x.d; }
        else { cur = { cam: x.p.cam, d: x.d, end: x.d, photos: [x.p] }; out.push(cur); }
      });
    });
    out.forEach(function (v) { v.light = lightOf(v.d); });
    out.sort(function (a, b) { return b.d - a.d; });
    out.noTime = noTime;
    return out;
  }
  function whoOf(v) {
    var names = {}, kinds = {};
    v.photos.forEach(function (p) { p.deer.forEach(function (d) { var b = deer(d); if (b) names[b.name] = 1; }); p.tags.forEach(function (t) { if (t !== 'empty') kinds[t] = 1; }); });
    var n = Object.keys(names);
    if (n.length) { delete kinds.buck; }
    return n.concat(Object.keys(kinds).map(function (k) { return KIND_LABEL[k]; })).join(', ') || 'Unsorted';
  }
  function tally(vs) {
    var t = { n: vs.length, photos: 0, light: { day: 0, light: 0, dark: 0, none: 0 }, byCam: {}, litByCam: {}, mins: [] };
    vs.forEach(function (v) {
      t.photos += v.photos.length;
      t.light[v.light || 'none']++;
      var k = v.cam || '_';
      t.byCam[k] = (t.byCam[k] || 0) + 1;
      if (v.light === 'day' || v.light === 'light') t.litByCam[k] = (t.litByCam[k] || 0) + 1;
      t.mins.push(v.d.getHours() * 60 + v.d.getMinutes());
    });
    return t;
  }
  // Busiest window of `w` minutes (wrapping past midnight), counted from visit start times.
  function busiest(mins, w) {
    if (!mins.length) return null;
    var best = null;
    mins.forEach(function (m0) {
      var c = 0; mins.forEach(function (m) { var dd = (m - m0 + 1440) % 1440; if (dd < w) c++; });
      if (!best || c > best.c) best = { start: m0, c: c };
    });
    // tighten: end = last visit inside the window
    var end = best.start; mins.forEach(function (m) { var dd = (m - best.start + 1440) % 1440; if (dd < w && dd > (end - best.start + 1440) % 1440) end = m; });
    return { start: best.start, end: end, count: best.c };
  }
  function fmtMin(m) { m = ((m % 1440) + 1440) % 1440; var h = Math.floor(m / 60), mi = m % 60; return ((h % 12) || 12) + ':' + pad(mi) + ' ' + (h < 12 ? 'AM' : 'PM'); }
  function topKey(o) { var b = null; Object.keys(o).forEach(function (k) { if (b === null || o[k] > o[b]) b = k; }); return b; }
  function daysAgo(d) { var a = new Date(d); a.setHours(12, 0, 0, 0); var b = new Date(); b.setHours(12, 0, 0, 0); var n = Math.round((b - a) / DAYMS); return n <= 0 ? 'today' : n === 1 ? 'yesterday' : n + ' days ago'; }
  // The plain-English read for a buck (or any subject).
  function plainRead(vs) {
    var out = [];
    if (!vs.length) return out;
    var t = tally(vs), last = vs[0];
    out.push('Last on camera <b>' + esc(fmtDate(last.d)) + ' at ' + esc(fmtTime(last.d)) + '</b>, ' + esc(camName(last.cam)) + ' (' + daysAgo(last.d) + ').');
    out.push(plural(t.n, 'visit') + ' logged from ' + plural(t.photos, 'photo') + ', first ' + esc(fmtDate(vs[vs.length - 1].d)) + '.');
    if (hasLoc()) {
      var lit = t.light.day + t.light.light;
      out.push('<b>' + lit + ' of ' + t.n + '</b> in legal light' + (t.light.light ? ' (' + t.light.light + ' in the ' + S.settings.shootMin + '-minute edges around sunrise/sunset)' : '') + '; ' + t.light.dark + ' after dark.');
      var litV = vs.filter(function (v) { return v.light === 'day' || v.light === 'light'; });
      if (litV.length >= 2) {
        var lt = tally(litV), bw = busiest(lt.mins, 120), lc = topKey(lt.byCam);
        out.push('His daylight pattern: ' + (bw.count >= 2 ? '<b>' + bw.count + ' of ' + litV.length + '</b> daylight visits between <b>' + fmtMin(bw.start) + ' and ' + fmtMin(bw.end) + '</b>' : 'no repeat time yet') + (lc ? ', most at <b>' + esc(camName(lc === '_' ? null : lc)) + '</b>' : '') + '.');
      } else if (litV.length === 1) out.push('Only one daylight visit so far: ' + esc(fmtDate(litV[0].d)) + ' at ' + esc(fmtTime(litV[0].d)) + ', ' + esc(camName(litV[0].cam)) + '.');
      else out.push('No daylight visits yet. He’s been a night deer on your cameras.');
    } else {
      var bw2 = busiest(t.mins, 120);
      if (bw2 && bw2.count >= 2) out.push('Most visits between <b>' + fmtMin(bw2.start) + ' and ' + fmtMin(bw2.end) + '</b> (' + bw2.count + ' of ' + t.n + ').');
      out.push('<span class="muted">Add your property location in More to split daylight from dark.</span>');
    }
    var cams = Object.keys(t.byCam);
    if (cams.length > 1) { var tc = topKey(t.byCam); out.push('Shows up most at <b>' + esc(camName(tc === '_' ? null : tc)) + '</b> (' + t.byCam[tc] + ' of ' + t.n + ').'); }
    if (t.n < 5) out.push('<span class="muted">Fewer than 5 visits: treat this as an early hint, not a pattern.</span>');
    return out;
  }

  /* Day Ring: 24-hour dial. Midnight at the bottom, noon at the top. Night shaded from real sunrise/sunset. */
  function ringXY(cx, cy, r, min) { var a = min / 1440 * 2 * Math.PI; return [cx - r * Math.sin(a), cy + r * Math.cos(a)]; }
  function arcPath(cx, cy, r, m1, m2) {
    var p1 = ringXY(cx, cy, r, m1), p2 = ringXY(cx, cy, r, m2), large = ((m2 - m1 + 1440) % 1440) > 720 ? 1 : 0;
    return 'M' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
  }
  function dayRing(vs) {
    var cx = 150, cy = 150, R = 112, h = '<svg viewBox="0 0 300 300" role="img" aria-label="Day Ring: visits by time of day" id="day-ring">';
    var refDate = vs.length ? vs[Math.floor(vs.length / 2)].d : new Date();
    // light band: 96 slots of 15 minutes
    for (var i = 0; i < 96; i++) {
      var m = i * 15, cat = null;
      if (hasLoc()) cat = lightOf(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate(), Math.floor((m + 7) / 60), (m + 7) % 60));
      var col = cat === 'day' ? '#f3d98b' : cat === 'light' ? '#e7a35c' : cat === 'dark' ? '#3b4c7e' : '#d9cfb3';
      h += '<path d="' + arcPath(cx, cy, R, m, m + 15.5) + '" stroke="' + col + '" stroke-width="26" fill="none"/>';
    }
    [0, 360, 720, 1080].forEach(function (m, k) {
      var p = ringXY(cx, cy, R + 27, m);
      h += '<text x="' + p[0].toFixed(1) + '" y="' + (p[1] + 4).toFixed(1) + '" text-anchor="middle" font-size="12" font-weight="700" fill="#6b6553">' + ['12a', '6a', '12p', '6p'][k] + '</text>';
    });
    for (var t = 0; t < 24; t++) { var a1 = ringXY(cx, cy, R - 14, t * 60), a2 = ringXY(cx, cy, R - (t % 6 ? 18 : 22), t * 60); h += '<line x1="' + a1[0].toFixed(1) + '" y1="' + a1[1].toFixed(1) + '" x2="' + a2[0].toFixed(1) + '" y2="' + a2[1].toFixed(1) + '" stroke="#b3a988" stroke-width="1.5"/>'; }
    // visit dots, stacked inward when close together
    var placed = [];
    vs.slice().sort(function (a, b) { return (a.d.getHours() * 60 + a.d.getMinutes()) - (b.d.getHours() * 60 + b.d.getMinutes()); }).forEach(function (v) {
      var m = v.d.getHours() * 60 + v.d.getMinutes(), lane = 0;
      while (placed.some(function (q) { return q.lane === lane && Math.min(Math.abs(q.m - m), 1440 - Math.abs(q.m - m)) < 22; })) lane++;
      placed.push({ m: m, lane: lane });
      var p = ringXY(cx, cy, R - 34 - Math.min(lane, 6) * 11, m);
      var fill = v.light === 'day' ? '#b8860b' : v.light === 'light' ? '#c4621a' : v.light === 'dark' ? '#1f2c55' : '#4a4a3c';
      h += '<circle class="dot" cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="5.5" fill="' + fill + '" stroke="#fffaf0" stroke-width="1.5"><title>' + esc(fmtDate(v.d) + ' ' + fmtTime(v.d) + ' · ' + camName(v.cam)) + '</title></circle>';
    });
    h += '<text x="150" y="146" text-anchor="middle" font-size="30" font-weight="800" fill="#2a2b22" font-family="Georgia,serif">' + vs.length + '</text>';
    h += '<text x="150" y="166" text-anchor="middle" font-size="12" fill="#6b6553">' + (vs.length === 1 ? 'visit' : 'visits') + '</text></svg>';
    return h;
  }
  /* Season Strip: one square per day, gold if he showed in legal light that day, navy if only after dark. */
  function seasonStrip(vs) {
    if (!vs.length) return '';
    var byDay = {};
    vs.forEach(function (v) {
      var k = v.d.getFullYear() + '-' + v.d.getMonth() + '-' + v.d.getDate();
      var lit = v.light === 'day' || v.light === 'light';
      byDay[k] = byDay[k] === 'lit' || lit ? 'lit' : (v.light === 'dark' ? 'dk' : (byDay[k] || 'seen'));
    });
    var last = vs[0].d, first = vs[vs.length - 1].d;
    var end = new Date(Math.max(last, Math.min(Date.now(), last.getTime() + 14 * DAYMS))); end.setHours(12, 0, 0, 0);
    var start = new Date(first); start.setHours(12, 0, 0, 0); start = new Date(start.getTime() - 3 * DAYMS);
    if ((end - start) / DAYMS > 150) start = new Date(end.getTime() - 150 * DAYMS);
    var h = '<div class="strip" id="season-strip">', prevMo = -1;
    for (var d = new Date(start); d <= end; d = new Date(d.getTime() + DAYMS)) {
      d.setHours(12, 0, 0, 0);
      var k = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(), c = byDay[k];
      h += '<div class="sday ' + (c || '') + '" title="' + esc(fmtDate(d)) + '">' + (d.getMonth() !== prevMo ? '<span class="mo">' + MON[d.getMonth()] + '</span>' : '') + d.getDate() + '</div>';
      prevMo = d.getMonth();
    }
    return h + '</div>';
  }
  function lightMark(l) { return '<i class="mk ' + (l || 'none') + '"></i>'; }
  function legend() {
    return hasLoc() ? '<div class="legend"><span>' + lightMark('day') + 'Daylight</span><span>' + lightMark('light') + 'Shooting light (' + S.settings.shootMin + ' min edge)</span><span>' + lightMark('dark') + 'Dark</span></div>'
      : '<div class="legend"><span>' + lightMark(null) + 'Set your property location in <a href="#/more">More</a> to mark daylight, shooting light and dark.</span></div>';
  }

  /* ---------------- router ---------------- */
  var R = { view: '', id: '', q: {} };
  function parseHash() {
    var h = (location.hash || '#/').slice(1), qi = h.indexOf('?'), q = {};
    if (qi >= 0) { h.slice(qi + 1).split('&').forEach(function (kv) { var a = kv.split('='); if (a[0]) { try { q[decodeURIComponent(a[0])] = decodeURIComponent(a[1] || ''); } catch (e) {} } }); h = h.slice(0, qi); }
    var parts = h.replace(/^\/+/, '').split('/');
    var id = ''; try { id = parts[1] ? decodeURIComponent(parts[1]) : ''; } catch (e) {}
    return { view: parts[0] || 'ledger', id: id, q: q };
  }
  function go(h) { if (location.hash === h) render(); else location.hash = h; }
  window.addEventListener('hashchange', function (e) { var o = String(e && e.oldURL || '').split('#')[1] || ''; if (o.indexOf('/sim') !== 0) t3Day = null; render(); window.scrollTo(0, 0); });
  var VIEWS = {};
  function render() {
    if (!S) return;
    R = parseHash();
    if (R.view !== 'sim' || R.q.v === 'map') t3Day = null;
    if (simApi) { simApi.destroy(); simApi = null; }
    if (simDemo) { simDemo.destroy(); simDemo = null; }
    if (t3Api) { t3Api.destroy(); t3Api = null; }
    var v = VIEWS[R.view] || VIEWS.ledger, html;
    try { html = v(); } catch (e) { if (window.console) console.error(e); html = '<div class="panel">Something went wrong showing this screen. <a href="#/">Back to the Ledger</a></div>'; }
    $('#app').innerHTML = v.full ? html : '<main class="wrap">' + html + '</main>';
    renderNav(!!v.full);
    document.body.classList.toggle('full', !!v.full);
    if (v.after) v.after();
  }
  function unsortedCount() { var n = 0; P.forEach(function (p) { if (!p.done) n++; }); return n; }
  function noTimeCount() { var n = 0; P.forEach(function (p) { if (!p.t) n++; }); return n; }
  var ICONS = {
    ledger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M11 8h6M11 12h6M11 16h4"/></svg>',
    sort: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M6 20h4M14 20h4"/></svg>',
    bucks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8 3c-2 2-2 5 0 7M16 3c2 2 2 5 0 7M8 10c1 1 2 1.5 4 1.5s3-.5 4-1.5M9 12c0 4 1.3 8 3 8s3-4 3-8"/></svg>',
    cams: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="3" width="12" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M10 16h4"/></svg>',
    sim: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M6 17c3-1 4-6 7-7s4 1 5-3"/><circle cx="17" cy="16" r="2"/></svg>',
    more: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>'
  };
  function renderNav(hidden) {
    var nav = $('#nav'); nav.className = hidden ? 'hide' : '';
    if (hidden) { nav.innerHTML = ''; return; }
    var u = unsortedCount();
    var items = [['ledger', '#/', 'Ledger'], ['sort', '#/sort', 'Sort Pass'], ['bucks', '#/bucks', 'Bucks'], ['cams', '#/cams', 'Cameras'], ['sim', '#/sim', 'Simulator'], ['more', '#/more', 'More']];
    var on = { buck: 'bucks', photo: 'ledger', pull: 'ledger', stamp: 'ledger', clock: 'cams', cam: 'cams', predict: 'bucks', states: 'more', research: 'more', pins: 'more', pinhow: 'more', tcl: 'more' }[R.view] || R.view;
    nav.innerHTML = items.map(function (it) {
      return '<a href="' + it[1] + '" class="' + (on === it[0] ? 'on' : '') + '" data-nav="' + it[0] + '">' + ICONS[it[0]] + it[2] + (it[0] === 'sort' && u ? '<span class="badge">' + (u > 999 ? '999+' : u) + '</span>' : '') + '</a>';
    }).join('');
  }
  function head(title, back, cls) { return '<div class="head">' + (back ? '<a class="back" href="' + back + '">‹ Back</a>' : '') + '<h1 class="' + (cls || '') + '">' + esc(title) + '</h1></div>'; }
  function filesTip() {
    return '<div class="tip" id="files-tip"><b>Keep each photo’s date &amp; time:</b> ' + (isIOS()
      ? 'on iPhone, tap <b>Choose Files</b> or <b>Browse</b> and pick from the <b>Files</b> app or your SD card reader. Picking from the Photos library can strip the time.'
      : 'pick from your <b>Files</b> app or SD card reader when you can. Some gallery pickers strip the time.') +
      ' If a camera only prints the time on the picture, the Stamp Reader helps you type it in.</div>';
  }

  /* ---------------- The Ledger (main screen) ---------------- */
  var ledgerF = { who: 'all', cam: '' }, ledgerLimit = 80;
  VIEWS.ledger = function () {
    var h = '<div class="head"><h1 class="brand">' + esc(APP) + '</h1></div>';
    if (!P.length) {
      return h + '<div class="paper welcome"><div class="big">📒</div><h2 style="font-family:Georgia,serif">Your trail cam logbook</h2>' +
        '<p class="muted">It fills itself in from your SD card. Photos never leave this phone. No account, no subscription.</p>' +
        '<ol class="steps"><li><b>Log a Pull:</b> pick a camera and the photos from its card.</li><li><b>Sort Pass:</b> one photo at a time, tap who it is.</li><li><b>Read the Ledger:</b> every visit, when and where, in daylight or dark.</li></ol>' +
        '<a class="btn go block" href="#/pull" data-act="first-pull">Log your first Pull</a><a class="btn ink block" style="margin-top:8px" href="#/bulk" id="first-bulk">Lots of photos? Bulk import reads the stamps for you</a></div>' + filesTip() + installNote();
    }
    var u = unsortedCount(), nt = noTimeCount();
    h += '<div class="actions"><a class="act main" href="#/pull"><b>Log a Pull</b><span>add photos</span></a>' +
      '<a class="act ' + (u ? 'hot' : '') + '" href="#/sort" id="act-sort"><b>Sort Pass</b><span>' + (u ? u + ' waiting' : 'all sorted ✓') + '</span></a>' +
      '<a class="act ' + (nt ? 'hot' : '') + '" href="#/stamp" id="act-stamp"><b>Stamp Reader</b><span>' + (nt ? nt + ' need a time' : 'all timed ✓') + '</span></a></div>';
    h += '<a class="act" href="#/bulk" id="act-bulk" style="margin:-4px 0 12px"><b>Bulk import</b><span>Pick up to ' + BULK_MAX + ' photos. Dates, times and temps are read for you.</span></a>';
    if (!S.settings.states.length && !S.settings.statesAsked) h += '<div class="panel small" id="state-prompt">📍 <b>Where do you hunt?</b> Pick your state for rut timing and acorn info. <a class="btn sm go" href="#/states">Pick state</a> <button class="btn sm plain" data-act="states-later">Later</button></div>';
    var whoOpts = SUBJECTS.concat(visibleDeer().map(function (b) { return ['deer:' + b.id, '★ ' + b.name]; }));
    if (!whoOpts.some(function (o) { return o[0] === ledgerF.who; })) ledgerF.who = 'all';
    if (ledgerF.cam && !cam(ledgerF.cam)) ledgerF.cam = '';
    h += '<div class="filters"><select id="f-who" aria-label="Who">' + whoOpts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === ledgerF.who ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>' +
      '<select id="f-cam" aria-label="Camera"><option value="">All cameras</option>' + S.cameras.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === ledgerF.cam ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></div>';
    var vs = visits(ledgerF.who, ledgerF.cam);
    h += legend();
    // interleave Pull entries (by when they were logged) with visits (by when they happened)
    var pulls = S.pulls.filter(function (u2) { return !ledgerF.cam || u2.cam === ledgerF.cam; }).map(function (u2) { return { pull: u2, d: new Date(u2.at) }; });
    var rows = vs.slice(0, ledgerLimit).map(function (v) { return { v: v, d: v.d }; }).concat(pulls).sort(function (a, b) { return b.d - a.d; });
    if (!vs.length) {
      h += '<div class="paper"><p style="margin:0">' + (u ? 'No visits yet for <b>' + esc(subjectLabel(ledgerF.who)) + '</b>. <a href="#/sort">Run a Sort Pass</a> to tag the ' + plural(u, 'photo') + ' waiting.' : 'No visits for <b>' + esc(subjectLabel(ledgerF.who)) + '</b>' + (ledgerF.cam ? ' at this camera' : '') + ' yet.') + '</p></div>';
    }
    h += '<div class="ledger" id="ledger">';
    var lastDay = '';
    rows.forEach(function (r) {
      if (r.pull) {
        h += '<div class="lpull" data-pull="' + esc(r.pull.id) + '">📥 <span><b>Pull logged</b> · ' + esc(camName(r.pull.cam)) + ' · ' + plural(r.pull.count, 'photo') + ' · ' + esc(fmtDate(r.d)) + '</span></div>';
        lastDay = ''; return;
      }
      var v = r.v, dk = fmtDate(v.d);
      if (dk !== lastDay) { h += '<div class="lday">' + esc(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][v.d.getDay()] + ', ' + dk) + '</div>'; lastDay = dk; }
      var cover = v.photos[0];
      h += '<button class="lrow" data-visit="' + esc(cover.id) + '" data-sub="' + esc(ledgerF.who) + '"><span class="tm">' + esc(fmtTime(v.d).replace(' ', '')) + '</span>' + lightMark(v.light) +
        '<span class="who"><b>' + esc(whoOf(v)) + '</b><span>' + esc(camName(v.cam)) + (v.light ? ' · ' + LIGHT_LABEL[v.light] : '') + '</span></span>' +
        '<span class="n">' + (v.photos.length > 1 ? '×' + v.photos.length : '') + '</span>' + (cover.thumb ? '<img alt="" loading="lazy" src="' + thumbURL(cover) + '">' : '') + '</button>';
    });
    h += '</div>';
    if (vs.length > ledgerLimit) h += '<button class="btn block" style="margin-top:10px" data-act="more-rows">Show older visits (' + (vs.length - ledgerLimit) + ' more)</button>';
    if (vs.noTime) h += '<p class="small muted" style="margin-top:8px">' + plural(vs.noTime, 'tagged photo') + ' left out: no time yet. <a href="#/stamp">Stamp Reader</a></p>';
    if (!S.settings.lastBackup && P.length >= 25) h += '<div class="panel small" style="margin-top:12px">💾 Your ledger lives only on this phone. <a href="#/more">Save a backup file</a> now and then.</div>';
    return h + installNote();
  };
  VIEWS.ledger.after = function () {
    var fw = $('#f-who'), fc = $('#f-cam');
    if (fw) fw.addEventListener('change', function () { ledgerF.who = fw.value; ledgerLimit = 80; render(); });
    if (fc) fc.addEventListener('change', function () { ledgerF.cam = fc.value; ledgerLimit = 80; render(); });
  };
  function visitSheet(coverId, sub) {
    var vs = visits(sub || 'any'), v = null;
    vs.some(function (x) { if (x.photos.some(function (p) { return p.id === coverId; })) { v = x; return true; } return false; });
    if (!v) return;
    var note = sunNote(v.d);
    sheet('<h2 style="font-family:Georgia,serif">' + esc(whoOf(v)) + '</h2><p class="muted" style="margin-bottom:6px">' + esc(fmtDate(v.d)) + ' · ' + esc(fmtTime(v.d)) + (v.photos.length > 1 ? '–' + esc(fmtTime(v.end)) : '') + ' · ' + esc(camName(v.cam)) + '</p>' +
      '<p class="small">' + lightMark(v.light) + ' ' + (v.light ? LIGHT_LABEL[v.light] : 'Light unknown (no property location)') + (note ? ' · ' + esc(note) : '') + '</p>' + visitDetails(v, sub) +
      '<div class="pgrid">' + v.photos.map(function (p) { var d = eff(p); return '<a href="#/photo/' + encodeURIComponent(p.id) + '" data-x="close">' + (p.thumb ? '<img alt="" src="' + thumbURL(p) + '">' : '') + '<span class="cap">' + esc(d ? fmtTime(d) : '') + '</span></a>'; }).join('') + '</div>' +
      '<div class="btn-row" style="margin-top:12px"><button class="btn ink" data-x="close">Close</button></div>', function (x) { if (x === 'close') { closeSheet(); return false; } });
  }
  var deferredInstall = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); deferredInstall = e; });
  function installNote() {
    if (isStandalone() || S.settings.installDismissed) return '';
    return '<div class="panel small" id="install-note" style="margin-top:12px"><b>Put it on your home screen</b> so it opens like an app. ' +
      (isIOS() ? 'In Safari tap <b>Share</b> → <b>Add to Home Screen</b>.' : (deferredInstall ? '<button class="btn sm" data-act="install">Install</button>' : 'Browser menu (⋮) → <b>Add to Home screen</b>.')) +
      ' <button class="btn sm plain" data-act="install-dismiss">Got it</button></div>';
  }

  /* ---------------- Log a Pull ---------------- */
  var pullState = null; // { running, finished, total, done, added, dup, skipped, noTime, failedThumb, pull, cam }
  VIEWS.pull = function () {
    var h = head('Log a Pull', '#/');
    if (pullState && pullState.running) {
      return h + '<div class="paper"><h3>Logging the pull…</h3><p class="muted small" id="pull-status">' + pullState.done + ' of ' + pullState.total + '</p><div class="progress"><i id="pull-bar" style="width:' + (pullState.total ? pullState.done / pullState.total * 100 : 0) + '%"></i></div><p class="small muted" style="margin:0">Keep this screen open. Photos are shrunk and kept on this phone only.</p></div>';
    }
    if (pullState && pullState.finished) {
      var r = pullState;
      return h + '<div class="paper" id="pull-result"><h3 style="font-family:Georgia,serif">Pull logged: ' + plural(r.added, 'photo') + ' from ' + esc(camName(r.cam)) + '</h3><ul class="small" style="padding-left:18px;margin:6px 0 12px">' +
        (r.dup && window.BLDedup ? '<li style="list-style:none;margin-left:-18px">' + BLDedup.reviewHtml(r.dups, r.dupOpen) + '</li>' : r.dup ? '<li>' + plural(r.dup, 'duplicate') + ' skipped (already in your ledger)</li>' : '') +
        (r.skipped ? '<li>' + plural(r.skipped, 'file') + ' skipped (videos or not photos)</li>' : '') +
        (r.failedThumb ? '<li>' + plural(r.failedThumb, 'photo') + ' couldn’t be opened by this browser (kept without a picture)</li>' : '') +
        (r.noTime ? '<li><b>' + plural(r.noTime, 'photo') + ' had no date/time in the file.</b> Use the Stamp Reader to type the time printed on them.</li>' : (r.added ? '<li>Every photo had a date and time ✓</li>' : '')) + '</ul>' +
        (r.added ? '<a class="btn go block" href="#/sort">Start the Sort Pass</a>' : '') +
        '<div class="btn-row" style="margin-top:8px">' + (r.noTime ? '<a class="btn ink" href="#/stamp">Stamp Reader</a>' : '') + (r.added ? '<a class="btn ink" href="#/clock/' + encodeURIComponent(r.cam) + '">Clock Check</a>' : '') + '<button class="btn ink" data-act="pull-again">Log another</button></div>' +
        (r.added ? '<p class="tiny muted" style="margin:8px 0 0">Clock Check: if this camera’s clock was off (batteries pulled, daylight saving), fix the whole camera from one photo.</p>' : '') + '</div>';
    }
    var opts = S.cameras.map(function (c) { return '<option value="' + esc(c.id) + '"' + (S.settings.lastCam === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
    var canNew = canAddCam();
    h += '<a class="btn ink block" id="pull-bulk" style="margin:0 0 10px" href="#/bulk">⚡ Many photos? Bulk import reads the dates, times and temps for you</a>';
    h += '<div class="paper"><label class="field"><span>Which camera is this card from?</span><select id="pull-cam">' + opts + (canNew ? '<option value="__new"' + (!S.cameras.length ? ' selected' : '') + '>＋ New camera…</option>' : '') + '</select></label>' +
      '<label class="field" id="pull-new-wrap" style="display:' + (!S.cameras.length ? 'block' : 'none') + '"><span>Camera name</span><input type="text" id="pull-new" maxlength="60" placeholder="e.g. Creek crossing, Food plot, Stand East"></label>' +
      (!canNew ? '<p class="small muted">' + freeLine('cam') + '</p>' : '') +
      '<button class="btn go block" data-act="pick-photos">Choose photos</button><input type="file" id="pull-file" accept="image/*" multiple hidden>' +
      '<p class="small muted" style="margin:10px 0 0">Select all the photos from this card at once. Nothing is uploaded. Duplicates are skipped, so re-picking the same card is safe.</p></div>' + filesTip();
    return h;
  };
  VIEWS.pull.after = function () {
    var sel = $('#pull-cam'); if (!sel) return;
    sel.addEventListener('change', function () { $('#pull-new-wrap').style.display = sel.value === '__new' ? 'block' : 'none'; });
    $('#pull-file').addEventListener('change', function (e) {
      var files = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
      if (!files.length) return;
      var camId = sel.value;
      if (camId === '__new') {
        var name = ($('#pull-new').value || '').trim();
        if (!name) { toast('Name the camera first'); return; }
        camId = addCamera(name); if (!camId) return;
      }
      runPull(files, camId);
    });
  };
  function freeLine(kind) {
    var t = tier(), lim = kind === 'cam' ? camLimit() : buckLimit(), noun = kind === 'cam' ? 'camera' : 'named buck';
    return 'The ' + TIER_NAME[t] + ' version keeps ' + plural(lim, noun) + '. ' + (t === 'free' ? '<a href="#/more">Pro</a> keeps ' + plural(kind === 'cam' ? C.PRO_CAMERA_LIMIT : C.PRO_BUCK_LIMIT, noun) + '; <a href="#/more">Elite</a> is unlimited.' : '<a href="#/more">Elite</a> is unlimited.');
  }
  function addCamera(name) {
    if (!canAddCam()) { proSheet('cam'); return null; }
    var c = { id: uid(), name: clampStr(String(name).trim() || 'Camera', 60), offsetMin: 0, created: Date.now(), facing: null, rotating: false, zones: [] };
    S.cameras.push(c); save(); return c.id;
  }
  function addBuck(name) {
    if (!canAddBuck()) { proSheet('buck'); return null; }
    var b = { id: uid(), name: clampStr(String(name).trim() || 'Buck', 60), notes: '', created: Date.now(), points: null, photo: null, renames: [] };
    S.deer.push(b); save(); return b.id;
  }
  function readHead(file, n) {
    var blob = file.slice(0, n);
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsArrayBuffer(blob); });
  }
  function makeThumb(file) {
    return new Promise(function (res) {
      var url; try { url = URL.createObjectURL(file); } catch (e) { return res(null); }
      var img = new Image(), done = false;
      var to = setTimeout(function () { if (!done) { done = true; URL.revokeObjectURL(url); res(null); } }, 20000);
      img.onload = function () {
        if (done) return; done = true; clearTimeout(to);
        try {
          var max = 1280, w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob(function (b) { res(b); }, 'image/jpeg', 0.8);
        } catch (e) { URL.revokeObjectURL(url); res(null); }
      };
      img.onerror = function () { if (done) return; done = true; clearTimeout(to); URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  function isImageFile(f) { return /^image\//.test(f.type || '') || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || ''); }
  function runPull(files, camId, force) {
    S.settings.lastCam = camId; save();
    var pull = { id: uid(), cam: camId, at: Date.now(), count: 0, noTime: 0 };
    var seen = {}; P.forEach(function (p) { seen[p.name + '|' + p.size + '|' + (p.tsrc === 'exif' ? p.t : '')] = 1; });
    var dIdx = force || !window.BLDedup ? null : BLDedup.buildIndex(P);
    pullState = { running: true, dups: [], dupOpen: false, force: !!force, total: files.length, done: 0, added: 0, dup: 0, skipped: 0, noTime: 0, failedThumb: 0, pull: pull.id, cam: camId };
    if (R.view !== 'pull') go('#/pull'); else render();
    var pending = [];
    function upd() { var s = $('#pull-status'), b = $('#pull-bar'); if (s) s.textContent = pullState.done + ' of ' + pullState.total; if (b) b.style.width = (pullState.done / pullState.total * 100) + '%'; }
    function flushPending() { if (!pending.length) return Promise.resolve(); var chunk = pending; pending = []; return photosPutMany(chunk); }
    var i = 0;
    function next() {
      if (i >= files.length) return flushPending().then(finish);
      var f = files[i++];
      if (!isImageFile(f)) { pullState.skipped++; pullState.done++; upd(); return next(); }
      return readHead(f, 262144).then(function (buf) { return readExif(buf); }, function () { return null; }).then(function (ex) {
        var dt = ex && ex.dt;
        var key = f.name + '|' + f.size + '|' + (dt || '');
        if (seen[key] && !force) { pullState.dup++; pullState.dups.push({ file: f, name: f.name, why: 'exif', ofName: '' }); return null; }
        seen[key] = 1;
        var fpP = window.BLDedup ? BLDedup.fingerprint(f, { exifT: dt || null, camId: camId }) : Promise.resolve(null);
        return fpP.then(function (fp) {
          if (fp && dIdx) {
            var m = BLDedup.match(dIdx, fp);
            if (m) { pullState.dup++; pullState.dups.push({ file: f, name: f.name, why: m.why, ofName: m.of.name || '' }); return null; }
          }
          return makeThumb(f).then(function (thumb) { return saveOne(thumb, fp); });
        });
        function saveOne(thumb, fp) {
          if (!thumb) pullState.failedThumb++;
          if (!dt) pullState.noTime++;
          var fd = f.lastModified ? new Date(f.lastModified) : null;
          var p = { id: uid(), cam: camId, pull: pull.id, name: clampStr(f.name, 200), size: f.size || 0, t: dt || null, tsrc: dt ? 'exif' : null,
            fileT: fd && !isNaN(fd) ? toLocalStr(fd) : null, tags: [], deer: [], done: false, thumb: thumb, added: Date.now() };
          if (fp) { var fl = BLDedup.fields(fp); p.hash = fl.hash; p.dh = fl.dh; p.tv = fl.tv; p.w = fl.w; p.h = fl.h; if (dIdx) BLDedup.add(dIdx, BLDedup.entryFromFp(fp, { id: p.id, name: p.name })); }
          P.push(p); PI[p.id] = p; pending.push(p); pullState.added++;
          if (pending.length >= 10) return flushPending();
        }
      }).then(function () { pullState.done++; upd(); return next(); }, function () { pullState.done++; upd(); return next(); });
    }
    function finish() {
      pull.count = pullState.added; pull.noTime = pullState.noTime;
      if (pull.count) S.pulls.push(pull);
      save(); pullState.running = false; pullState.finished = true;
      if (R.view === 'pull') render(); else renderNav();
    }
    requestPersist();
    return next().catch(function () { pullState.running = false; pullState.finished = true; save(); toast('The pull stopped early. Is your phone storage full?', 5000); render(); });
  }
  function requestPersist() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persisted().then(function (p) { if (!p) return navigator.storage.persist(); }).catch(function () {}); } catch (e) {}
  }

  /* ---------------- Bulk import ---------------- */
  // Pick up to BULK_MAX photos at once. Each one is decoded once (thumbnail + stamp read), one photo at a time with a pause
  // between photos so the screen stays alive; the OCR itself runs in its own worker thread. Everything stays on this phone.
  var BULK_MAX = 300, GROUP_S = 120, OUTLIER_DAYS = 45;
  var bulk = null;
  function bulkFree() { if (bulk) { bulk.items.forEach(function (it) { if (it.mini) { try { URL.revokeObjectURL(it.mini); } catch (e) {} it.mini = null; } }); } }
  function ymdT(s) { var d = parseLocal(s); return d ? d.getTime() : null; }
  function lev1(a, b) {
    if (a === b) return true; if (Math.abs(a.length - b.length) > 1) return false;
    var i = 0, j = 0, e = 0;
    while (i < a.length && j < b.length) { if (a[i] === b[j]) { i++; j++; continue; } if (++e > 1) return false; if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; } }
    return e + (a.length - i) + (b.length - j) <= 1;
  }
  function nameKey(s) { return normName(s).replace(/FI/g, 'H'); }   // FI is often read as H
  function lev(a, b) {
    var p = [], i, j; for (j = 0; j <= b.length; j++) p[j] = j;
    for (i = 1; i <= a.length; i++) { var q = [i]; for (j = 1; j <= b.length; j++) q[j] = Math.min(p[j] + 1, q[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = q; }
    return p[b.length];
  }
  function nameSame(a, b) {
    var x = nameKey(a), y = nameKey(b), m = Math.min(x.length, y.length);
    if (m < 4) return x === y && m > 0;
    return x.indexOf(y) >= 0 || y.indexOf(x) >= 0 || (m >= 5 && lev(x, y) <= 2);
  }
  function normName(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  function ensureOcr() { return window.BLOcr ? Promise.resolve() : new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = 'ocr.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); }
  function bulkLoad(f) {
    return new Promise(function (res) {
      var url; try { url = URL.createObjectURL(f); } catch (e) { return res(null); }
      var img = new Image(), done = false;
      var to = setTimeout(function () { if (!done) { done = true; URL.revokeObjectURL(url); res(null); } }, 20000);
      img.onload = function () { if (done) return; done = true; clearTimeout(to); res({ img: img, url: url }); };
      img.onerror = function () { if (done) return; done = true; clearTimeout(to); URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  function imgBlob(img, max, q) {
    return new Promise(function (res) {
      try {
        var w = img.naturalWidth, h = img.naturalHeight, s = Math.min(1, max / Math.max(w, h)), c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); c.toBlob(function (b) { res(b); }, 'image/jpeg', q);
      } catch (e) { res(null); }
    });
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function bulkNote(it, s) { it.notes.push(s); }
  // EXIF time counts only when it is a real, non-reset, non-future date (cameras with a dead clock battery write 1970/2000/0000)
  function exifPlausible(dt) {
    if (!dt || dt.length < 16) return false;
    var y = +dt.slice(0, 4), d = parseLocal(dt); if (!d) return false;
    return y >= 2002 && d.getTime() <= Date.now() + DAYMS;
  }
  var CROSS_MS = 2 * 60000;
  function bulkInterpret(it, v) {
    var ex = it.dt && exifPlausible(it.dt) ? it.dt : null, exT = ex ? ymdT(ex) : null;
    // a temperature only counts from a credible stamp: date and time both read, or the °F and °C agree (noise in a plain photo can look like a number)
    if (v && v.temp !== null && v.temp !== undefined && ((v.date && v.time) || v.tempSure)) { it.temp = v.temp; it.tempSrc = 'ocr'; if (v.tempDisagree && !v.tempSure) it.tempFlag = true; }
    if (v && v.name) it.camText = v.name;
    it.raw = v ? v.raw : ''; it.order = v && v.order ? v.order : null; it.dateFixed = !!(v && v.dateFixed);
    var hasStamp = !!(v && v.date && v.time);
    if (hasStamp) it.stampT = v.date + 'T' + v.time;
    if (ex && hasStamp) {
      // EXIF first; the printed stamp is the cross-check. The stamp has no seconds, so compare the minute it printed with the file time.
      var df = Math.abs(exT - ymdT(it.stampT));
      it.t = ex; it.tsrc = 'exif'; it.secKnown = ex.length >= 19;
      if (df <= CROSS_MS) { it.conf = 'ok'; it.stampAgree = true; }
      else {
        it.conf = 'check'; it.alt = it.stampT; it.altSrc = 'stamp';
        it.notes = ['The file says ' + fmtDate(parseLocal(ex)) + ' ' + fmtTime(parseLocal(ex)) + ', the stamp says ' + fmtDate(parseLocal(it.stampT)) + ' ' + fmtTime(parseLocal(it.stampT)) + '. The camera clock may be wrong.'];
      }
      if (it.tempFlag) { it.conf = 'check'; bulkNote(it, 'Check the temp.'); }
    } else if (hasStamp) {
      it.t = it.stampT; it.tsrc = 'stamp'; it.conf = v.agreed ? 'ok' : 'check';
      if (!v.agreed) bulkNote(it, 'Digits read only once. Check the date and time.');
      // the stamp has no seconds: take them from the file date when the minute is the same
      var mn = it.t.slice(0, 16);
      if (it.fileT && it.fileT.length >= 19 && it.fileT.slice(0, 16) === mn) { it.t = it.fileT; it.secKnown = true; }
      if (it.tempFlag) { it.conf = 'check'; bulkNote(it, 'Check the temp.'); }
      if (it.dateFixed && it.conf === 'ok') { it.conf = 'check'; bulkNote(it, 'One digit of the date looked off and was corrected. Check it.'); }
    } else if (ex) {
      it.t = ex; it.tsrc = 'exif'; it.secKnown = ex.length >= 19; it.conf = 'ok'; bulkNote(it, v && v.time ? 'Stamp date not readable; used the time saved in the photo file.' : 'Used the time saved in the photo file.');
    } else {
      it.conf = 'none'; it.partialTime = v && v.time ? v.time : ''; it.partialDate = v && v.date ? v.date : '';
      bulkNote(it, it.noPic ? 'This browser can’t open the picture, and the file has no time.' : 'No readable stamp and no time in the file. Type it below, or leave it for the Stamp Reader.');
    }
  }
  function bulkFinalize() {
    var b = bulk, items = b.items, timed = items.filter(function (i) { return i.t; }).map(function (i) { return ymdT(i.t); }).sort(function (x, y) { return x - y; });
    // camera names printed on the stamps: reads that are close (H/FI mix-ups, a letter or two off, one inside the other, e.g. FIELD / SW FIELD) are one name; only names seen on 3+ photos count
    var cnt = {}; items.forEach(function (it) { if (it.camText) cnt[it.camText] = (cnt[it.camText] || 0) + 1; });
    var keys = Object.keys(cnt).sort(function (x, y) { return cnt[y] - cnt[x] || y.length - x.length; }), canon = {}, tot = {};
    keys.forEach(function (k) { var m = null; Object.keys(tot).forEach(function (o) { if (!m && nameSame(o, k)) m = o; }); if (m) { tot[m] += cnt[k]; canon[k] = m; } else { tot[k] = cnt[k]; canon[k] = k; } });
    b.names = {}; Object.keys(tot).forEach(function (k) { if (tot[k] >= 3) b.names[k] = tot[k]; });
    items.forEach(function (it) { it.camName = it.camText && b.names[canon[it.camText]] ? canon[it.camText] : ''; });
    Object.keys(b.names).forEach(function (nm) {
      var hits = S.cameras.filter(function (c) { return nameSame(c.name, nm); });
      if (hits.length > 1) { var eq = hits.filter(function (c) { return nameKey(c.name) === nameKey(nm); }); hits = eq.length === 1 ? eq : []; }
      if (hits.length === 1) { items.forEach(function (it) { if (it.camName === nm) it.cam = hits[0].id; }); b.names[nm] = { n: tot[nm], cam: hits[0].id }; }
      else b.names[nm] = { n: tot[nm], cam: null };
    });
    /* Trail Cam Link: some cameras print DAY/MONTH. One photo that reads 17/10 settles the whole card: swap the ones that look like 03/10. */
    (function () {
      var dm = items.some(function (it) { return it.stampT && it.order === 'dm'; }), md = items.some(function (it) { return it.stampT && it.order === 'md'; });
      if (!dm || md) return;
      items.forEach(function (it) {
        if (it.order !== 'amb' || !it.stampT) return;
        var y = it.stampT.slice(0, 4), mo = it.stampT.slice(5, 7), d = it.stampT.slice(8, 10), t2 = y + '-' + d + '-' + mo + it.stampT.slice(10), p2 = parseLocal(t2);
        if (!p2 || toLocalStr(p2).slice(0, 10) !== t2.slice(0, 10)) return;
        if (it.tsrc === 'exif') {   // EXIF is the time; the swapped stamp may now agree with it
          if (it.altSrc === 'stamp' && it.alt) {
            it.alt = t2; it.order = 'dm'; it.swapped = true;
            if (Math.abs(ymdT(it.t) - ymdT(t2)) <= CROSS_MS) { it.alt = null; it.altSrc = null; it.conf = it.tempFlag ? 'check' : 'ok'; it.notes = it.tempFlag ? ['Check the temp.'] : []; it.stampAgree = true; }
            else it.notes = ['The file says ' + fmtDate(parseLocal(it.t)) + ' ' + fmtTime(parseLocal(it.t)) + ', the stamp says ' + fmtDate(p2) + ' ' + fmtTime(p2) + '. The camera clock may be wrong.'];
          }
          return;
        }
        if (it.tsrc !== 'stamp' || !it.t) return;
        it.t = it.t.slice(0, 5) + it.t.slice(8, 10) + '-' + it.t.slice(5, 7) + it.t.slice(10); it.order = 'dm'; it.swapped = true;
        bulkNote(it, 'This card prints day before month; date set to ' + fmtDate(p2) + '.');
      });
    })();
    // a date far from the rest of the card is almost always a misread digit
    if (timed.length >= 4) {
      var med = timed[timed.length >> 1], lim = OUTLIER_DAYS * DAYMS;
      items.forEach(function (it) {
        if (it.tsrc !== 'stamp' || !it.t || Math.abs(ymdT(it.t) - med) <= lim) return;
        if (it.alt && Math.abs(ymdT(it.alt) - med) <= lim) { it.conf = 'check'; return; }
        var ds = it.t.slice(0, 10), tm = it.t.slice(10), conf = { '0': ['6', '8', '9'], '6': ['0', '8', '5'], '8': ['0', '6', '3'], '1': ['7'], '7': ['1'], '3': ['8'], '5': ['6'], '2': ['7'], '9': ['0', '8'] }, cands = [];
        for (var i = 0; i < ds.length; i++) (conf[ds[i]] || []).forEach(function (r) { var c = ds.slice(0, i) + r + ds.slice(i + 1), d = parseLocal(c + tm); if (d && toLocalStr(d).slice(0, 10) === c && Math.abs(d.getTime() - med) <= lim && cands.indexOf(c) < 0) cands.push(c); });
        it.conf = 'check';
        if (cands.length === 1) { it.notes = ['Read as ' + fmtDate(parseLocal(it.t)) + '; the rest of the card is around ' + fmtDate(new Date(med)) + '. Changed to ' + fmtDate(parseLocal(cands[0] + tm)) + ', please check.']; it.t = cands[0] + tm; }
        else it.notes = ['This date (' + fmtDate(parseLocal(it.t)) + ') is far from the rest of the card (around ' + fmtDate(new Date(med)) + '). Check the digits.'];
      });
    }
  }
  function bulkStart(files, camChoice, newName, pos) {
    bulk = { phase: 'run', def: camChoice, newCams: [], newBucks: [], pos: pos || 'auto', items: [], total: 0, done: 0, dup: 0, skipped: 0, over: 0, stop: false, t0: Date.now(), t1: 0, sel: {}, names: {}, ocrOk: true, saved: null };
    if (camChoice === '__new') { bulk.newCams.push({ key: 'n0', name: clampStr(newName, 60) }); bulk.def = 'n0'; }
    var list = files.slice(0, BULK_MAX); bulk.over = files.length - list.length;
    var imgs = list.filter(isImageFile); bulk.skipped = list.length - imgs.length; bulk.total = imgs.length;
    if (!imgs.length) { bulk.phase = 'review'; bulk.t1 = Date.now(); go('#/bulk'); render(); return; }
    // duplicate = same file name and size already saved (when both know the file's own time, those must match too)
    var seen = {}; P.forEach(function (p) { (seen[p.name + '|' + p.size] = seen[p.name + '|' + p.size] || []).push(p.tsrc === 'exif' ? p.t : null); });
    var dIdx = window.BLDedup ? BLDedup.buildIndex(P) : null, camReal = cam(bulk.def) ? bulk.def : null;
    if (R.view !== 'bulk') go('#/bulk'); else render();
    requestPersist();
    function prep(f) {
      return readHead(f, 262144).then(function (buf) { return readExif(buf); }, function () { return null; }).then(function (ex) {
        var dt = ex && ex.dt, key = f.name + '|' + f.size, prior = seen[key] || [];
        if (prior.some(function (x) { return x === null || !dt || x === dt; })) return { f: f, dup: true };
        (seen[key] = prior).push(dt || null);
        // same bytes as a photo already in the ledger (or earlier in this batch): skip before reading it
        return (dIdx ? BLDedup.sha256(f) : Promise.resolve('')).then(function (hash) {
          if (hash && dIdx.hash[hash]) return { f: f, dup: true };
          if (hash) dIdx.hash[hash] = { id: null, name: f.name };   // later copies in this batch match it
          return bulkLoad(f).then(function (L) {
            var o = { f: f, dt: dt || null, L: L, hash: hash, dh: '', w: 0, h: 0 };
            if (L && dIdx) { o.w = L.img.naturalWidth; o.h = L.img.naturalHeight; o.dh = BLDedup.dhashOf(L.img, o.w, o.h); o.tv = BLDedup.tvOf(L.img, o.w, o.h); }
            return o;
          });
        });
      }, function () { return { f: f, dup: true, err: true }; });
    }
    function upd() {
      var s = $('#bulk-status'), bar = $('#bulk-bar'), el = (Date.now() - bulk.t0) / 1000, left = bulk.done ? Math.max(0, Math.round(el / bulk.done * (bulk.total - bulk.done))) : null;
      if (s) s.textContent = bulk.done + ' of ' + bulk.total + (left !== null && bulk.done < bulk.total && !bulk.stop ? ' · about ' + (left >= 60 ? Math.ceil(left / 60) + ' min' : left + ' sec') + ' left' : '');
      if (bar) bar.style.width = (bulk.total ? bulk.done / bulk.total * 100 : 0) + '%';
    }
    function item(o, v) {
      var f = o.f, fd = f.lastModified ? new Date(f.lastModified) : null;
      return { id: uid(), name: clampStr(f.name, 200), size: f.size || 0, dt: o.dt, fileT: fd && !isNaN(fd) ? toLocalStr(fd) : null, t: null, tsrc: null, temp: null, tempSrc: null, camText: '', camName: '', conf: 'none', notes: [], thumb: null, mini: null, cam: '', deer: '', raw: '', noPic: !o.L };
    }
    var i = 0, nextP = null;
    function loop() {
      if (i >= imgs.length) return Promise.resolve();
      var cur = nextP || prep(imgs[i]); nextP = null; var idx = i++;
      if (i < imgs.length && !bulk.stop) nextP = prep(imgs[i]);   // decode the next photo while this one is read
      return cur.then(function (o) {
        if (o.dup) { if (o.err) bulk.skipped++; else bulk.dup++; bulk.done++; upd(); return tick().then(loop); }
        var it = item(o), L = o.L, work;
        if (!L) work = Promise.resolve(null);
        else work = imgBlob(L.img, 1280, 0.8).then(function (th) { it.thumb = th; return imgBlob(L.img, 180, 0.7); }).then(function (mi) { if (mi) { try { it.mini = URL.createObjectURL(mi); } catch (e) {} } });
        return work.then(function () {
          if (!L || bulk.stop || !bulk.ocrOk) return null;
          return window.BLOcr.readStamp(L.img, bulk.pos).catch(function () { return null; });
        }).then(function (v) {
          bulkInterpret(it, v);
          if (dIdx && o.hash && dIdx.hash[o.hash] && dIdx.hash[o.hash].id === null) delete dIdx.hash[o.hash];
          if (dIdx && o.hash) {   // stamp + camera + temp, or a look-alike picture at the same time
            var st = it.stampT ? { date: (it.stampAgree ? it.t : it.stampT).slice(0, 10), time: (it.stampAgree ? it.t : it.stampT).slice(11, 19), temp: it.tempFlag ? null : it.temp, name: it.camText } : { temp: it.tempFlag ? null : it.temp, name: it.camText };
            var fp = BLDedup.build(o.f, o.hash, { dh: o.dh, tv: o.tv, w: o.w, h: o.h }, { exifT: o.dt, camId: camReal, stamp: st, sec: !!it.secKnown, minute: true }), m = BLDedup.match(dIdx, fp);
            if (m && m.of.id !== null) { bulk.dup++; if (L) { try { URL.revokeObjectURL(L.url); } catch (e) {} L.img.src = ''; if (it.mini) { try { URL.revokeObjectURL(it.mini); } catch (e) {} } } bulk.done++; upd(); return tick().then(loop); }
            it.fp = fp; BLDedup.add(dIdx, BLDedup.entryFromFp(fp, { id: it.id, name: it.name }));
          }
          bulk.items.push(it);
          if (L) { try { URL.revokeObjectURL(L.url); } catch (e) {} L.img.src = ''; }
          bulk.done++; upd(); return tick().then(loop);
        });
      });
    }
    ensureOcr().then(function () { return window.BLOcr._getWorker().catch(function () { bulk.ocrOk = false; }); }, function () { bulk.ocrOk = false; }).then(loop).then(function () {
      bulkFinalize(); bulk.t1 = Date.now(); bulk.phase = 'review';
      window.__bulkInfo = { ms: bulk.t1 - bulk.t0, n: bulk.items.length, dup: bulk.dup, skipped: bulk.skipped, stopped: bulk.stop };
      if (R.view === 'bulk') render();
    });
  }
  function bulkCamLabel(key) {
    if (!key) key = bulk.def;
    var c = cam(key); if (c) return c.name;
    var n = bulk.newCams.filter(function (x) { return x.key === key; })[0]; return n ? n.name + ' (new)' : 'No camera';
  }
  function bulkCamOf(it) { return it.cam || bulk.def; }
  function bulkGroups() {
    var by = {}, groups = [], gi = {};
    bulk.items.forEach(function (it) { if (it.t) (by[bulkCamOf(it)] = by[bulkCamOf(it)] || []).push(it); });
    Object.keys(by).forEach(function (k) {
      var cur = null;
      by[k].sort(function (a, b) { return ymdT(a.t) - ymdT(b.t); }).forEach(function (it) {
        var t = ymdT(it.t);
        if (cur && t - cur.end <= GROUP_S * 1000) { cur.ids.push(it.id); cur.end = t; } else { cur = { ids: [it.id], start: t, end: t, cam: k }; groups.push(cur); }
      });
    });
    groups.sort(function (a, b) { return a.start - b.start; });
    groups.forEach(function (g, n) { g.n = n + 1; g.ids.forEach(function (id) { gi[id] = g; }); });
    return { list: groups, of: gi };
  }
  function bulkBuckLabel(key) { var b = deer(key); if (b) return b.name; var n = bulk.newBucks.filter(function (x) { return x.key === key; })[0]; return n ? n.name + ' (new)' : ''; }
  function bulkSuggest(it) {
    if (it.deer || !it.t) return null; var c = bulkCamOf(it); if (!cam(c)) return null;
    var sg = idSuggest({ id: '_', deer: [], cam: c, t: it.t, tags: [] }); return sg && deer(sg.id) ? sg : null;
  }
  function bulkRowHtml(it, ix, gr, open) {
    var d = it.t ? it.t.slice(0, 10) : (it.partialDate || ''), tm = it.t ? it.t.slice(11, 19) : (it.partialTime || ''), flag = it.conf !== 'ok';
    var badge = it.conf === 'none' ? '<span class="bb bad">No time</span>' : it.conf === 'check' ? '<span class="bb chk">Check</span>' : it.tsrc === 'exif' && !it.stampAgree ? '<span class="bb file">File time</span>' : '<span class="bb ok">Stamp ✓</span>';
    var sg = bulkSuggest(it), when = it.t ? fmtDate(parseLocal(it.t)) + ' · ' + fmtTime(parseLocal(it.t)) : 'no time yet';
    var fields = '<div class="bf"><label><span>Date</span><input type="date" data-f="d" data-i="' + ix + '" value="' + esc(d) + '"></label><label><span>Time</span><input type="time" step="1" data-f="t" data-i="' + ix + '" value="' + esc(tm) + '"></label><label><span>Temp °F</span><input type="number" inputmode="numeric" min="-40" max="130" data-f="tp" data-i="' + ix + '" value="' + (it.temp === null ? '' : it.temp) + '" placeholder="–"></label></div>';
    var show = flag || open;
    return '<div class="brow ' + (flag ? 'flag' : '') + '" data-row="' + ix + '"><label class="bchk"><input type="checkbox" data-sel="' + ix + '"' + (bulk.sel[it.id] ? ' checked' : '') + ' aria-label="Select photo ' + esc(it.name) + '"></label>' +
      (it.mini ? '<img class="bth" loading="lazy" decoding="async" alt="" src="' + it.mini + '">' : '<span class="bth none">no<br>pic</span>') +
      '<div class="bmain"><div class="bname"><b class="mono">' + esc(it.name) + '</b> ' + badge + (gr && gr.ids.length > 1 ? ' <span class="bb grp">Sighting ' + gr.n + ' · ' + gr.ids.length + ' photos</span>' : '') + '</div>' +
      (show ? fields : '<div class="bwhen">' + esc(when) + (it.temp !== null ? ' · ' + it.temp + '°F' : '') + ' · ' + esc(bulkCamLabel(bulkCamOf(it))) + ' <button class="lnk" data-act="bulk-edit" data-i="' + ix + '">Edit</button></div>') +
      (it.deer ? '<div class="bwho">★ ' + esc(bulkBuckLabel(it.deer)) + '</div>' : '') +
      (it.notes.length ? '<div class="bnote">' + esc(it.notes.join(' ')) + (it.alt && it.conf === 'check' ? (it.altSrc === 'stamp' ? ' <button class="lnk" data-act="bulk-usestamp" data-i="' + ix + '">Use the stamp time (' + esc(fmtDate(parseLocal(it.alt)) + ' ' + fmtTime(parseLocal(it.alt))) + ')</button>' : ' <button class="lnk" data-act="bulk-usefile" data-i="' + ix + '">Use the file time</button>') : '') + '</div>' : '') +
      (it.conf === 'none' && it.fileT ? '<div class="bnote"><button class="lnk" data-act="bulk-usefiledate" data-i="' + ix + '">Use file date (' + esc(fmtDate(parseLocal(it.fileT)) + ' ' + fmtTime(parseLocal(it.fileT))) + ')</button> <span class="muted">Often when the card was copied, not when the photo was taken.</span></div>' : '') +
      (sg ? '<div class="bnote sug">Suggestion: <b>★ ' + esc(deer(sg.id).name) + '</b>? Same camera and visit as ' + plural(sg.n, 'photo') + ' you tagged. <button class="btn sm go" data-act="bulk-sug" data-i="' + ix + '">Yes, that’s him</button></div>' : '') + '</div></div>';
  }
  function bulkCounts() {
    var c = { n: bulk.items.length, ok: 0, check: 0, none: 0, stamp: 0, exif: 0 };
    bulk.items.forEach(function (it) { c[it.conf]++; if (it.t && (it.tsrc === 'stamp' || it.stampAgree)) c.stamp++; else if (it.t && it.tsrc === 'exif') c.exif++; });
    return c;
  }
  function bulkPlanCams() { var used = {}; bulk.items.forEach(function (it) { used[bulkCamOf(it)] = 1; }); return bulk.newCams.filter(function (n) { return used[n.key]; }); }
  function bulkPlanBucks() { var used = {}; bulk.items.forEach(function (it) { if (it.deer) used[it.deer] = 1; }); return bulk.newBucks.filter(function (n) { return used[n.key]; }); }
  function bulkSetupHtml() {
    var opts = S.cameras.map(function (c) { return '<option value="' + esc(c.id) + '"' + (S.settings.lastCam === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join(''), canNew = canAddCam();
    return '<div class="paper" id="bulk-setup"><h3 style="margin-top:0">Pick the photos, the app does the rest</h3>' +
      '<p class="small" style="margin:0 0 10px">Choose up to ' + BULK_MAX + ' photos at once. Buck Ledger reads the date, time and temperature printed on each one (and the camera name when the stamp has one), groups photos taken within 2 minutes into one sighting, and shows you a list to check. Only the ones it can’t read need you.</p>' +
      '<label class="field"><span>Which camera is this batch from?</span><select id="bulk-cam">' + opts + (canNew ? '<option value="__new"' + (!S.cameras.length ? ' selected' : '') + '>＋ New camera…</option>' : '') + '</select></label>' +
      '<label class="field" id="bulk-new-wrap" style="display:' + (!S.cameras.length ? 'block' : 'none') + '"><span>Camera name</span><input type="text" id="bulk-new" maxlength="60" placeholder="e.g. Creek crossing, Food plot, Stand East"></label>' +
      (!canNew ? '<p class="small muted">' + freeLine('cam') + '</p>' : '') +
      '<label class="field"><span>Where is the stamp on your photos?</span><select id="bulk-pos"><option value="auto">Find it (bottom, then top)</option><option value="bottom">Bottom strip</option><option value="top">Top strip</option></select></label>' +
      '<button class="btn go block" data-act="bulk-pick">Choose photos</button><input type="file" id="bulk-file" accept="image/*" multiple hidden>' +
      '<p class="small muted" style="margin:10px 0 0">Nothing is uploaded. Photos are shrunk to a small copy kept on this device. Phone screenshots of trail cam pictures work too. If a photo has no readable stamp, its time comes from the photo file; if there’s neither, you type it or leave it for the Stamp Reader.</p></div>' + filesTip();
  }
  function bulkRunHtml() {
    return '<div class="paper"><h3 style="margin-top:0">Reading your photos…</h3><p class="muted small" id="bulk-status">' + bulk.done + ' of ' + bulk.total + '</p><div class="progress"><i id="bulk-bar" style="width:' + (bulk.total ? bulk.done / bulk.total * 100 : 0) + '%"></i></div>' +
      '<p class="small muted" style="margin:0 0 10px">Keep this screen open. One photo at a time, so your phone stays responsive.</p><button class="btn ink block" data-act="bulk-stop">Stop reading (keep the rest as they are)</button></div>';
  }
  function bulkReviewHtml() {
    var c = bulkCounts(), gs = bulkGroups(), b = bulk, h = '<div class="bulkwide">';
    var sec = ((b.t1 - b.t0) / 1000).toFixed(1);
    h += '<div class="paper" id="bulk-sum"><h3 style="margin:0 0 6px;font-family:Georgia,serif">' + plural(c.n, 'photo') + ' read in ' + sec + ' s</h3><ul class="small" style="margin:0;padding-left:18px">' +
      '<li><b>' + c.stamp + '</b> read from the stamp' + (c.exif ? ' · <b>' + c.exif + '</b> from the photo file' : '') + '</li>' +
      '<li id="bulk-flagcount">' + (c.check + c.none ? '<b>' + (c.check + c.none) + '</b> need a look (listed first)' : '<b>Nothing needs a look ✓</b>') + '</li>' +
      '<li>' + gs.list.length + ' sightings (photos within 2 minutes of each other)</li>' +
      (b.dup ? '<li>' + plural(b.dup, 'photo') + ' skipped: already in your ledger</li>' : '') + (b.skipped ? '<li>' + plural(b.skipped, 'file') + ' skipped: not photos</li>' : '') +
      (b.over ? '<li><b>' + plural(b.over, 'photo') + ' not read:</b> one import takes up to ' + BULK_MAX + '. Pick the rest in another import.</li>' : '') +
      (b.stop ? '<li>You stopped early: the rest were kept with their file time only.</li>' : '') + (!b.ocrOk ? '<li><b>Stamp reading wasn’t available.</b> Used the file times only.</li>' : '') + '</ul></div>';
    if (!c.n) return h + '<div class="paper"><p>No new photos to import.</p><a class="btn ink block" href="#/bulk" data-act="bulk-again">Pick again</a></div></div>';
    // batch tools
    var camOpts = S.cameras.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>'; }).join('') + b.newCams.map(function (x) { return '<option value="' + x.key + '">' + esc(x.name) + ' (new)</option>'; }).join('');
    var buckOpts = '<option value="">— none (the Sort Pass will ask) —</option>' + S.deer.map(function (x) { return '<option value="' + esc(x.id) + '">★ ' + esc(x.name) + '</option>'; }).join('') + b.newBucks.map(function (x) { return '<option value="' + x.key + '">★ ' + esc(x.name) + ' (new)</option>'; }).join('');
    var nm = Object.keys(b.names).filter(function (k) { return !b.names[k].cam && !b.newCams.some(function (x) { return nameSame(x.name, k); }); });
    h += '<div class="paper" id="bulk-tools"><div class="bsel"><button class="btn sm ink" data-act="bulk-selall">Select all</button><button class="btn sm ink" data-act="bulk-selnone">Select none</button><span class="small muted" id="bulk-selcount">' + selCount() + ' selected</span></div>' +
      '<div class="bgrid"><label class="field"><span>Camera for <b id="bulk-target">' + (selCount() ? 'the selected photos' : 'the whole batch') + '</b></span><select id="bulk-camsel"><option value="">Choose…</option>' + camOpts + '<option value="__new">＋ New camera…</option></select></label>' +
      '<label class="field"><span>Buck for the selected photos <i class="muted">(optional)</i></span><select id="bulk-bucksel"><option value="__keep">Choose…</option>' + buckOpts + '<option value="__new">＋ New buck…</option></select></label></div>' +
      '<p class="tiny muted" style="margin:0">Bucks are never named for you: pick one you already have, or type a new name. Tick the photos first (a sighting’s checkbox selects all its photos).</p>' +
      (nm.length ? '<div class="bnames small">Camera names printed on the stamps: ' + nm.map(function (k) { return '<button class="btn sm" data-act="bulk-namecam" data-name="' + esc(k) + '">Make “' + esc(k) + '” a camera (' + b.names[k].n + ' photos)</button>'; }).join(' ') + '</div>' : '') +
      (Object.keys(b.names).some(function (k) { return b.names[k].cam; }) ? '<p class="tiny muted" style="margin:6px 0 0">Photos whose stamp names one of your cameras went to that camera.</p>' : '') + '</div>';
    var sugN = b.items.filter(function (it) { return bulkSuggest(it); }).length;
    if (sugN) h += '<div class="panel small" id="bulk-sugbar">Suggestions: <b>' + plural(sugN, 'photo') + '</b> look like the same visit as a buck you already tagged. <button class="btn sm go" data-act="bulk-sugall">Apply all ' + sugN + '</button> <span class="muted">or tap each one below.</span></div>';
    var flagged = b.items.map(function (it, ix) { return [it, ix]; }).filter(function (x) { return x[0].conf !== 'ok'; });
    if (flagged.length) h += '<h3 class="bh" id="bulk-flaghead">Needs a look (' + flagged.length + ')</h3><div class="blist" id="bulk-flagged">' + flagged.map(function (x) { return bulkRowHtml(x[0], x[1], gs.of[x[0].id], true); }).join('') + '</div>';
    var ready = b.items.map(function (it, ix) { return [it, ix]; }).filter(function (x) { return x[0].conf === 'ok'; }).sort(function (a, z) { return ymdT(a[0].t) - ymdT(z[0].t); });
    if (ready.length) {
      h += '<h3 class="bh">Ready (' + ready.length + ')</h3><div class="blist" id="bulk-ready">'; var lastG = null;
      ready.forEach(function (x) {
        var g = gs.of[x[0].id];
        if (g && g !== lastG && g.ids.length > 1) h += '<label class="bgh"><input type="checkbox" data-selg="' + g.n + '"> Sighting ' + g.n + ' · ' + plural(g.ids.length, 'photo') + ' · ' + esc(fmtDate(new Date(g.start)) + ' ' + fmtTime(new Date(g.start))) + '</label>';
        lastG = g; h += bulkRowHtml(x[0], x[1], g, bulk.open && bulk.open[x[0].id]);
      });
      h += '</div>';
    }
    var pc = bulkPlanCams(), pb = bulkPlanBucks();
    h += '<div class="bsave" id="bulk-savebar"><div class="small" id="bulk-saveinfo">' + bulkSaveInfo(c, pc, pb) + '</div><button class="btn go block" data-act="bulk-save" id="bulk-savebtn">Save all ' + c.n + '</button></div></div>';
    return h;
  }
  function selCount() { var n = 0; if (bulk) bulk.items.forEach(function (it) { if (bulk.sel[it.id]) n++; }); return n; }
  function bulkSaveInfo(c, pc, pb) {
    var s = [];
    if (c.none) s.push(plural(c.none, 'photo') + ' with no time will wait in the Stamp Reader.');
    if (pc.length) s.push('New camera' + (pc.length > 1 ? 's' : '') + ': ' + pc.map(function (x) { return esc(x.name); }).join(', ') + '.');
    if (pb.length) s.push('New buck' + (pb.length > 1 ? 's' : '') + ': ' + pb.map(function (x) { return esc(x.name); }).join(', ') + '.');
    var left = bulk.items.filter(function (it) { return !it.deer; }).length;
    if (left) s.push(plural(left, 'photo') + ' without a buck go to the Sort Pass.');
    return s.join(' ');
  }
  function bulkSavedHtml() {
    var r = bulk.saved;
    return '<div class="paper" id="bulk-result"><h3 style="font-family:Georgia,serif;margin-top:0">Saved ' + plural(r.count, 'photo') + '</h3><ul class="small" style="padding-left:18px;margin:6px 0 12px">' +
      '<li>' + plural(r.timed, 'photo') + ' with a date and time' + (r.stamp ? ' (' + r.stamp + ' from the stamp, ' + r.exif + ' from the file, ' + r.typed + ' typed)' : '') + '</li>' +
      (r.temps ? '<li>' + plural(r.temps, 'temperature') + ' filled in</li>' : '') +
      (r.cams.length ? '<li>New camera' + (r.cams.length > 1 ? 's' : '') + ': ' + r.cams.map(esc).join(', ') + '</li>' : '') + (r.bucks.length ? '<li>New buck' + (r.bucks.length > 1 ? 's' : '') + ': ' + r.bucks.map(esc).join(', ') + '</li>' : '') +
      (r.assigned ? '<li>' + plural(r.assigned, 'photo') + ' tagged with a buck</li>' : '') +
      (r.noTime ? '<li><b>' + plural(r.noTime, 'photo') + ' still need a time.</b> The Stamp Reader has them.</li>' : '<li>Every photo has a date and time ✓</li>') + '</ul>' +
      (r.unsorted ? '<a class="btn go block" href="#/sort">Start the Sort Pass (' + r.unsorted + ')</a>' : '<a class="btn go block" href="#/">Open the Ledger</a>') +
      '<div class="btn-row" style="margin-top:8px">' + (r.noTime ? '<a class="btn ink" href="#/stamp">Stamp Reader</a>' : '') + '<a class="btn ink" href="#/">Ledger</a><button class="btn ink" data-act="bulk-again">Import more</button></div></div>';
  }
  VIEWS.bulk = function () {
    var h = head('Bulk import', '#/');
    if (!bulk || bulk.phase === 'setup') return h + bulkSetupHtml();
    if (bulk.phase === 'run') return h + bulkRunHtml();
    if (bulk.phase === 'review') return h + bulkReviewHtml();
    return h + bulkSavedHtml();
  };
  function bulkRerender() { var y = window.scrollY; render(); window.scrollTo(0, y); }
  VIEWS.bulk.after = function () {
    var sel = $('#bulk-cam');
    if (sel) {
      sel.addEventListener('change', function () { $('#bulk-new-wrap').style.display = sel.value === '__new' ? 'block' : 'none'; });
      $('#bulk-file').addEventListener('change', function (e) {
        var files = Array.prototype.slice.call(e.target.files || []); e.target.value = '';
        if (!files.length) return;
        var cid = sel.value, nn = '';
        if (cid === '__new') { nn = ($('#bulk-new').value || '').trim(); if (!nn) { toast('Name the camera first'); return; } if (!canAddCam()) { proSheet('cam'); return; } }
        S.settings.lastCam = cid === '__new' ? S.settings.lastCam : cid; save();
        bulkStart(files, cid, nn, $('#bulk-pos').value);
      });
    }
  };
  document.addEventListener('change', function (e) { if (R && R.view === 'bulk') bulkChange(e); });
  function bulkChange(e) {
    if (!bulk || bulk.phase !== 'review') return;
    var t = e.target, ix, it;
    if (t.hasAttribute('data-sel')) { it = bulk.items[+t.getAttribute('data-sel')]; if (it) bulk.sel[it.id] = t.checked; bulkSelUi(); return; }
    if (t.hasAttribute('data-selg')) {
      var g = bulkGroups().list.filter(function (x) { return x.n === +t.getAttribute('data-selg'); })[0];
      if (g) { g.ids.forEach(function (id) { bulk.sel[id] = t.checked; }); Array.prototype.forEach.call(document.querySelectorAll('[data-sel]'), function (c) { var o = bulk.items[+c.getAttribute('data-sel')]; if (o) c.checked = !!bulk.sel[o.id]; }); bulkSelUi(); }
      return;
    }
    if (t.hasAttribute('data-f')) { ix = +t.getAttribute('data-i'); it = bulk.items[ix]; if (it) bulkEditField(it, ix, t); return; }
    if (t.id === 'bulk-camsel') { bulkSetCam(t.value); t.value = ''; return; }
    if (t.id === 'bulk-bucksel') { bulkSetBuck(t.value); t.value = '__keep'; return; }
  }
  function bulkSelUi() {
    var s = $('#bulk-selcount'), g = $('#bulk-target'); if (s) s.textContent = selCount() + ' selected'; if (g) g.textContent = selCount() ? 'the selected photos' : 'the whole batch';
  }
  function bulkEditField(it, ix, inp) {
    var f = inp.getAttribute('data-f'), row = inp.closest('.brow');
    var dv = $('[data-f=d]', row).value, tv = $('[data-f=t]', row).value, tp = $('[data-f=tp]', row).value;
    if (f === 'tp') { var n = tp === '' ? null : Number(tp); if (n !== null && !(isFinite(n) && n >= -40 && n <= 130)) { toast('Temperature −40 to 130 °F'); inp.value = it.temp === null ? '' : it.temp; return; } it.temp = n; it.tempSrc = n === null ? null : 'typed'; return; }
    if (!dv || !tv) { it.partialDate = dv; it.partialTime = tv; return; }
    var val = dv + 'T' + (tv.length === 5 ? tv + ':00' : tv.slice(0, 8));
    if (!parseLocal(val)) { toast('That date/time doesn’t look right'); return; }
    it.t = val; it.tsrc = 'stamp'; it.conf = 'ok'; it.notes = ['Typed by you.']; it.alt = null; bulkRerender();
  }
  function bulkTargets() { var s = bulk.items.filter(function (it) { return bulk.sel[it.id]; }); return s.length ? s : null; }
  function bulkCamRoom() { var l = camLimit(); return l ? l - S.cameras.length - bulk.newCams.length : Infinity; }
  function bulkBuckRoom() { var l = buckLimit(); return l ? l - S.deer.length - bulk.newBucks.length : Infinity; }
  function bulkSetCam(v) {
    if (!v) return;
    function apply(key) { var tg = bulkTargets(); if (tg) tg.forEach(function (it) { it.cam = key; }); else { bulk.def = key; bulk.items.forEach(function (it) { it.cam = ''; }); } bulkRerender(); }
    if (v !== '__new') { apply(v); return; }
    if (bulkCamRoom() <= 0) { toast('Your ' + TIER_NAME[tier()] + ' version keeps ' + plural(camLimit(), 'camera') + '. These photos stay with “' + bulkCamLabel() + '”.', 4500); proSheet('cam'); return; }
    promptSheet('Name the camera', 'For example “Creek crossing” or “Food plot”.', 'Add camera').then(function (name) {
      if (!name) return; var key = 'n' + (bulk.newCams.length + 1); bulk.newCams.push({ key: key, name: clampStr(name, 60) }); apply(key);
    });
  }
  function bulkSetBuck(v) {
    if (v === '__keep') return;
    var tg = bulkTargets(); if (!tg) { toast('Tick the photos first'); return; }
    function apply(key) { tg.forEach(function (it) { it.deer = key; }); bulkRerender(); }
    if (v !== '__new') { apply(v); return; }
    if (bulkBuckRoom() <= 0) { toast('Your ' + TIER_NAME[tier()] + ' version keeps ' + plural(buckLimit(), 'named buck') + '. These photos stay without a buck for the Sort Pass.', 4500); proSheet('buck'); return; }
    promptSheet('Name a buck', 'Something you’ll recognize, like “Big 8” or “Split G2”.', 'Add buck').then(function (name) {
      if (!name) return; var key = 'b' + (bulk.newBucks.length + 1); bulk.newBucks.push({ key: key, name: clampStr(name, 60) }); apply(key);
    });
  }
  function bulkSave() {
    var b = bulk, pc = bulkPlanCams(), pb = bulkPlanBucks(), cl = camLimit(), bl2 = buckLimit();
    if (cl && S.cameras.length + pc.length > cl) { toast('This batch would add ' + plural(pc.length, 'camera') + ' but your ' + TIER_NAME[tier()] + ' version keeps ' + plural(cl, 'camera') + '. Nothing was saved. Pick an existing camera for those photos.', 6000); proSheet('cam'); return; }
    if (bl2 && S.deer.length + pb.length > bl2) { toast('This batch would add ' + plural(pb.length, 'named buck') + ' but your ' + TIER_NAME[tier()] + ' version keeps ' + plural(bl2, 'named buck') + '. Nothing was saved. Pick an existing buck, or clear it.', 6000); proSheet('buck'); return; }
    var btn = $('#bulk-savebtn'); if (btn) btn.disabled = true;
    var camId = {}, buckId = {}, madeC = [], madeB = [];
    pc.forEach(function (n) { var id = addCamera(n.name); if (id) { camId[n.key] = id; madeC.push(n.name); if (window.BLTcl && isPro()) window.BLTcl.autoLink(S, cam(id)); } });
    pb.forEach(function (n) { var id = addBuck(n.name); if (id) { buckId[n.key] = id; madeB.push(n.name); } });
    var resC = function (k) { return camId[k] || (cam(k) ? k : null); }, fallback = S.cameras.length ? (cam(S.settings.lastCam) ? S.settings.lastCam : S.cameras[0].id) : null;
    var pulls = {}, out = [], res = { count: 0, timed: 0, stamp: 0, exif: 0, typed: 0, temps: 0, noTime: 0, assigned: 0, unsorted: 0, cams: madeC, bucks: madeB };
    b.items.forEach(function (it) {
      var cid = resC(bulkCamOf(it)) || fallback, pl = pulls[cid]; if (!pl) pl = pulls[cid] = { id: uid(), cam: cid, at: Date.now(), count: 0, noTime: 0 };
      var did = it.deer ? (buckId[it.deer] || (deer(it.deer) ? it.deer : null)) : null;
      var p = { id: it.id, cam: cid, pull: pl.id, name: it.name, size: it.size, t: it.t || null, tsrc: it.t ? (it.tsrc === 'exif' ? 'exif' : it.tsrc === 'file' ? 'file' : 'stamp') : null, fileT: it.fileT, tags: [], deer: did ? [did] : [], done: !!did,
        thumb: it.thumb, added: Date.now(), temp: it.temp, tempSrc: it.temp === null ? null : (it.tempSrc === 'ocr' ? 'ocr' : 'typed') };
      if (it.fp) { var fl = BLDedup.fields(it.fp); p.hash = fl.hash; p.dh = fl.dh; p.tv = fl.tv; p.w = fl.w; p.h = fl.h; p.stamp = { name: it.fp.camName || '', s: it.secKnown ? 1 : 0 }; }
      out.push(p); pl.count++; if (!p.t) { pl.noTime++; res.noTime++; } else { res.timed++; if (it.tsrc === 'exif') res.exif++; else if (it.typedSrc) res.typed++; else res.stamp++; }
      if (it.temp !== null) res.temps++; if (did) res.assigned++; else res.unsorted++;
    });
    res.count = out.length;
    // the typed ones: stamp-sourced but entered by hand
    b.items.forEach(function (it) { if (it.t && it.tsrc === 'stamp' && it.notes.indexOf('Typed by you.') >= 0) { res.typed++; res.stamp--; } });
    photosPutMany(out).then(function () {
      out.forEach(function (p) { P.push(p); PI[p.id] = p; });
      Object.keys(pulls).forEach(function (k) { if (pulls[k].count) S.pulls.push(pulls[k]); });
      bulkFree(); b.saved = res; b.phase = 'saved'; save(); window.scrollTo(0, 0); render();
    }, function () { toast('Couldn’t save. Is your phone storage full? Nothing was lost; try again after freeing space.', 6000); if (btn) btn.disabled = false; });
  }
  function bulkClick(act, a) {
    var ix = +a.getAttribute('data-i'), it = bulk && bulk.items[ix];
    switch (act) {
      case 'bulk-pick': {
        var sel = $('#bulk-cam');
        if (sel && sel.value === '__new' && !($('#bulk-new').value || '').trim()) { toast('Name the camera first'); $('#bulk-new').focus(); return true; }
        $('#bulk-file').click(); return true;
      }
      case 'bulk-stop': if (bulk) { bulk.stop = true; var s = $('#bulk-status'); if (s) s.textContent = 'Finishing…'; } return true;
      case 'bulk-again': bulkFree(); bulk = null; if (R.view === 'bulk') render(); else go('#/bulk'); return true;
      case 'bulk-selall': bulk.items.forEach(function (x) { bulk.sel[x.id] = true; }); bulkRerender(); return true;
      case 'bulk-selnone': bulk.sel = {}; bulkRerender(); return true;
      case 'bulk-edit': bulk.open = bulk.open || {}; if (it) bulk.open[it.id] = true; bulkRerender(); return true;
      case 'bulk-usefile': if (it && it.alt) { it.t = it.alt; it.tsrc = 'exif'; it.conf = 'ok'; it.notes = ['Using the time saved in the photo file.']; it.alt = null; it.altSrc = null; bulkRerender(); } return true;
      case 'bulk-usestamp': if (it && it.alt && it.altSrc === 'stamp') { it.t = it.alt; it.tsrc = 'stamp'; it.conf = 'ok'; it.notes = ['Using the time printed on the stamp.']; it.alt = null; it.altSrc = null; bulkRerender(); } return true;
      case 'bulk-usefiledate': if (it && it.fileT) { it.t = it.fileT; it.tsrc = 'file'; it.conf = 'ok'; it.notes = ['Using the file date (check it).']; bulkRerender(); } return true;
      case 'bulk-sug': { var sg = it && bulkSuggest(it); if (sg) { it.deer = sg.id; bulkRerender(); } return true; }
      case 'bulk-sugall': { bulk.items.forEach(function (x) { var s2 = bulkSuggest(x); if (s2) x.deer = s2.id; }); bulkRerender(); return true; }
      case 'bulk-namecam': {
        var nm = a.getAttribute('data-name'), hit = bulk.items.filter(function (x) { return x.camName === nm; });
        if (bulkCamRoom() <= 0) { toast('Your ' + TIER_NAME[tier()] + ' version keeps ' + plural(camLimit(), 'camera') + '. Those ' + plural(hit.length, 'photo') + ' stay with “' + bulkCamLabel() + '”.', 4500); proSheet('cam'); return true; }
        var key = 'n' + (bulk.newCams.length + 1); bulk.newCams.push({ key: key, name: nm.charAt(0) + nm.slice(1).toLowerCase() }); hit.forEach(function (x) { x.cam = key; }); bulkRerender(); return true;
      }
      case 'bulk-save': bulkSave(); return true;
    }
    return false;
  }

  /* ---------------- Sort Pass ---------------- */
  // One photo at a time; the tray at the bottom is within thumb reach.
  var sortSel = null, sortCur = null, sortLast = null, sortUndo = [], sortSkip = {};
  function sortQueue() {
    return P.filter(function (p) { return !p.done && !sortSkip[p.id]; }).sort(function (a, b) {
      if (a.cam !== b.cam) return String(a.cam).localeCompare(String(b.cam));
      if (a.t && b.t) return a.t < b.t ? -1 : a.t > b.t ? 1 : 0;
      if (a.t !== b.t) return a.t ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
  }
  VIEWS.sort = function () {
    var q = sortQueue();
    if (!q.length && Object.keys(sortSkip).length) { sortSkip = {}; q = sortQueue(); }
    if (!q.length) {
      sortCur = null;
      return '<main class="wrap">' + head('Sort Pass', '#/') + '<div class="paper welcome"><div class="big">✅</div><h2 style="font-family:Georgia,serif">' + (P.length ? 'Everything is sorted' : 'Nothing to sort yet') + '</h2><p class="muted">' + (P.length ? 'New photos land here after you log a pull.' : 'Log a pull first, then sort the photos here.') + '</p>' +
        '<div class="btn-row">' + (sortUndo.length ? '<button class="btn ink" data-act="sort-undo">Undo last</button>' : '') + '<a class="btn go" href="' + (P.length ? '#/' : '#/pull') + '">' + (P.length ? 'Open the Ledger' : 'Log a Pull') + '</a></div></div></main>';
    }
    var p = (sortCur && PI[sortCur] && !PI[sortCur].done) ? PI[sortCur] : q[0];
    if (sortCur !== p.id) { sortCur = p.id; sortSel = { tags: p.tags.slice(), deer: p.deer.slice() }; }
    var d = eff(p), idx = q.indexOf(p);
    var h = '<div class="sp" id="sort-pass"><div class="sp-top"><a href="#/" aria-label="Close Sort Pass">✕ Done</a><span class="grow muted">' + (idx + 1) + ' of ' + q.length + ' · ' + esc(camName(p.cam)) + '</span>' +
      (sortUndo.length ? '<button data-act="sort-undo">↶ Undo</button>' : '') + '<button data-act="sort-skip">Skip ›</button></div>' +
      '<div class="sp-photo">' + (p.thumb ? '<img id="sp-img" alt="Trail camera photo" src="' + thumbURL(p) + '">' : '<span class="muted">No picture (this browser couldn’t open the file)</span>') + '</div>' +
      '<div class="sp-meta"><span class="mono">' + esc(d ? fmtDate(d) + ' ' + fmtTime(d) : 'No time yet') + '</span>' + (d && lightOf(d) ? ' ' + lightMark(lightOf(d)) + ' ' + LIGHT_LABEL[lightOf(d)] : '') +
      (!p.t ? ' · <a href="#/stamp/' + encodeURIComponent(p.id) + '">Read the stamp</a>' : '') + '<span class="grow"></span><span class="tiny">' + esc(p.name) + '</span></div>' +
      '<div class="tray">' + (sortSel.deer.length ? '' : suggestChip(p, 'sort-suggest')) + '<div class="bucks">' + S.deer.map(function (b) { return '<button class="tok named' + (sortSel.deer.indexOf(b.id) >= 0 ? ' on' : '') + '" data-deer="' + esc(b.id) + '">★ ' + esc(b.name) + '</button>'; }).join('') +
      '<button class="tok add" data-act="sort-newbuck">＋ Name a buck</button></div>' +
      '<div class="kinds">' + KINDS.slice(0, 4).map(function (k) { return '<button class="tok' + (sortSel.tags.indexOf(k.id) >= 0 ? ' on' : '') + '" data-kind="' + k.id + '">' + k.label + '</button>'; }).join('') + '</div>' +
      '<div class="commit"><button class="tok empty" data-act="sort-empty">Empty ⏭</button><button class="tok" data-act="sort-same"' + (sortLast ? '' : ' disabled') + '>Same as last</button><button class="tok on" data-act="sort-file" id="sort-file">File it ✓</button></div></div></div>';
    return h;
  };
  VIEWS.sort.full = true;
  function sortCommit(sel) {
    var p = PI[sortCur]; if (!p) return;
    if (!sel.tags.length && !sel.deer.length) { toast('Tap who’s in the photo, or Empty'); return; }
    sortUndo.push({ id: p.id, tags: p.tags.slice(), deer: p.deer.slice(), done: p.done });
    if (sortUndo.length > 50) sortUndo.shift();
    p.tags = sel.tags.slice(); p.deer = sel.deer.slice(); p.done = true;
    if (p.tags.indexOf('empty') < 0) sortLast = { tags: p.tags.slice(), deer: p.deer.slice() };
    photoPut(p); sortCur = null; render();
  }
  function sortClick(e) {
    var t = e.target.closest('[data-deer],[data-kind],[data-act]'); if (!t || !$('#sort-pass')) return false;
    var dId = t.getAttribute('data-deer'), kind = t.getAttribute('data-kind'), act = t.getAttribute('data-act');
    if (dId) { var i = sortSel.deer.indexOf(dId); if (i >= 0) sortSel.deer.splice(i, 1); else sortSel.deer.push(dId); sortSel.tags = sortSel.tags.filter(function (x) { return x !== 'empty'; }); render(); return true; }
    if (kind) { var j = sortSel.tags.indexOf(kind); if (j >= 0) sortSel.tags.splice(j, 1); else sortSel.tags.push(kind); render(); return true; }
    if (act === 'sort-file') { sortCommit(sortSel); return true; }
    if (act === 'sort-empty') { sortCommit({ tags: ['empty'], deer: [] }); return true; }
    if (act === 'sort-same') { if (sortLast) sortCommit(sortLast); return true; }
    if (act === 'sort-skip') { if (sortCur) sortSkip[sortCur] = 1; sortCur = null; render(); return true; }
    if (act === 'sort-newbuck') {
      if (!canAddBuck()) { proSheet('buck'); return true; }
      promptSheet('Name a buck', 'Something you’ll recognize, like “Big 8” or “Split G2”.', 'Add buck').then(function (name) {
        if (!name) return; var id = addBuck(name); if (id && sortSel) { sortSel.deer.push(id); render(); }
      });
      return true;
    }
    return false;
  }
  function sortUndoLast() {
    var u = sortUndo.pop(); if (!u) return; var p = PI[u.id]; if (!p) return;
    p.tags = u.tags; p.deer = u.deer; p.done = u.done; photoPut(p);
    delete sortSkip[p.id]; sortCur = p.id; sortSel = { tags: p.tags.slice(), deer: p.deer.slice() }; go('#/sort'); render();
  }

  /* ---------------- Stamp Reader ---------------- */
  // For photos with no time in the file: zoom into the strip where cams print the time, and type it.
  var stampBand = 'bottom', stampLastDate = '', stampFor = null;
  VIEWS.stamp = function () {
    var q = P.filter(function (p) { return !p.t; }).sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    var p = R.id && PI[R.id] && !PI[R.id].t ? PI[R.id] : q[0];
    var h = head('Stamp Reader', '#/');
    if (!p) return h + '<div class="paper welcome"><div class="big">🕑</div><h2 style="font-family:Georgia,serif">Every photo has a time</h2><p class="muted">When a camera doesn’t save the time in the file, those photos show up here so you can type the time printed on them.</p><a class="btn go" href="#/">Back to the Ledger</a></div>';
    var url = thumbURL(p), fd = parseLocal(p.fileT); if (stampFor !== p.id) { stampFor = p.id; stampY = null; stampX = 0; }
    h += '<p class="small muted" style="margin-top:-4px">' + plural(q.length, 'photo') + ' without a time · ' + esc(camName(p.cam)) + ' · <span class="mono">' + esc(p.name) + '</span></p>' +
      (url ? '<div class="stamp" id="stamp-zoom" data-band="' + stampBand + '"><canvas id="stamp-cv" aria-label="Zoomed time stamp"></canvas></div>' +
        '<div class="stamp-ctl"><label title="Slide sideways">⇆<input type="range" id="stamp-x" min="0" max="100" step="0.5" value="' + stampX + '"></label>' +
        '<label title="Move up or down">⇅<input type="range" id="stamp-y" min="0" max="100" step="0.25" value="0"></label>' +
        '<label title="Band size">⤢<input type="range" id="stamp-sz" min="50" max="250" step="5" value="' + Math.round(stampSize * 100) + '"></label></div>' +
        '<div class="btn-row" style="margin:8px 0"><button class="btn sm" data-act="stamp-band">' + (stampBand === 'bottom' ? 'Stamp is at the top' : 'Stamp is at the bottom') + '</button><button class="btn sm" data-act="stamp-pan">Slide ⇆</button></div>' +
        '<img class="stamp-full" alt="Full photo" src="' + url + '">' : '<div class="panel">No picture for this file.</div>') +
      '<div class="paper"><div class="dt2"><label class="field"><span>Date on the photo</span><input type="date" id="stamp-date" value="' + esc(stampLastDate) + '"></label><label class="field"><span>Time on the photo</span><input type="time" id="stamp-time" step="1"></label></div>' +
      '<label class="field"><span>Temp on the photo (°F, optional)</span><input type="number" id="stamp-temp" inputmode="numeric" min="-40" max="130" placeholder="e.g. 41"></label>' +
      '<button class="btn go block" data-act="stamp-save" data-id="' + esc(p.id) + '">Save time &amp; next</button>' +
      '<div class="btn-row" style="margin-top:8px">' + (fd ? '<button class="btn ink sm" data-act="stamp-filedate" data-id="' + esc(p.id) + '">Use file date (' + esc(fmtDate(fd) + ' ' + fmtTime(fd)) + ')</button>' : '') + '<button class="btn ink sm" data-act="stamp-skip" data-id="' + esc(p.id) + '">Skip</button></div>' +
      '<p class="tiny muted" style="margin:8px 0 0">The file date is often when the card was copied, not when the photo was taken. Only use it if you know it’s right.</p></div>';
    return h;
  };
  /* Stamp band. Works on screenshots too: black letterbox and phone status / app bars are trimmed first (rows or columns
     that are almost one solid colour, far from the photo), the band is sized from the photo's own shape, and the
     sliders move it anywhere on the whole image (sideways, up/down) and resize it. */
  var stampX = 0, stampSize = 1, stampY = null, stampImg = null, stampRect = null;
  function stampTrim(img) {
    var W = img.naturalWidth, H = img.naturalHeight, s = Math.min(1, 320 / Math.max(W, H)), w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h; var g = c.getContext('2d'); g.drawImage(img, 0, 0, w, h);
    // only screenshots / letterboxed frames: trail cams shoot 4:3 to 16:9, so a normal photo is never trimmed
    if (!(H / W > 1.5 || W / H > 2.1)) return { x: 0, y: 0, w: W, h: H, trimmed: false };
    var d; try { d = g.getImageData(0, 0, w, h).data; } catch (e) { return { x: 0, y: 0, w: W, h: H, trimmed: false }; }
    function lum(i) { return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; }
    function flat(n, at) {   // share of pixels on this line within 12 of the line's middle value
      var v = []; for (var k = 0; k < n; k++) v.push(lum(at(k)));
      var m = v.slice().sort(function (a, b) { return a - b; })[n >> 1], f = 0, sat = 0; if (m > 70 && m < 195) return 0;   // bars are black, dark grey, white or light grey
      v.forEach(function (x) { if (Math.abs(x - m) < 5) f++; });
      for (var k2 = 0; k2 < n; k2 += 4) { var i2 = at(k2); sat += Math.max(d[i2], d[i2 + 1], d[i2 + 2]) - Math.min(d[i2], d[i2 + 1], d[i2 + 2]); }
      return sat / Math.ceil(n / 4) > 24 ? Math.min(f / n, 0.9) : f / n;   // phone bars are black, grey or white, not coloured
    }
    function span(len, frac) {   // longest run of photo lines, then grow through stamp ribbons (short solid gaps allowed)
      var bar = frac.map(function (f) { return f > 0.98; }), best = [0, len], run = -1, bl = 0;
      for (var i = 0; i <= len; i++) { if (i < len && !bar[i]) { if (run < 0) run = i; } else if (run >= 0) { if (i - run > bl) { bl = i - run; best = [run, i]; } run = -1; } }
      if (bl < len * 0.12) return [0, len];
      var gap = Math.max(2, Math.round(bl * 0.03)), grow = Math.round(bl * 0.2);
      function ext(a, dir) {   // from the photo's edge outward: solid pad, then the stamp's text rows (kept), then the matching pad
        var padMax = Math.max(3, Math.round(bl * 0.04)), textMax = Math.round(bl * 0.2), p = a, p1 = 0, q;
        for (;;) { q = p + dir; if (q < 0 || q >= len) return dir > 0 ? len - 1 : 0; if (!bar[q]) break; if (p1 >= padMax) return a; p = q; p1++; }
        var t = 0, last = p, flatRun = 0, gapT = Math.max(2, p1);
        while (t < textMax) {
          q = p + dir; if (q < 0 || q >= len) return dir > 0 ? len - 1 : 0;
          if (bar[q]) { if (++flatRun > gapT) break; p = q; t++; continue; }
          flatRun = 0; p = q; t++; last = p;
        }
        if (t < 2 || t >= textMax) return a;
        var r = last + dir * (p1 + 1); return r < 0 ? 0 : r >= len ? len - 1 : r;
      }
      var a = ext(best[0], -1), b = ext(best[1] - 1, 1) + 1;
      if (a <= gap) a = 0; if (b >= len - gap) b = len;
      return [a, b];
    }
    var rf = []; for (var y = 0; y < h; y++) rf.push(flat(w, function (k) { return (y * w + k) * 4; }));
    var ry = span(h, rf), cf = [];
    for (var x = 0; x < w; x++) cf.push(flat(ry[1] - ry[0], function (k) { return ((ry[0] + k) * w + x) * 4; }));
    var rx = span(w, cf);
    var R2 = { x: Math.round(rx[0] / s), y: Math.round(ry[0] / s), w: Math.round((rx[1] - rx[0]) / s), h: Math.round((ry[1] - ry[0]) / s) };
    R2.w = Math.min(R2.w, W - R2.x); R2.h = Math.min(R2.h, H - R2.y); R2.trimmed = R2.w < W * 0.98 || R2.h < H * 0.98; return R2;
  }
  window.BLStampTrim = stampTrim;
  function stampGeom() {
    var img = stampImg, r = stampRect; if (!img || !r) return null;
    var W = img.naturalWidth, H = img.naturalHeight, wide = r.w >= r.h;
    var vw = Math.min(W, r.w * (wide ? 0.55 : 0.62) * stampSize), bh = Math.min(H, r.h * (wide ? 0.13 : 0.09) * stampSize);
    if (stampY === null) { var y0 = stampBand === 'bottom' ? r.y + r.h - bh : r.y; stampY = H > bh ? Math.max(0, Math.min(100, (y0 / (H - bh)) * 100)) : 0; }
    var x = (W - vw) * stampX / 100, y = (H - bh) * stampY / 100;
    return { x: x, y: y, w: vw, h: bh, W: W, H: H };
  }
  function stampDraw() {
    var cv = $('#stamp-cv'), box = $('#stamp-zoom'), G = stampGeom(); if (!cv || !box || !G) return;
    var cw = box.clientWidth || 340, ch = Math.round(cw * G.h / G.w);
    if (ch > 300) { ch = 300; } if (ch < 90) { ch = 90; }
    var sh = G.w * ch / cw, sy = Math.max(0, Math.min(G.H - sh, G.y + G.h / 2 - sh / 2));   // keep the picture undistorted
    var dpr = window.devicePixelRatio || 1; cv.style.height = ch + 'px'; cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    var g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.drawImage(stampImg, G.x, sy, G.w, Math.min(sh, G.H), 0, 0, cv.width, cv.height * Math.min(1, G.H / sh));
    var yi = $('#stamp-y'); if (yi && document.activeElement !== yi) yi.value = stampY;
    box.setAttribute('data-y', Math.round(G.y)); box.setAttribute('data-h', Math.round(G.h));
    window.__stampInfo = { rect: stampRect, band: stampBand, x: Math.round(G.x), y: Math.round(G.y), w: Math.round(G.w), h: Math.round(G.h), W: G.W, H: G.H, size: stampSize };
  }
  VIEWS.stamp.after = function () {
    var d = $('#stamp-date'); if (d && !d.value) d.focus();
    var cv = $('#stamp-cv'), full = $('.stamp-full'); if (!cv || !full) return;
    stampImg = null; stampRect = null; window.__stampInfo = null;
    var im = new Image(); im.onload = function () { if (!document.body.contains(cv)) return; stampImg = im; stampRect = stampTrim(im); stampDraw(); }; im.src = full.getAttribute('src');
    $('#stamp-x').addEventListener('input', function (e) { stampX = Number(e.target.value); stampDraw(); });
    $('#stamp-y').addEventListener('input', function (e) { stampY = Number(e.target.value); stampDraw(); });
    $('#stamp-sz').addEventListener('input', function (e) { var G0 = stampGeom(), c0 = G0 ? G0.y + G0.h / 2 : 0; stampSize = Number(e.target.value) / 100; if (G0) { var G1 = stampGeom(); stampY = G1.H > G1.h ? Math.max(0, Math.min(100, (c0 - G1.h / 2) / (G1.H - G1.h) * 100)) : 0; } stampDraw(); });
  };
  window.addEventListener('resize', function () { if ($('#stamp-cv')) stampDraw(); });
  function stampSave(id, useFile) {
    var p = PI[id]; if (!p) return;
    var v;
    if (useFile) { v = p.fileT; if (!v) return; p.tsrc = 'file'; }
    else {
      var dv = ($('#stamp-date') || {}).value, tv = ($('#stamp-time') || {}).value;
      if (!dv || !tv) { toast('Type both the date and the time'); return; }
      v = dv + 'T' + (tv.length === 5 ? tv + ':00' : tv.slice(0, 8));
      if (!parseLocal(v)) { toast('That date/time doesn’t look right'); return; }
      stampLastDate = dv; p.tsrc = 'stamp';
    }
    var tv2 = ($('#stamp-temp') || {}).value; if (tv2 !== undefined && tv2 !== '') { var tn = Number(tv2); if (isFinite(tn) && tn >= -40 && tn <= 130) { p.temp = Math.round(tn); p.tempSrc = 'typed'; } }
    p.t = v; photoPut(p); toast('Time saved'); go('#/stamp');
  }

  /* ---------------- Clock Check ---------------- */
  // Fix a whole camera's clock from ONE photo whose real time you know.
  function fmtOffset(m) {
    var a = Math.abs(m), d = Math.floor(a / 1440), h = Math.floor((a % 1440) / 60), mi = a % 60, parts = [];
    if (d) parts.push(plural(d, 'day')); if (h) parts.push(h + ' hr'); if (mi || !parts.length) parts.push(mi + ' min');
    return parts.join(' ');
  }
  VIEWS.clock = function () {
    var c = cam(R.id);
    if (!c) return head('Clock Check', '#/cams') + '<div class="panel">Pick a camera on the <a href="#/cams">Cameras</a> screen first.</div>';
    var photos = P.filter(function (p) { return p.cam === c.id && p.t; }).sort(function (a, b) { return a.t < b.t ? 1 : -1; });
    var h = head('Clock Check', '#/cam/' + encodeURIComponent(c.id)) + '<p class="muted small" style="margin-top:-4px">' + esc(c.name) + (c.offsetMin ? ' · current fix: clock ' + fmtOffset(c.offsetMin) + (c.offsetMin > 0 ? ' behind' : ' ahead') : ' · no clock fix') + '</p>';
    var sel = R.q.p && PI[R.q.p] && PI[R.q.p].cam === c.id && PI[R.q.p].t ? PI[R.q.p] : null;
    if (!sel) {
      h += '<div class="paper"><h3>1. Pick a photo you know the real time of</h3><p class="small muted">Tip: the last photo on a card is often you walking up to pull it, and you know when that was. Or snap the cam with your phone’s clock in view when you set it.</p>';
      if (!photos.length) h += '<p class="small">No photos with a time from this camera yet.</p>';
      h += '<div class="pgrid" id="clock-grid">' + photos.slice(0, 30).map(function (p) { var d = parseLocal(p.t); return '<a href="#/clock/' + encodeURIComponent(c.id) + '?p=' + encodeURIComponent(p.id) + '">' + (p.thumb ? '<img alt="" loading="lazy" src="' + thumbURL(p) + '">' : '') + '<span class="cap">' + esc(fmtDate(d) + ' ' + fmtTime(d)) + '</span></a>'; }).join('') + '</div>';
      if (photos.length > 30) h += '<p class="tiny muted" style="margin:6px 0 0">Showing the 30 newest.</p>';
      h += (c.offsetMin ? '<hr><button class="btn ink block" data-act="clock-clear" data-cam="' + esc(c.id) + '">Remove the clock fix</button>' : '') + '</div>';
      return h;
    }
    var rec = parseLocal(sel.t);
    h += '<div class="paper">' + (sel.thumb ? '<img class="photo-big" alt="" src="' + thumbURL(sel) + '">' : '') +
      '<p style="margin:10px 0 6px">The camera recorded: <b class="mono">' + esc(fmtDate(rec) + ' ' + fmtTime(rec)) + '</b></p>' +
      '<h3>2. When was it really taken?</h3><div class="dt2"><label class="field"><span>Real date</span><input type="date" id="clock-date" value="' + esc(sel.t.slice(0, 10)) + '"></label><label class="field"><span>Real time</span><input type="time" id="clock-time" value="' + esc(sel.t.slice(11, 16)) + '"></label></div>' +
      '<p id="clock-preview" class="small"></p>' +
      '<button class="btn go block" data-act="clock-apply" data-cam="' + esc(c.id) + '" data-p="' + esc(sel.id) + '">Fix this camera’s clock</button>' +
      '<a class="btn ink block" style="margin-top:8px" href="#/clock/' + encodeURIComponent(c.id) + '">Pick a different photo</a></div>';
    return h;
  };
  function clockOffsetFromInputs(p) {
    var dv = ($('#clock-date') || {}).value, tv = ($('#clock-time') || {}).value;
    var real = dv && tv ? parseLocal(dv + 'T' + tv.slice(0, 5) + ':' + (p.t.slice(17, 19) || '00')) : null, rec = parseLocal(p.t);
    if (!real || !rec) return null;
    return Math.round((real - rec) / 60000);
  }
  VIEWS.clock.after = function () {
    var p = R.q.p && PI[R.q.p]; if (!p || !$('#clock-date')) return;
    function upd() {
      var o = clockOffsetFromInputs(p), el = $('#clock-preview'), n = P.filter(function (x) { return x.cam === p.cam; }).length;
      if (!el) return;
      el.innerHTML = o === null ? 'Type the real date and time.' : o === 0 ? 'That matches: the clock was right. Applying removes any fix.' :
        'This camera’s clock was <b>' + fmtOffset(o) + (o > 0 ? ' behind' : ' ahead') + '</b>. All ' + plural(n, 'photo') + ' from it will be corrected.';
    }
    ['clock-date', 'clock-time'].forEach(function (id) { $('#' + id).addEventListener('input', upd); });
    upd();
  };

  /* ---------------- Photo ---------------- */
  VIEWS.photo = function () {
    var p = PI[R.id];
    if (!p) return head('Photo', '#/') + '<div class="panel">That photo isn’t here anymore.</div>';
    var d = eff(p), rec = parseLocal(p.t), c = cam(p.cam), l = lightOf(d), note = sunNote(d);
    var src = { exif: 'from the photo file', stamp: 'typed from the stamp', file: 'file date' }[p.tsrc] || '';
    var h = head('Photo', '#/') + (p.thumb ? '<img class="photo-big" alt="Trail camera photo" src="' + thumbURL(p) + '" style="margin-bottom:12px">' : '');
    h += '<div class="paper"><p style="margin:0 0 4px"><b class="mono">' + esc(d ? fmtDate(d) + ' ' + fmtTime(d) : 'No time yet') + '</b> · ' + esc(camName(p.cam)) + '</p>' +
      '<p class="small muted" style="margin:0 0 6px">' + (src ? 'Time ' + src : '') + (c && c.offsetMin && rec ? ' · camera said ' + esc(fmtTime(rec)) + ', clock fix applied' : '') + '</p>' +
      (l ? '<p class="small" style="margin:0 0 6px">' + lightMark(l) + ' ' + LIGHT_LABEL[l] + (note ? ' · ' + esc(note) : '') + '</p>' : '') +
      (d ? visitDetailsPhoto(p) : '') + suggestChip(p, 'ph-suggest') +
      '<hr><h3>Who’s in it</h3><div style="display:flex;flex-wrap:wrap;gap:6px">' + S.deer.map(function (b) { return '<button class="tok named' + (p.deer.indexOf(b.id) >= 0 ? ' on' : '') + '" data-ptoggle="deer:' + esc(b.id) + '">★ ' + esc(b.name) + '</button>'; }).join('') +
      KINDS.map(function (k) { return '<button class="tok' + (p.tags.indexOf(k.id) >= 0 ? ' on' : '') + '" data-ptoggle="' + k.id + '">' + k.label + '</button>'; }).join('') + '</div>' +
      photoExtras(p) +
      '<hr><h3>Fix the time</h3><div class="dt2"><label class="field"><span>Date on the photo</span><input type="date" id="ph-date" value="' + esc(p.t ? p.t.slice(0, 10) : '') + '"></label><label class="field"><span>Time on the photo</span><input type="time" id="ph-time" step="1" value="' + esc(p.t ? p.t.slice(11, 19) : '') + '"></label></div>' +
      '<button class="btn ink block" data-act="ph-time" data-id="' + esc(p.id) + '">Save time</button>' +
      '<p class="tiny muted" style="margin:6px 0 0">Type what the camera recorded. A Clock Check fix for the camera is added on top.</p>' +
      '<hr><button class="btn danger block" data-act="ph-del" data-id="' + esc(p.id) + '">Delete this photo</button><p class="tiny muted" style="margin:6px 0 0">' + esc(p.name) + '</p></div>';
    return h;
  };

  /* ---------------- Bucks ---------------- */
  VIEWS.bucks = function () {
    var h = head('Your Bucks');
    h += '<div class="paper">';
    if (!S.deer.length) h += '<p class="muted" style="margin:0 0 10px">Name the bucks you recognize. Tag them in the Sort Pass and each one gets his own page: Day Ring, Season Strip and what his visits add up to.</p>';
    var shown = visibleDeer(), hidden = S.deer.length - shown.length;
    h += '<ul class="list">' + shown.map(function (b) {
      var vs = visits('deer:' + b.id), last = vs[0], cover = (b.photo && PI[b.photo]) || (last ? last.photos[0] : null), t = tally(vs);
      return '<li><a class="item" href="#/buck/' + encodeURIComponent(b.id) + '">' + (cover && cover.thumb ? '<img class="thumb" alt="" src="' + thumbURL(cover) + '">' : '<span class="thumb">★</span>') +
        '<span class="t"><b>' + esc(b.name) + (b.points !== null ? ' <span class="pts">' + b.points + ' pts</span>' : '') + '</b><span>' + plural(vs.length, 'visit') + (last ? ' · last ' + esc(fmtDate(last.d)) + (hasLoc() ? ' · ' + (t.light.day + t.light.light) + ' in daylight' : '') : '') + '</span></span><span>›</span></a></li>';
    }).join('') + '</ul>' +
      '<p class="small" style="margin:8px 0 0" id="small-filter">' + (S.settings.hideSmall ? (hidden ? plural(hidden, 'small buck') + ' hidden (' + S.settings.smallMax + ' points or less). ' : 'Small bucks (' + S.settings.smallMax + ' points or less) are hidden. ') + '<button class="btn sm plain" data-act="small-show">Show all</button>' : 'Showing all bucks. <button class="btn sm plain" data-act="small-hide">Hide small bucks</button>') + '</p>';
    h += '<a class="btn ink block" style="margin-top:10px" href="#/predict">Predictions</a>';
    h += (canAddBuck() ? '<div style="display:flex;gap:8px;margin-top:10px"><input type="text" id="new-buck" maxlength="60" placeholder="New buck name, e.g. Big 8"><button class="btn go" data-act="add-buck">Add</button></div>' : '<p class="small muted" style="margin:10px 0 0">' + freeLine('buck') + '</p>') + '</div>';
    var allB = visits('bucks'), unnamed = allB.filter(function (v) { return v.photos.every(function (p) { return !p.deer.length; }); });
    if (unnamed.length) h += '<div class="panel small">' + plural(unnamed.length, 'buck visit') + ' tagged just “Buck”. Open them from the <a href="#/">Ledger</a> to name him later.</div>';
    return h;
  };
  VIEWS.buck = function () {
    var b = deer(R.id);
    if (!b) return head('Buck', '#/bucks') + '<div class="panel">That buck isn’t in your ledger anymore.</div>';
    var vs = visits('deer:' + b.id), t = tally(vs);
    var h = head(b.name, '#/bucks', 'brand');
    if (!vs.length) {
      h += '<div class="paper"><p style="margin:0">No visits yet' + (vs.noTime ? ' (' + plural(vs.noTime, 'photo') + ' still need a time: <a href="#/stamp">Stamp Reader</a>)' : '') + '. Tag him in the <a href="#/sort">Sort Pass</a> and his pattern builds here.</p></div>';
    } else {
      h += '<div class="paper"><h3>Day Ring</h3><div class="ring-wrap">' + dayRing(vs) + '</div>' + legend() + '<p class="tiny muted" style="margin:4px 0 0">Midnight at the bottom, noon at the top. Each dot is one visit.' + (hasLoc() ? ' Shading uses real sunrise/sunset for ' + esc(fmtDate(vs[Math.floor(vs.length / 2)].d)) + '.' : '') + '</p></div>';
      h += '<div class="paper"><h3>Season Strip</h3>' + seasonStrip(vs) + '<p class="tiny muted" style="margin:4px 0 0">' + (hasLoc() ? 'Gold: seen in legal light that day. Navy: only after dark.' : 'Tan: seen that day. Add your property location to split daylight from dark.') + '</p></div>';
      h += '<div class="paper" id="plain-read"><h3>What it means</h3><ul class="read">' + plainRead(vs).map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul></div>';
      h += '<div class="paper"><h3>By camera</h3>' + Object.keys(t.byCam).sort(function (a, c2) { return t.byCam[c2] - t.byCam[a]; }).map(function (k) {
        return '<div class="camcount"><span>' + esc(camName(k === '_' ? null : k)) + '</span><b>' + plural(t.byCam[k], 'visit') + (hasLoc() ? ' <span class="muted" style="font-weight:400">· ' + (t.litByCam[k] || 0) + ' daylight</span>' : '') + '</b></div>';
      }).join('') + '</div>';
      h += '<div class="ledger">' + vs.slice(0, 40).map(function (v) {
        var cover = v.photos[0];
        return '<button class="lrow" data-visit="' + esc(cover.id) + '" data-sub="deer:' + esc(b.id) + '"><span class="tm">' + esc(fmtTime(v.d).replace(' ', '')) + '</span>' + lightMark(v.light) + '<span class="who"><b>' + esc(fmtDate(v.d)) + '</b><span>' + esc(camName(v.cam)) + (function () { var cp = companionsOf(v, 'deer:' + b.id); return cp.length ? ' · with ' + esc(cp.join(', ')) : ''; })() + '</span></span><span class="n">' + (v.photos.length > 1 ? '×' + v.photos.length : '') + '</span>' + (cover.thumb ? '<img alt="" loading="lazy" src="' + thumbURL(cover) + '">' : '') + '</button>';
      }).join('') + '</div>';
    }
    h += buckExtras(b, vs);
    h += '<div class="paper" style="margin-top:12px"><label class="field"><span>Name</span><input type="text" id="buck-name" maxlength="60" value="' + esc(b.name) + '"></label>' +
      '<label class="field"><span>Points (antler points, for the small-buck filter)</span><input type="number" id="buck-points" min="0" max="40" inputmode="numeric" value="' + (b.points === null ? '' : b.points) + '" placeholder="e.g. 8"></label><label class="field"><span>Notes</span><textarea id="buck-notes" maxlength="2000" placeholder="Rack, marks, where he beds…">' + esc(b.notes) + '</textarea></label>' +
      '<button class="btn ink block" data-act="buck-save" data-id="' + esc(b.id) + '">Save</button><button class="btn danger block" style="margin-top:8px" data-act="buck-del" data-id="' + esc(b.id) + '">Remove this buck</button></div>';
    return h;
  };
  VIEWS.buck.after = function () { var s = $('#season-strip'); if (s) s.scrollLeft = s.scrollWidth; };

  /* ---------------- Cameras ---------------- */
  VIEWS.cams = function () {
    var h = head('Cameras') + '<div class="paper">';
    if (!S.cameras.length) h += '<p class="muted" style="margin:0 0 10px">Cameras are added when you log a pull.</p>';
    h += '<ul class="list">' + S.cameras.map(function (c) {
      var n = P.filter(function (p) { return p.cam === c.id; }).length, pulls = S.pulls.filter(function (u) { return u.cam === c.id; }).length;
      return '<li><a class="item" href="#/cam/' + encodeURIComponent(c.id) + '"><span class="thumb">📷</span><span class="t"><b>' + esc(c.name) + '</b><span>' + plural(n, 'photo') + ' · ' + plural(pulls, 'pull') + (c.offsetMin ? ' · clock fixed' : '') + '</span></span><span>›</span></a></li>';
    }).join('') + '</ul>';
    h += '<a class="btn go block" style="margin-top:10px" href="#/pull">Log a Pull</a>' + (!canAddCam() ? '<p class="small muted" style="margin:8px 0 0">' + freeLine('cam') + '</p>' : '') + '</div>';
    return h;
  };
  VIEWS.cam = function () {
    var c = cam(R.id);
    if (!c) return head('Camera', '#/cams') + '<div class="panel">That camera isn’t here anymore.</div>';
    var vs = visits('all', c.id), t = tally(vs), bucksHere = {};
    vs.forEach(function (v) { v.photos.forEach(function (p) { p.deer.forEach(function (d) { bucksHere[d] = (bucksHere[d] || 0) + 1; }); }); });
    var h = head(c.name, '#/cams', 'brand');
    h += '<div class="paper"><p style="margin:0 0 6px"><b>' + plural(t.n, 'deer visit') + '</b>' + (hasLoc() && t.n ? ' · ' + (t.light.day + t.light.light) + ' in daylight' : '') + '</p>' +
      (Object.keys(bucksHere).length ? '<p class="small" style="margin:0 0 6px">Named bucks here: ' + Object.keys(bucksHere).map(function (d) { var b = deer(d); return b ? '<a href="#/buck/' + encodeURIComponent(d) + '">' + esc(b.name) + '</a>' : ''; }).join(', ') + '</p>' : '') +
      '<p class="small muted" style="margin:0">Clock: ' + (c.offsetMin ? 'fixed, it was ' + fmtOffset(c.offsetMin) + (c.offsetMin > 0 ? ' behind' : ' ahead') : 'no fix applied') + '</p>' +
      '<a class="btn ink block" style="margin-top:10px" href="#/clock/' + encodeURIComponent(c.id) + '">Clock Check</a></div>';
    if (vs.length) h += '<div class="paper"><h3>Deer visits by time of day</h3><div class="ring-wrap">' + dayRing(vs) + '</div>' + legend() + '</div>';
    h += camExtras(c);
    h += '<div class="paper"><label class="field"><span>Camera name</span><input type="text" id="cam-name" maxlength="60" value="' + esc(c.name) + '"></label><button class="btn ink block" data-act="cam-save" data-id="' + esc(c.id) + '">Save name</button>' +
      '<button class="btn danger block" style="margin-top:8px" data-act="cam-del" data-id="' + esc(c.id) + '">Delete camera and its photos</button></div>';
    return h;
  };

  /* ---------------- More: location, settings, backup, Pro ---------------- */
  // Field Tips: free for every tier (a hook). Plain words, each with its published source, and a Share button (native share sheet only).
  function fieldTipsHtml() {
    if (!window.BLTips) return '';
    return '<div class="paper" id="field-tips"><h3>Field Tips</h3><p class="small muted">How air acts over water, fields, soil and woods. Free on every plan. Tap a spot in the 3D sim to see the tip for it.</p>' +
      BLTips.all.map(function (t) {
        return '<div class="tip" data-tip="' + t.id + '"><h4>' + esc(t.title) + '</h4><p class="small">' + esc(t.text) + '</p>' +
          '<p class="tiny muted">Source: ' + t.src.map(function (x) { return '<a href="' + esc(x.url) + '" target="_blank" rel="noopener">' + esc(x.name) + '</a> <span>(' + esc(x.v) + ')</span>'; }).join('; ') + '</p>' +
          '<button class="btn sm ink" data-tip-share="' + t.id + '">Share</button></div>';
      }).join('') + '</div>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-tip-share]'); if (!b || !window.BLTips) return;
    BLTips.share(b.getAttribute('data-tip-share')).then(function (r) { if (r === 'copied') toast('Tip copied. Paste it anywhere to share.'); });
  });
  VIEWS.more = function () {
    var st = S.settings;
    var h = head('More');
    h += fieldTipsHtml();
    var t = tier(), L = st.license;
    h += '<div class="paper" id="pro"><h3>Your plan: ' + TIER_NAME[t] + '</h3>';
    if (t !== 'free') {
      h += '<p style="margin:0 0 6px">✓ ' + TIER_NAME[t] + ' is unlocked on this phone' + (L.source === 'dev' ? ' (dev test code)' : '') + '.</p><p class="small muted">License key: <b>' + esc(maskKey(L.key)) + '</b>' + (L.upgrade ? ' + upgrade key <b>' + esc(maskKey(L.upgrade.key)) + '</b>' : '') + (L.verifiedAt ? ' · checked ' + fmtDay(L.verifiedAt) : '') + '. Keep your Gumroad receipt' + (L.upgrade ? 's' : '') + ' so you can enter the key' + (L.upgrade ? 's' : '') + ' again on a new phone' + (L.upgrade ? ' (Pro key first, then the upgrade key)' : '') + '.</p>';
    } else if (L && L.revokedAt) {
      h += '<p class="small" style="color:#9a2f1c">' + esc(L.reason || 'Your license is no longer active.') + '</p>';
    }
    h += '<div class="tiers">' +
      '<div class="tier' + (t === 'free' ? ' cur' : '') + '"><b>Free</b><span>' + plural(C.FREE_CAMERA_LIMIT || 0, 'camera') + ', ' + plural(C.FREE_BUCK_LIMIT || 0, 'named buck') + ', ' + plural(C.FREE_PRED_LIMIT || 1, 'prediction') + '</span></div>' +
      '<div class="tier' + (t === 'pro' ? ' cur' : '') + '"><b>Pro' + (priceOf('pro') ? ' · ' + esc(priceOf('pro')) : '') + '</b><span>' + plural(C.PRO_CAMERA_LIMIT || 0, 'camera') + ', ' + plural(C.PRO_BUCK_LIMIT || 0, 'named buck') + ', ' + (C.PRO_OPEN_PRED_LIMIT || 3) + ' open predictions</span></div>' +
      '<div class="tier' + (t === 'elite' ? ' cur' : '') + '"><b>Elite' + (priceOf('elite') ? ' · ' + esc(priceOf('elite')) : '') + '</b><span>Unlimited cameras, bucks &amp; predictions + 3D Terrain Sim</span></div></div>' +
      '<p class="tiny muted" style="margin:6px 0 10px">' + esc(C.PRO_PRICE_NOTE || '') + '</p>';
    if (t === 'free') h += buyBtn('pro', 'Get Pro') + '<div style="height:8px"></div>' + buyBtn('elite', 'Get Elite');
    if (t === 'pro') h += buyBtn('upgrade', 'Upgrade to Elite') + '<p class="tiny muted" style="margin:6px 0 0">For Pro owners: pay just the difference. Enter the upgrade key below; it works together with your Pro key.</p>';
    if (proOnSale() || L) {
      h += '<label class="field" style="margin-top:12px"><span>' + (t !== 'free' ? 'Enter another key (upgrade or re-check)' : 'Have a license key?') + '</span><input type="text" id="lic" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="From your Gumroad receipt"></label>' +
        '<button class="btn ink block" data-act="unlock">' + (t !== 'free' ? 'Check key' : 'Unlock') + '</button><p class="small" id="lic-msg" style="margin:8px 0 0"></p>' +
        '<p class="tiny muted" style="margin:4px 0 0">Activating needs internet once. Your key is sent only to Gumroad to check it. Purchases, support and refunds are handled through Gumroad.</p>';
    } else if (C.DEV_MODE) {
      h += '<label class="field" style="margin-top:12px"><span>Test code</span><input type="text" id="lic"></label><button class="btn ink block" data-act="unlock">Unlock</button><p class="small" id="lic-msg"></p>';
    }
    h += '</div>';
    h += '<div class="paper" id="research-links"><h3>Your states &amp; research</h3><p class="small muted" style="margin:0 0 8px">' + (S.settings.states.length ? esc(S.settings.states.map(function (a) { return SD()[a].name; }).join(', ')) : 'No state picked yet.') + '</p><div class="btn-row"><a class="btn ink" href="#/states">Pick states</a><a class="btn ink" href="#/research">Research</a></div></div>';
    h += '<div class="paper" id="weather"><h3>Weather for your visits</h3><p class="small muted" style="margin:0 0 8px">Hourly wind, gusts, temp, rain, pressure and cloud for each visit, from Open-Meteo. Only when you tap: it sends your property location and the dates, nothing else. Saved on this phone.</p><button class="btn ink block" data-act="wx-visits">Get weather for my visits</button></div>';
    h += '<div class="paper" id="tcl-card"><h3>Trail Cam Link' + (isPro() ? '' : ' <span class="tiny muted">Pro</span>') + '</h3><p class="small muted" style="margin:0 0 8px">Card photos, camera spots and every buck in one place.</p><a class="btn ink block" href="#/tcl">Open Trail Cam Link</a></div>';
    h += '<div class="paper" id="pins-card"><h3>Bring Your Pins' + (isPro() ? '' : ' <span class="tiny muted">Pro</span>') + '</h3><p class="small muted" style="margin:0 0 8px">Your stands, cameras and signs from a GPX, KML or KMZ file.</p><a class="btn ink block" href="#/pins">' + (S.pins.length ? 'Your pins (' + S.pins.length + ')' : 'Bring your pins') + '</a></div>';
    h += '<div class="paper" id="location"><h3>Property location</h3><p class="small muted" style="margin:0 0 8px">Used on this phone for sunrise, sunset, moon and shooting light. It is sent only when you tap “Get weather” (to Open-Meteo) or “Get USGS elevation” (box corners, to USGS).</p>' +
      '<div class="dt2" style="grid-template-columns:1fr 1fr"><label class="field"><span>Latitude</span><input type="text" inputmode="decimal" id="lat" value="' + (st.lat === null ? '' : st.lat) + '" placeholder="e.g. 30.12"></label><label class="field"><span>Longitude</span><input type="text" inputmode="decimal" id="lng" value="' + (st.lng === null ? '' : st.lng) + '" placeholder="e.g. -96.45"></label></div>' +
      '<div class="btn-row"><button class="btn ink" data-act="loc-here">Use my location</button><button class="btn ink" data-act="loc-save">Save</button></div>' +
      '<p class="tiny muted" style="margin:6px 0 0">Tip: stand on your property and tap “Use my location”. West longitudes are negative.</p></div>';
    h += '<div class="paper"><h3>Ledger settings</h3><label class="field"><span>Shooting light: minutes before sunrise and after sunset</span><input type="number" id="shoot" min="0" max="90" value="' + st.shootMin + '"></label>' +
      '<p class="tiny muted" style="margin:-6px 0 10px">Most states allow 30 minutes. Check your state’s rules.</p>' +
      '<label class="field"><span>Visit gap: photos this many minutes apart or less count as one visit</span><input type="number" id="gap" min="1" max="240" value="' + st.gapMin + '"></label>' +
      '<button class="btn ink block" data-act="settings-save">Save settings</button></div>';
    h += '<div class="paper" id="backup"><h3>Backup &amp; export</h3><p class="small muted" style="margin:0 0 8px">Everything lives only on this phone. A backup file is yours to keep (Files, iCloud Drive, Google Drive…).' + (st.lastBackup ? ' Last backup: ' + fmtDay(st.lastBackup) + '.' : '') + '</p>' +
      '<button class="btn go block" data-act="backup-full">Save backup (with photos)</button>' +
      '<div class="btn-row" style="margin-top:8px"><button class="btn ink" data-act="backup-data">Backup without photos</button><button class="btn ink" data-act="restore">Restore a backup</button></div>' +
      '<button class="btn ink block" style="margin-top:8px" data-act="csv">Export the Ledger (CSV)</button>' +
      '<input type="file" id="restore-file" accept="application/json,.json" hidden></div>';
    var empties = P.filter(function (p) { return p.done && p.tags.indexOf('empty') >= 0; }).length;
    h += '<div class="paper"><h3>Storage</h3><p class="small" style="margin:0 0 8px">' + plural(P.length, 'photo') + ' stored · ' + plural(empties, 'empty photo') + '</p>' +
      (empties ? '<button class="btn ink block" data-act="del-empties">Delete the ' + plural(empties, 'empty photo') + '</button>' : '') +
      '<button class="btn danger block" style="margin-top:8px" data-act="erase">Erase everything</button></div>';
    h += '<div class="paper small"><h3>About</h3><p>' + esc(APP) + ' is a trail cam logbook built by a hunter. No account, no ads, no trackers, no subscription. Photos are shrunk and kept in this browser’s storage on this phone; they are never uploaded.</p><p style="margin:0"><a href="privacy.html">Privacy</a> · Version 3.0.0</p></div>';
    return h + installNote();
  };

  /* ---------------- Simulator (Elite): the 3D Terrain Sim only. The property map editor (sim.js) only marks bedding, food and stands for it ---------------- */
  var simApi = null, simDemo = null;
  VIEWS.sim = function () {
    var h = head('Simulator');
    if (R.q.v === 'map' && isElite()) return h + '<div class="paper"><h3>Property map</h3><p class="small muted" style="margin:0 0 8px">Mark your bedding, food and stands. The 3D Terrain Sim lays them on your real ground.</p><div id="map-root"></div><a class="btn ink block" style="margin-top:8px" href="#/sim">Back to the 3D sim</a></div>';
    return h + sim3dHtml();
  };
  VIEWS.sim.after = function () {
    if (R.q.v === 'map' && isElite()) {
      var el = $('#map-root'); if (!el || !window.BuckSim) return;
      simApi = window.BuckSim.mount(el, {
        getMap: function () { return S.map; },
        saveMap: function (m) { S.map = window.BuckSim.clean(m); save(); },
        cameras: function () { return S.cameras.map(function (c) { return { id: c.id, name: c.name }; }); },
        toast: function (m) { toast(m); }
      });
      return;
    }
    mount3d();
  };
  // Property clock: the hour on the slider is the property's own hour. With saved weather, Open-Meteo's instants
  // (timezone picked from the property's spot) set it exactly; without, the phone's clock stands in.
  function siteEntry(box, day, h) { return window.BLWx && BLWx.siteHour ? BLWx.siteHour(WX, box.lat, box.lng, ymdOf(day), h) : null; }
  function siteAt(box, d) {
    var c = WX['site:' + (window.BLWx ? BLWx.key(box.lat, box.lng) : '')] || {}, t = d.getTime(), hit = null;
    Object.keys(c).forEach(function (k) { (c[k] || []).forEach(function (e) { if (e && e.e === t) hit = e; }); });
    return hit;
  }
  /* Aerial photo for the buyer's own box: USGS The National Map "USGS Imagery Only" (mostly USDA NAIP), public domain
     (USGS FAQ "What are the Terms of Use/Licensing for map services and data from The National Map?"). Fetched only when the
     3D view opens; the same box as the elevation, so the photo lines up with the ground. */
  function usgsImageURL(box) { return BLTerrain.imageURL(box, 1536, 1997); }
  var DEMO_BOX = { lat: 38, lng: -90 };   // made-up mid-US spot, only for sunrise/sunset on the Example property
  function engineHost(o) {
    o = o || {};
    var map = o.map || S.map, flat = !!o.flat;
    var box = (S.t3 && S.t3.box) || { lat: hasLoc() ? S.settings.lat : DEMO_BOX.lat, lng: hasLoc() ? S.settings.lng : DEMO_BOX.lng, acres: map ? map.acres : 160 };
    if (flat && !(S.t3 && S.t3.box) && map) box = { lat: box.lat, lng: box.lng, acres: map.acres };
    function demOK() { return !!(DEM && S.t3 && S.t3.box && DEM.key === demKey(S.t3.box)) && (!flat || !map || !map.example); }
    return {
      flat: flat, hour: new Date().getHours(), day: t3Day || new Date(), hasDem: function () { return !!(map && map.example) || demOK(); },
      dem: function () { if (map && map.example) return BLTerrain.exampleDem(); return demOK() ? DEM.z : (flat ? new Float32Array(BLTerrain.NX * BLTerrain.NY) : null); },
      map: function () { return map; }, box: function () { return box; },
      aerial: function () { return map && map.example ? 'data/example-aerial.jpg' : usgsImageURL(box); },
      fine: function () { return null; },
      fineDem: function () { return map && map.example ? null : BLTerrain.demURL(box, BLTerrain.NX * 3, BLTerrain.NY * 3); },
      parking: function () { return o.parking || (S.t3 && S.t3.parking) || []; }, sunTimes: function (d) { return sunTimes(d, box.lat, box.lng); },
      when: function (day, h) { var e = siteEntry(box, day, h); return e ? new Date(e.e) : new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, 0, 0); },
      air: function (d) { var h = siteAt(box, d); return h && h.wd !== null ? { wd: h.wd, ws: h.ws || 0, cc: h.cc, t: h.t } : null; },
      manualAir: function () { return { wd: MANUAL_WIND.wd, ws: MANUAL_WIND.ws, cc: 30 }; },
      airNote: function (d) {
        var h = siteAt(box, d);
        if (h && h.wd !== null) return '<p class="tiny muted" style="margin:4px 0">Real weather for this day (Open-Meteo), on the property’s own clock.</p>';
        return '<div class="t3-manual"><p class="tiny muted" style="margin:4px 0">No weather saved for this day. <button class="btn sm ink" data-act="t3-wx">Get weather for this day</button> or pick the wind:</p>' +
          '<div class="btn-row"><select id="t3-wd" aria-label="Wind from">' + C8L.map(function (n, i) { return '<option value="' + (i * 45) + '"' + (i * 45 === MANUAL_WIND.wd ? ' selected' : '') + '>From the ' + n + '</option>'; }).join('') + '</select>' +
          '<select id="t3-ws" aria-label="Wind strength">' + WIND_WORDS.map(function (w) { return '<option value="' + w[1] + '"' + (w[1] === MANUAL_WIND.ws ? ' selected' : '') + '>' + w[0] + '</option>'; }).join('') + '</select></div></div>';
      },
      onDay: function (d) { t3Day = d; }
    };
  }
  function engines() { return [t3Api, simApi && simApi.engine && simApi.engine()].filter(Boolean); }

  /* ================= v3: sun period, moon, weather, heading, bait, companions ================= */
  var WX = {};      // hourly weather cache (kv 'wx'). Re-fetchable, so it is NOT put in backups.
  var DEM = null;   // { key, z: Float32Array, at } USGS elevation for the 3D sim (kv 'dem'). Not in backups.
  function wxSave() { if (DB) kvPut('wx', WX).catch(function () {}); }
  function ymdOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayFrom(s) { var p = String(s).split('-'); return new Date(+p[0], p[1] - 1, +p[2], 12, 0, 0); }
  var PERIOD_LABEL = { dawn: 'Dawn', day: 'Day', dusk: 'Dusk', night: 'Night' };
  // Dawn / dusk = within 45 minutes either side of sunrise / sunset.
  function periodOf(d) {
    if (!d || !hasLoc()) return null;
    var st = sunTimes(d, S.settings.lat, S.settings.lng); if (st.polar) return st.polar === 'day' ? 'day' : 'night';
    var t = d.getTime(), r = st.rise.getTime(), s2 = st.set.getTime(), w = 45 * 60000;
    if (Math.abs(t - r) <= w) return 'dawn'; if (Math.abs(t - s2) <= w) return 'dusk';
    return t > r && t < s2 ? 'day' : 'night';
  }
  function sunMins(d) {
    if (!d || !hasLoc()) return null; var st = sunTimes(d, S.settings.lat, S.settings.lng); if (st.polar) return null;
    return { rise: Math.round((d - st.rise) / 60000), set: Math.round((d - st.set) / 60000) };
  }
  function moonEmoji(ph) { return ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'][Math.round(ph * 8) % 8]; }
  function moonInfo(d) {
    if (!window.BLAstro || !d) return null;
    var m = BLAstro.moonAt(d, hasLoc() ? S.settings.lat : null, hasLoc() ? S.settings.lng : null), t = hasLoc() ? BLAstro.moonTimes(d, S.settings.lat, S.settings.lng) : null;
    return { name: m.name, pct: Math.round(m.fraction * 100), up: m.up, rise: t && t.rise, set: t && t.set, emoji: moonEmoji(m.phase) };
  }
  function moonLine(d) {
    var m = moonInfo(d); if (!m) return '';
    return m.emoji + ' ' + m.name + ', ' + m.pct + '% lit' + (m.up === null ? '' : m.up ? ' · moon up' : ' · moon down') +
      (m.rise || m.set ? ' · ' + (m.rise ? 'rose ' + fmtTime(m.rise) : '') + (m.rise && m.set ? ', ' : '') + (m.set ? 'set ' + fmtTime(m.set) : '') : '') + ' <span class="weak">weak evidence</span>';
  }
  function wxAt(d) { return (hasLoc() && window.BLWx && d) ? BLWx.hourAt(WX, S.settings.lat, S.settings.lng, d) : null; }
  function wxLine(d) {
    var h = wxAt(d); if (!h) return '';
    var h3 = wxAt(new Date(d.getTime() - 3 * 36e5)), tr = (h.p !== null && h3 && h3.p !== null) ? (h.p - h3.p >= 1 ? ' rising' : h.p - h3.p <= -1 ? ' falling' : ' steady') : '';
    var fr = BLWx.front(WX, S.settings.lat, S.settings.lng, d);
    return 'Wind ' + BLWx.compass(h.wd) + ' ' + Math.round(h.ws || 0) + ' mph' + (h.wg ? ' (gusts ' + Math.round(h.wg) + ')' : '') + ' · ' + (h.t === null ? '' : Math.round(h.t) + '°F air') +
      (h.p !== null ? ' · pressure ' + Math.round(h.p) + ' hPa' + tr : '') + (h.r ? ' · rain ' + h.r.toFixed(2) + ' in' : '') + (h.cc !== null ? ' · ' + Math.round(h.cc) + '% cloud' : '') +
      (fr === 'cold' ? '<br><b>A cold front likely passed in the last day</b> (pressure dipped then rose, temp dropped, wind swung; estimated).' : fr === 'falling' ? '<br>Pressure fell a lot in the last day: a front may be coming (estimated).' : '');
  }
  var DIR_LABEL = { L: 'moving left', R: 'moving right', T: 'coming toward the camera', A: 'walking away' };
  var C8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'], C8L = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  function c8(deg) { return Math.round((((deg % 360) + 360) % 360) / 45) % 8; }
  function facingOf(c, zone) { if (!c) return null; if (c.rotating && zone) { for (var i = 0; i < c.zones.length; i++) if (c.zones[i].name === zone) return c.zones[i].facing; } return c.rotating ? null : c.facing; }
  // Travel heading = where the camera looks + which way the deer crosses the frame.
  function headingOf(p) { var f = facingOf(cam(p.cam), p.zone); if (f === null || f === undefined || !p.dir) return null; return (f + { A: 0, R: 90, T: 180, L: 270 }[p.dir]) % 360; }
  function visitHeading(v) { for (var i = 0; i < v.photos.length; i++) { var h = headingOf(v.photos[i]); if (h !== null) return h; } return null; }
  function baitBefore(camId, d) {
    var day = ymdOf(d), best = null;
    S.bait.forEach(function (b) { if (b.cam === camId && b.day <= day && (!best || b.day > best.day)) best = b; });
    if (!best) return null;
    return { ev: best, days: Math.round((dayFrom(day) - dayFrom(best.day)) / DAYMS) };
  }
  function companionsOf(v, sub, self) {
    var all = visits('any', v.cam), host = null, id0 = v.photos[0].id;
    all.some(function (x) { if (x.photos.some(function (p) { return p.id === id0; })) { host = x; return true; } return false; });
    if (!host) return [];
    var me = sub && sub.indexOf('deer:') === 0 ? sub.slice(5) : null, names = {}, kinds = {};
    host.photos.forEach(function (p) { p.deer.forEach(function (d) { if (d !== me && !(self && self.deer.indexOf(d) >= 0) && deer(d)) names[deer(d).name] = 1; }); p.tags.forEach(function (t) { if (t !== 'empty' && t !== 'buck' && !(self && self.tags.indexOf(t) >= 0)) kinds[KIND_LABEL[t]] = 1; }); });
    return Object.keys(names).concat(Object.keys(kinds));
  }
  function tempOfVisit(v) { for (var i = 0; i < v.photos.length; i++) if (v.photos[i].temp !== null && v.photos[i].temp !== undefined) return v.photos[i].temp; return null; }
  function visitDetails(v, sub, self) {
    var out = [], per = periodOf(v.d), sm = sunMins(v.d);
    if (per) out.push('<b>' + PERIOD_LABEL[per] + '</b>' + (sm ? ' · ' + (Math.abs(sm.rise) <= Math.abs(sm.set) ? Math.abs(sm.rise) + ' min ' + (sm.rise < 0 ? 'before' : 'after') + ' sunrise' : Math.abs(sm.set) + ' min ' + (sm.set < 0 ? 'before' : 'after') + ' sunset') : ''));
    var ml = moonLine(v.d); if (ml) out.push(ml);
    var wl = wxLine(v.d); out.push(wl ? wl : (hasLoc() ? 'No weather saved for this day. <button class="btn sm ink" data-act="wx-visits">Get weather</button>' : 'Add your property location (More) for sun, moon and weather.'));
    var tp = tempOfVisit(v); if (tp !== null) out.push('Camera ribbon temp: ' + tp + '°F');
    var hd = visitHeading(v); if (hd !== null) out.push('Heading ' + C8L[c8(hd)]);
    var bt = baitBefore(v.cam, v.d); if (bt) out.push(bt.days === 0 ? 'Bait put out that day' + (bt.ev.what ? ' (' + esc(bt.ev.what) + ')' : '') : plural(bt.days, 'day') + ' since bait' + (bt.ev.what ? ' (' + esc(bt.ev.what) + ')' : ''));
    var cp = companionsOf(v, sub, self); if (cp.length) out.push('With: ' + esc(cp.join(', ')));
    return '<ul class="vdet">' + out.map(function (l) { return '<li>' + l + '</li>'; }).join('') + '</ul>';
  }
  function fetchWeatherFor(days, lat, lng) {
    if (!window.BLWx) return Promise.reject(new Error('no weather module'));
    if (!navigator.onLine) { toast('No internet right now. Try again when you’re online.', 3500); return Promise.resolve(0); }
    toast('Getting weather…', 2500);
    return BLWx.fill(WX, lat, lng, days).then(function (n) { wxSave(); toast(n ? 'Weather saved for ' + plural(n, 'day') : 'Weather already saved'); return n; })
      .catch(function () { toast('Couldn’t get the weather. Try again later.', 3500); return 0; });
  }
  function fetchWeatherForVisits() {
    if (!hasLoc()) { toast('Add your property location first (More)'); return Promise.resolve(0); }
    var days = {}; visits('any').forEach(function (v) { days[ymdOf(v.d)] = 1; var b = new Date(v.d.getTime() - DAYMS); days[ymdOf(b)] = 1; });
    var list = Object.keys(days).filter(function (d) { return d <= ymdOf(new Date(Date.now() + 14 * DAYMS)); });
    if (!list.length) { toast('No visits with a time yet'); return Promise.resolve(0); }
    return fetchWeatherFor(list, S.settings.lat, S.settings.lng);
  }

  /* ================= v3: buck ID suggestions (on the phone, conservative) =================
   * Suggests ONLY a buck you already named, and only when another photo from the SAME camera, within your
   * visit gap, is tagged with exactly one named buck. It never makes up a name and you must OK it. */
  function idSuggest(p) {
    if (!p || p.deer.length || !p.cam || (p.tags.indexOf('empty') >= 0)) return null;
    var d = eff(p); if (!d) return null;
    var gap = S.settings.gapMin * 60000, names = {};
    P.forEach(function (q) { if (q === p || q.cam !== p.cam || !q.deer.length) return; var e = eff(q); if (!e || Math.abs(e - d) > gap) return; q.deer.forEach(function (id) { if (deer(id)) names[id] = (names[id] || 0) + 1; }); });
    var ids = Object.keys(names); if (ids.length !== 1) return null;
    return { id: ids[0], n: names[ids[0]] };
  }
  function suggestChip(p, act) {
    var sg = idSuggest(p); if (!sg) return '';
    var b = deer(sg.id);
    return '<div class="suggest" id="id-suggest"><span>Suggestion: <b>★ ' + esc(b.name) + '</b>? Same visit as ' + plural(sg.n, 'photo') + ' you tagged him in. Check the rack first.</span><button class="btn sm go" data-act="' + act + '" data-deer="' + esc(sg.id) + '" data-id="' + esc(p.id) + '">Yes, it’s him</button></div>';
  }

  /* ================= v3: states, rut, acorns, research layer ================= */
  function SD() { return (window.BL_STATES && window.BL_STATES.states) || {}; }
  var RUT_WORD = { rut: 'Peak rut', movement: 'Peak deer movement', breeding: 'Peak breeding' };
  function mdToDate(md, year) { var p = md.split('-'); return new Date(year, p[0] - 1, +p[1], 12); }
  function fmtMD(md) { var p = md.split('-'); return MON[p[0] - 1] + ' ' + (+p[1]); }
  function rutWindows() {
    var out = [];
    S.settings.states.forEach(function (ab) {
      var st = SD()[ab]; if (!st || !st.rut) return;
      var ar = S.settings.areas[ab], a = null; (st.rut.areas || []).forEach(function (x) { if (x.name === ar) a = x; });
      if (!a && st.rut.areas && st.rut.areas.length === 1) a = st.rut.areas[0];
      out.push({ ab: ab, st: st, area: a });
    });
    return out;
  }
  function rutNote(from, to) {
    var lines = [];
    rutWindows().forEach(function (r) {
      if (!r.area) { lines.push(r.st.name + ': ' + (RUT_WORD[r.st.rut.kind] || 'Rut timing') + ' has no area dates' + (r.st.rut.areas && r.st.rut.areas.length ? ' until you pick your area (More → States)' : '') + '.'); return; }
      var y = from.getFullYear(), a0 = mdToDate(r.area.start, y), a1 = mdToDate(r.area.end, y);
      if (a1 < a0) a1 = mdToDate(r.area.end, y + 1);
      if (r.st.rut.kind === 'breeding') { a0 = new Date(a0.getTime() - 14 * DAYMS); a1 = new Date(a1.getTime() - 14 * DAYMS); }   // hunters see the most rut activity ~2 weeks before peak breeding (MDWFP)
      var inside = to >= a0 && from <= a1;
      lines.push(r.st.name + ' (' + r.area.name + '): ' + (r.st.rut.kind === 'breeding' ? 'rut activity likely about ' + fmtDate(a0) + ' – ' + fmtDate(a1) + ' (2 weeks before peak breeding)' : (RUT_WORD[r.st.rut.kind] || 'Rut') + ' ' + fmtDate(a0) + ' – ' + fmtDate(a1)) + '. This window is ' + (inside ? 'inside' : 'outside') + ' it. Evidence: ' + r.st.rut.strength + '.');
    });
    return lines;
  }
  function acornNoteFor() {
    var out = [];
    S.settings.states.forEach(function (ab) { var st = SD()[ab]; if (st && st.acorn) out.push(st.name + ' acorns (' + st.acorn.year + '): ' + st.acorn.summary); });
    return out;
  }
  VIEWS.states = function () {
    var D = SD(), keys = Object.keys(D).sort(function (a, b) { return D[a].name.localeCompare(D[b].name); });
    var h = head('Your States', '#/more') + '<p class="muted small" style="margin-top:-4px">Pick where you hunt. You get rut timing and acorn info only for these states, from state wildlife agencies.</p>';
    h += '<div class="paper" id="state-picker"><div class="stgrid">' + keys.map(function (ab) {
      var st = D[ab], on = S.settings.states.indexOf(ab) >= 0;
      return '<label class="stpick' + (on ? ' on' : '') + '"><input type="checkbox" data-state="' + ab + '"' + (on ? ' checked' : '') + '><b>' + esc(st.name) + '</b><span>' + (st.rut ? 'Rut ✓' : 'Rut: not yet') + ' · ' + (st.acorn ? 'Acorns ✓' : 'Acorns: not yet') + '</span></label>';
    }).join('') + '</div>';
    S.settings.states.forEach(function (ab) {
      var st = D[ab]; if (!st || !st.rut || !st.rut.areas || st.rut.areas.length < 2) return;
      h += '<label class="field" style="margin-top:10px"><span>' + esc(st.name) + ': your area</span><select data-area="' + ab + '"><option value="">Pick your area…</option>' + st.rut.areas.map(function (a) { return '<option' + (S.settings.areas[ab] === a.name ? ' selected' : '') + '>' + esc(a.name) + '</option>'; }).join('') + '</select></label>';
    });
    h += '<p class="tiny muted" style="margin:10px 0 0">Not listed? Your state is not available yet. We only show info we could check against a real source.</p>' +
      '<a class="btn go block" style="margin-top:10px" href="#/research">See the research for my states</a></div>';
    return h;
  };
  function strengthTag(s) { return '<span class="ev ev-' + esc(s) + '">' + esc(s) + ' evidence</span>'; }
  function srcLinks(src) { return (src || []).map(function (x) { return '<a href="' + esc(x[1]) + '" target="_blank" rel="noopener">' + esc(x[0]) + '</a>'; }).join(' · '); }
  VIEWS.research = function () {
    var D = SD(), M = (window.BL_STATES && window.BL_STATES.meta) || {}, h = head('Research for Your States', '#/more');
    h += '<div class="panel small"><b>Your own cameras beat studies for a specific buck.</b> State numbers are averages over big areas and many deer. Use them as a backdrop; trust what your cameras show.</div>';
    if (!S.settings.states.length) return h + '<div class="paper"><p style="margin:0 0 10px">Pick your states first.</p><a class="btn go block" href="#/states">Pick states</a></div>';
    S.settings.states.forEach(function (ab) {
      var st = D[ab]; if (!st) return;
      h += '<div class="paper research" data-st="' + ab + '"><h3>' + esc(st.name) + '</h3>';
      if (st.rut) {
        var a = null; (st.rut.areas || []).forEach(function (x) { if (x.name === S.settings.areas[ab]) a = x; });
        h += '<h4>' + esc(RUT_WORD[st.rut.kind] || 'Rut timing') + ' ' + strengthTag(st.rut.strength) + '</h4><p class="small">' + esc(st.rut.summary) + '</p>' +
          (a ? '<p class="small"><b>Your area (' + esc(a.name) + '):</b> ' + esc(fmtMD(a.start)) + (a.end !== a.start ? ' – ' + esc(fmtMD(a.end)) : '') + (st.rut.kind === 'breeding' ? '. Hunters usually see the most rut activity about 2 weeks before peak breeding.' : '') + '</p>' : (st.rut.areas && st.rut.areas.length > 1 ? '<p class="small"><a href="#/states">Pick your area</a> to see your dates.</p>' : '')) +
          '<p class="tiny muted">Source: ' + srcLinks(st.rut.src) + '</p>';
      } else h += '<h4>Rut timing</h4><p class="small muted">Not available yet for ' + esc(st.name) + '. We could not confirm dates from the state agency.</p>';
      if (st.acorn) h += '<h4>Acorns (' + st.acorn.year + ') ' + strengthTag(st.acorn.strength) + '</h4><p class="small">' + esc(st.acorn.summary) + '</p><p class="tiny muted">Source: ' + srcLinks(st.acorn.src) + '</p>';
      else h += '<h4>Acorns</h4><p class="small muted">Not available yet. ' + esc(st.acornNote || '') + '</p>';
      h += '<p class="tiny muted">Red oak acorns take two years to mature, so a poor red oak year can be followed by a better one (Virginia DWR). ' + strengthTag('strong') + '</p>';
      if (st.drought) { var dr = st.drought; h += '<h4>Drought, week of ' + esc(fmtDate(dayFrom(dr.week))) + ' ' + strengthTag('strong') + '</h4><p class="small">' + Math.round(100 - dr.none) + '% of the state abnormally dry or worse · ' + Math.round(dr.d1) + '% in drought (D1+) · ' + Math.round(dr.d2) + '% severe or worse (D2+).</p><p class="tiny muted">Dry years can shrink acorn crops and pull deer to water and green food. ' + strengthTag('moderate') + ' Source: <a href="' + esc(M.drought && M.drought.url) + '" target="_blank" rel="noopener">' + esc(M.drought && M.drought.src) + '</a>. ' + esc(M.drought && M.drought.note) + '</p>'; }
      if (st.crops && (st.crops.corn || st.crops.soy)) h += '<h4>Crop harvest ' + strengthTag('strong') + '</h4><p class="small">' + (st.crops.corn ? 'Corn harvested: ' + esc(st.crops.corn.now) + '% (5-year average ' + esc(st.crops.corn.avg) + '%). ' : '') + (st.crops.soy ? 'Soybeans: ' + esc(st.crops.soy.now) + '% (average ' + esc(st.crops.soy.avg) + '%).' : '') + '</p><p class="tiny muted">Standing corn is food and cover; when it comes down, deer shift. ' + strengthTag('moderate') + ' Source: <a href="' + esc(M.crops && M.crops.url) + '" target="_blank" rel="noopener">' + esc(M.crops && M.crops.src) + '</a>. ' + esc(M.crops && M.crops.note) + '</p>';
      else h += '<h4>Crop harvest</h4><p class="small muted">Not in the national weekly report for this state.</p>';
      h += '</div>';
    });
    h += '<p class="tiny muted">Info checked ' + esc(M.checked || '') + '. Links open the source. Anything we could not confirm is left out or marked not available.</p>';
    return h;
  };

  /* ================= v3: predictions (sha256-locked, scored honestly) ================= */
  // Plain JS SHA-256 (sync) so the lock works the same on every phone.
  function sha256(str) {
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    var bytes = unescape(encodeURIComponent(str)), l = bytes.length, words = [], i;
    for (i = 0; i < l; i++) words[i >> 2] |= bytes.charCodeAt(i) << (24 - (i % 4) * 8);
    words[l >> 2] |= 0x80 << (24 - (l % 4) * 8); words[(((l + 8) >> 6) << 4) + 15] = l * 8;
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19], w = [];
    function r(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (var j = 0; j < words.length; j += 16) {
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], hh = H[7];
      for (i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[j + i] | 0;
        else { var s0 = r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3), s1 = r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10); w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0; }
        var t1 = (hh + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0; H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + hh) | 0;
    }
    return H.map(function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); }).join('');
  }
  function predCanon(p) { return JSON.stringify({ v: 1, id: p.id, made: new Date(p.made).toISOString(), who: p.who, whoName: p.whoName, cam: p.cam, camName: p.camName, from: p.from, to: p.to, m0: p.m0, m1: p.m1, basis: p.basis, photosBefore: p.photosBefore, lastAdded: p.lastAdded }); }
  function predOk(p) { return !!p.hash && sha256(predCanon(p)) === p.hash; }
  function predEnd(p) { var d = dayFrom(p.to); d.setHours(0, 0, 0, 0); return new Date(d.getTime() + p.m1 * 60000); }
  function predStatus(p) {
    if (!predOk(p)) return { s: 'void', why: 'Changed after it was locked, so it doesn’t count.' };
    if (!cam(p.cam) || (p.who !== 'bucks' && !deer(p.who))) return { s: 'void', why: 'The ' + (!cam(p.cam) ? 'camera' : 'buck') + ' was removed, so it can’t be scored.' };
    var vs = visits(p.who === 'bucks' ? 'bucks' : 'deer:' + p.who, p.cam), hit = null;
    vs.forEach(function (v) {
      var day = ymdOf(v.d), m = v.d.getHours() * 60 + v.d.getMinutes();
      if (day >= p.from && day <= p.to && m >= p.m0 && m <= p.m1 && v.photos.every(function (q) { return q.added > p.made; }) && (!hit || v.d < hit.d)) hit = v;
    });
    var end = predEnd(p), bait = S.bait.filter(function (b) { return b.cam === p.cam && b.day >= ymdOf(new Date(dayFrom(p.from).getTime() - 30 * DAYMS)) && b.day <= p.to; });
    var r = { bait: bait };
    if (hit) { r.s = 'hit'; r.v = hit; return r; }
    var covered = S.pulls.some(function (u) { return u.cam === p.cam && u.at > end.getTime() && u.at > p.made; }) || P.some(function (q) { var e = q.cam === p.cam && q.added > p.made ? eff(q) : null; return e && e > end; });
    r.s = covered ? 'miss' : (Date.now() > end.getTime() ? 'waiting' : 'open');
    return r;
  }
  function predLimit() { var t = tier(); return t === 'elite' ? null : t === 'pro' ? { kind: 'open', n: C.PRO_OPEN_PRED_LIMIT || 3 } : { kind: 'total', n: C.FREE_PRED_LIMIT || 1 }; }
  function canPredict() {
    var L = predLimit(); if (!L) return true;
    if (L.kind === 'total') return S.preds.length < L.n;
    return S.preds.filter(function (p) { var s2 = predStatus(p).s; return s2 === 'open' || s2 === 'waiting'; }).length < L.n;
  }
  function predDraft(who, days) {
    var vs = visits(who === 'bucks' ? 'bucks' : 'deer:' + who); if (vs.length < 3) return null;
    var recent = vs.filter(function (v) { return Date.now() - v.d < 60 * DAYMS; }), base = recent.length >= 3 ? recent : vs, byCam = {};
    base.forEach(function (v) { if (v.cam) byCam[v.cam] = (byCam[v.cam] || 0) + 1; });
    var camId = topKey(byCam); if (!camId) return null;
    var here = vs.filter(function (v) { return v.cam === camId; }), mins = here.map(function (v) { return v.d.getHours() * 60 + v.d.getMinutes(); });
    var b = busiest(mins, 120); if (!b) return null;
    var m0 = Math.floor(b.start / 15) * 15, m1 = Math.ceil(b.end / 15) * 15; if (m1 - m0 < 60) m1 = m0 + 60;
    if (m1 > 1439 || m1 < m0) { m0 = Math.max(0, Math.min(m0, 1379)); m1 = Math.min(1439, m0 + 120); }
    var from = new Date(Date.now() + DAYMS), to = new Date(from.getTime() + ((days || 7) - 1) * DAYMS);
    return { who: who, cam: camId, from: ymdOf(from), to: ymdOf(to), m0: m0, m1: m1, n: here.length, inWin: b.count, last: here[0] };
  }
  function predBasis(dr) {
    var name = dr.who === 'bucks' ? 'Bucks' : deer(dr.who).name, out = [];
    out.push(name + ': ' + plural(dr.n, 'visit') + ' at ' + camName(dr.cam) + ', ' + dr.inWin + ' of them between ' + fmtMin(dr.m0) + ' and ' + fmtMin(dr.m1) + '.');
    if (dr.last) out.push('Last seen there ' + fmtDate(dr.last.d) + ' at ' + fmtTime(dr.last.d) + '.');
    rutNote(dayFrom(dr.from), dayFrom(dr.to)).forEach(function (l) { out.push(l); });
    acornNoteFor().forEach(function (l) { out.push(l); });
    var bt = baitBefore(dr.cam, new Date()); if (bt && bt.days <= 30) out.push('Bait logged at this camera ' + (bt.days ? plural(bt.days, 'day') + ' ago' : 'today') + '.');
    return out;
  }
  function makePrediction(dr) {
    var last = 0; P.forEach(function (q) { if (q.added > last) last = q.added; });
    var p = { id: uid(), who: dr.who, whoName: dr.who === 'bucks' ? 'Any buck' : deer(dr.who).name, cam: dr.cam, camName: camName(dr.cam), from: dr.from, to: dr.to, m0: dr.m0, m1: dr.m1, made: Date.now(), basis: predBasis(dr), photosBefore: P.length, lastAdded: last };
    p.hash = sha256(predCanon(p)); S.preds.push(p); return flush().then(function () { return p; });
  }
  function predText(p) { return p.whoName + ' shows up at ' + p.camName + ' between ' + fmtMin(p.m0) + ' and ' + fmtMin(p.m1) + ', at least once from ' + fmtDate(dayFrom(p.from)) + (p.to !== p.from ? ' to ' + fmtDate(dayFrom(p.to)) : '') + '.'; }
  function predCard(p) {
    var st = predStatus(p), cls = st.s, label = { hit: 'Hit', miss: 'Miss', open: 'Waiting for the window', waiting: 'Window over: pull the card to score it', void: 'Not counted' }[cls];
    var h = '<div class="pred ' + cls + '" data-pred="' + esc(p.id) + '"><div class="pred-top"><b>' + label + '</b><span class="tiny muted">Locked ' + esc(fmtDT(new Date(p.made))) + '</span></div><p style="margin:6px 0">' + esc(predText(p)) + '</p>';
    if (cls === 'hit') h += '<p class="small" style="margin:0 0 4px">✓ ' + (p.who === 'bucks' ? 'A buck' : 'He') + ' showed ' + esc(fmtDate(st.v.d)) + ' at ' + esc(fmtTime(st.v.d)) + '.</p>';
    if (cls === 'miss') h += '<p class="small" style="margin:0 0 4px">✗ Missed. ' + (p.who === 'bucks' ? 'No buck showed' : esc(p.whoName) + ' didn’t show') + ' at ' + esc(p.camName) + ' in that window, and the camera was running after it. That counts as a miss.</p>';
    if (cls === 'void') h += '<p class="small" style="margin:0 0 4px">' + esc(st.why) + '</p>';
    if (cls === 'hit' || cls === 'miss') h += '<p class="tiny" style="margin:0 0 4px">' + (st.bait.length ? '⚠ Bait was logged at this camera (' + esc(st.bait.map(function (b) { return fmtDate(dayFrom(b.day)) + (b.what ? ' ' + b.what : ''); }).join(', ')) + '). Bait pulls deer in, so this is not a clean test.' : 'No bait logged at this camera: a clean test.') + '</p>';
    h += '<details><summary class="tiny">Why this prediction · fingerprint</summary><ul class="tiny">' + p.basis.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul><p class="tiny mono" style="word-break:break-all">sha256 ' + esc(p.hash) + (predOk(p) ? ' ✓ matches' : ' ✗ does not match') + '</p></details></div>';
    return h;
  }
  var predForm = { who: '', days: 7 };
  VIEWS.predict = function () {
    var h = head('Predictions', '#/bucks'), L = predLimit();
    var scored = S.preds.map(function (p) { return { p: p, s: predStatus(p) }; }), hits = 0, miss = 0, cH = 0, cM = 0;
    scored.forEach(function (x) { if (x.s.s === 'hit') { hits++; if (!x.s.bait.length) cH++; } if (x.s.s === 'miss') { miss++; if (!x.s.bait.length) cM++; } });
    h += '<div class="paper"><p style="margin:0 0 6px"><b>Score: ' + plural(hits, 'hit') + ', ' + plural(miss, 'miss', 'misses') + '</b>' + (hits + miss ? ' · clean tests (no bait): ' + cH + ' hit, ' + cM + ' miss' : '') + '</p>' +
      '<p class="tiny muted" style="margin:0">Each prediction is locked with the time and a sha256 fingerprint on this phone before new photos come in. It is scored only against photos you add later. Misses stay on the record.</p></div>';
    var whoOpts = S.deer.map(function (b) { return [b.id, '★ ' + b.name]; }).concat([['bucks', 'Any buck']]);
    if (!predForm.who || !whoOpts.some(function (o) { return o[0] === predForm.who; })) predForm.who = whoOpts[0] ? whoOpts[0][0] : 'bucks';
    h += '<div class="paper" id="pred-new"><h3>New prediction</h3>';
    if (!canPredict()) {
      h += '<p class="small">' + (L.kind === 'total' ? 'Free includes one prediction and its scored result. <a href="#/more">Pro or Elite</a> let you keep predicting.' : 'Pro keeps up to ' + L.n + ' open predictions at a time. Score one (pull the card) or <a href="#/more">upgrade to Elite</a> for unlimited.') + '</p>';
    } else {
      var dr = predDraft(predForm.who, predForm.days);
      h += '<div class="dt2"><label class="field"><span>Who</span><select id="pred-who">' + whoOpts.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === predForm.who ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select></label>' +
        '<label class="field"><span>Over the next</span><select id="pred-days">' + [3, 7, 14].map(function (n) { return '<option value="' + n + '"' + (n === predForm.days ? ' selected' : '') + '>' + n + ' days</option>'; }).join('') + '</select></label></div>';
      if (!dr) h += '<p class="small muted">Needs at least 3 timed visits for him first. The prediction is built from your own visits.</p>';
      else {
        h += '<label class="field"><span>Camera</span><select id="pred-cam">' + S.cameras.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === dr.cam ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('') + '</select></label>' +
          '<div class="dt2"><label class="field"><span>From</span><input type="time" id="pred-m0" value="' + pad(Math.floor(dr.m0 / 60)) + ':' + pad(dr.m0 % 60) + '"></label><label class="field"><span>To</span><input type="time" id="pred-m1" value="' + pad(Math.floor(dr.m1 / 60)) + ':' + pad(dr.m1 % 60) + '"></label></div>' +
          '<ul class="small read">' + predBasis(dr).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ul>' +
          '<button class="btn go block" data-act="pred-lock" data-from="' + dr.from + '" data-to="' + dr.to + '">Lock it in</button><p class="tiny muted" style="margin:6px 0 0">Once locked it can’t be edited. Window: ' + esc(fmtDate(dayFrom(dr.from))) + ' – ' + esc(fmtDate(dayFrom(dr.to))) + '. Your own cameras beat studies for a specific buck.</p>';
      }
    }
    h += '</div>';
    h += S.preds.slice().reverse().map(predCard).join('');
    return h;
  };
  VIEWS.predict.after = function () {
    var w = $('#pred-who'), d = $('#pred-days');
    if (w) w.addEventListener('change', function () { predForm.who = w.value; render(); });
    if (d) d.addEventListener('change', function () { predForm.days = Number(d.value) || 7; render(); });
  };

  /* ================= v3: 3D terrain sim host ================= */
  function demKey(box) { return 'm3857,' + box.lat.toFixed(5) + ',' + box.lng.toFixed(5) + ',' + box.acres; }
  function fetchDem() {
    var box = S.t3 && S.t3.box; if (!box || !window.BLTerrain) return Promise.resolve(false);
    if (!navigator.onLine) { toast('No internet right now. Try again when you’re online.', 3500); return Promise.resolve(false); }
    toast('Getting USGS elevation…', 4000);
    return fetch(BLTerrain.demURL(box)).then(function (r) { if (!r.ok) throw new Error('usgs ' + r.status); return r.arrayBuffer(); }).then(function (buf) {
      var z = null; try { z = BLTerrain.cleanDem(BLTerrain.parseTiff(buf)); } catch (e) { z = null; }
      if (!z) { toast('USGS has no elevation for that spot. The 3D sim covers the US only.', 5000); return false; }
      DEM = { key: demKey(box), z: z, at: Date.now() };
      return kvPut('dem', { key: DEM.key, z: Array.prototype.slice.call(z), at: DEM.at }).then(function () { toast('Elevation saved on this phone'); return true; });
    }).catch(function () { toast('Couldn’t reach USGS. Try again later.', 4000); return false; });
  }
  var MANUAL_WIND = { wd: 225, ws: 6 };
  var WIND_WORDS = [['Calm', 0], ['Light', 5], ['Breezy', 12], ['Windy', 20]];
  function t3Host(demo) { return engineHost({ demo: demo }); }
  var t3Day = null, t3Api = null;
  function parkSheet() {
    var m = S.map; if (!m) return;
    var Z = { B: '#345c2e', F: '#c4a84e', W: '#4680aa', C: '#4076a0', N: '#788c46', R: '#968c80', X: '#965046', '.': '#68804c' };
    sheet('<h2>Where do you park?</h2><p class="muted small">Tap squares to mark parking (up to 6). Tap again to remove.</p><canvas id="park-cv" width="300" height="390" style="width:100%;max-width:300px;touch-action:none;display:block;margin:0 auto"></canvas><div class="btn-row" style="margin-top:10px"><button class="btn go" data-x="close">Done</button></div>', function (x) { if (x === 'close') { closeSheet(); render(); return false; } });
    var cv = $('#park-cv'), g = cv.getContext('2d'), cs = 15;
    function draw() {
      for (var i = 0; i < 520; i++) { g.fillStyle = Z[m.cells[i]] || Z['.']; g.fillRect((i % 20) * cs, ((i / 20) | 0) * cs, cs - 1, cs - 1); }
      m.stands.forEach(function (s) { g.fillStyle = '#fff'; g.beginPath(); g.arc(s.x * cs + 7, s.y * cs + 7, 4, 0, 7); g.fill(); });
      S.t3.parking.forEach(function (p) { g.fillStyle = '#1d3557'; g.fillRect(p.x * cs + 1, p.y * cs + 1, cs - 3, cs - 3); g.fillStyle = '#fff'; g.font = 'bold 11px sans-serif'; g.fillText('P', p.x * cs + 4, p.y * cs + 11); });
    }
    cv.addEventListener('click', function (e) {
      var r = cv.getBoundingClientRect(), x = Math.floor((e.clientX - r.left) / r.width * 20), y = Math.floor((e.clientY - r.top) / r.height * 26);
      if (x < 0 || y < 0 || x > 19 || y > 25) return;
      var k = -1; S.t3.parking.forEach(function (p, i) { if (p.x === x && p.y === y) k = i; });
      if (k >= 0) S.t3.parking.splice(k, 1); else if (S.t3.parking.length < 6) S.t3.parking.push({ x: x, y: y }); else toast('Up to 6 parking spots');
      save(); draw();
    });
    draw();
  }
  function sim3dHtml() {
    if (!isElite()) {
      var t = tier();
      return '<div class="paper" id="t3-locked"><h3>🔒 3D Terrain Sim is Elite</h3><p class="small">Your real ground in 3D from USGS elevation, with wind, rising and sinking air and your moving scent. Stands turn teal, amber or crimson with the reason why, and it finds your safest walk-in. Pick a real day and slide through it.</p>' +
        (t === 'pro' ? buyBtn('upgrade', 'Upgrade to Elite') : buyBtn('elite', 'Get Elite')) + (proOnSale() ? '<a class="btn ink block" style="margin-top:8px" href="#/more">I have a license key</a>' : '') + '</div>' +
        '<div class="paper"><h3>Try it on the Example property</h3><p class="tiny muted" style="margin:0 0 6px">Example property. Not your land.</p><div id="t3-root"></div><p class="t3-credit">Example aerial photo: USDA NAIP via USGS, flown October 2023. Elevation: USGS 3DEP lidar. Map services and data available from U.S. Geological Survey, National Geospatial Program.</p></div>';
    }
    var box = S.t3 && S.t3.box;
    if (!box) {
      return '<div class="paper" id="t3-setup"><h3>Set up your 3D ground</h3><p class="small">The 3D sim lays your property map (bedding, food, stands) on real USGS elevation. <b>US only.</b></p>' +
        (hasLoc() ? '' : '<p class="small" style="color:#9a2f1c">Add your property location first (More → Property location).</p>') +
        (S.map ? '' : '<p class="small" style="color:#9a2f1c">Mark your property map first (bedding, food, stands).</p><a class="btn ink block" style="margin-bottom:8px" href="#/sim?v=map">Property map</a>') +
        '<label class="field"><span>Map size (acres), centred on your property location</span><input type="number" id="t3-acres" min="5" max="5000" value="' + (S.map && !S.map.example ? S.map.acres : 160) + '"></label>' +
        '<button class="btn go block" data-act="t3-box"' + (hasLoc() && S.map ? '' : ' disabled') + '>Use this box</button><p class="tiny muted" style="margin:6px 0 0">North is up. The box is the same shape as your property map.</p></div>';
    }
    var have = DEM && DEM.key === demKey(box);
    if (!have) return '<div class="paper" id="t3-fetch"><h3>Get your elevation</h3><p class="small">One download from USGS 3DEP for your box (about 70 KB). It is saved on this phone, so you only do this once. Only the box corners are sent.</p><button class="btn go block" data-act="t3-dem">Get USGS elevation</button><button class="btn ink block" style="margin-top:8px" data-act="t3-reset">Change the box</button></div>';
    return '<div id="t3-root"></div><div class="btn-row" style="margin-top:8px"><button class="btn ink" data-act="t3-park">Mark parking</button><a class="btn ink" href="#/sim?v=map">Property map</a><button class="btn ink" data-act="t3-reset">Change box</button></div>' +
      '<p class="tiny muted">Model, not a forecast. The wind is run with its normal wavering spread for the hour (EPA stability classes). Wind under cover uses US Forest Service shelter factors; slope air uses published downslope and upslope speeds; scent spread uses textbook formulas (Turner stability, Briggs spread). Stands are rated only by whether your air blows over bedding, routes or food on the property (National Deer Association: keep your scent from blowing toward deer): crimson when the middle of the wind spread does, amber when only its edges do. Deer routes are worked out in the phone from your own bedding and food marks.</p><p class="t3-credit">Aerial photo: USGS The National Map, Imagery Only (mostly USDA NAIP, leaf-on; flight year varies by area). Elevation: USGS 3DEP. Map services and data available from U.S. Geological Survey, National Geospatial Program.</p>';
  }
  function mount3d() {
    var el = $('#t3-root'); if (!el || !window.BLTerrain) return;
    var demo = !isElite(); if (!demo && !(S.t3 && S.map)) return;
    t3Api = mountPort(el, demo);
  }
  // 3D view = the original sim ported 1:1 (hbk3d/), loaded only when the 3D view opens. Example: the original precomputed data, names hidden.
  // Elite: the same renderer on the buyer's own USGS 3DEP ground and USGS aerial, with the engine run in the phone.
  function mountPort(el, demo) {
    if (!demo) window.BL_BUYER_INPUT = { box: S.t3.box, map: S.map, parking: (S.t3 && S.t3.parking) || [], day: (t3Day || new Date()).getTime() };
    var f = document.createElement('iframe'); f.className = 't3-port'; f.title = '3D terrain sim'; f.setAttribute('allow', 'web-share; clipboard-write');
    f.src = 'hbk3d/sim.html?' + (demo ? 'ex=1&day=oct05' : 'buyer=1'); el.appendChild(f);
    // Slade's intro (Oct 12), outside the map, Example only. Sources = the data and published methods the sim actually runs on.
    if (demo && !el.querySelector('.t3-intro')) { var intro = document.createElement('div'); intro.className = 't3-intro';
      intro.innerHTML = '<p>Wind, thermals and scent can make or break a hunt. Built on real lidar terrain, aerial imagery, hourly weather and published air-flow research, Buck Ledger shows how all three move across your ground, so you\'re in the right stand at the right time.</p><p class="tiny muted">Tap <b>More info</b> in the 3D view for the stand reasons, conditions and notes for the hour on screen.</p>';
      el.insertBefore(intro, f); }
    // Full screen (Slade Oct 12): the same sim frame fills the phone; a slim bar on top closes it (phone Back closes it too). Nothing inside changes.
    el.classList.add('t3-host'); var fsb = document.createElement('button'); fsb.className = 'btn ink t3-fsbtn'; fsb.type = 'button'; fsb.textContent = 'Full screen'; el.insertBefore(fsb, f);
    var bar = document.createElement('div'); bar.className = 't3-fsbar'; bar.innerHTML = '<span>3D terrain</span><button class="btn ink" type="button">Close full screen</button>'; el.insertBefore(bar, f);
    function fsSet(on, fromPop) { if (on === el.classList.contains('t3-full')) return; el.classList.toggle('t3-full', on); document.documentElement.classList.toggle('t3-noscroll', on);
      if (on && !fromPop) history.pushState({ t3full: 1 }, ''); if (!on && !fromPop && history.state && history.state.t3full) history.back(); }
    fsb.onclick = function () { fsSet(true); }; bar.querySelector('button').onclick = function () { fsSet(false); };
    window.addEventListener('popstate', function () { if (el.classList.contains('t3-full')) fsSet(false, true); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') fsSet(false); });
    var api = function () { try { return f.contentWindow && f.contentWindow.__ready && f.contentWindow.__BL; } catch (e) { return null; } };
    return { fullscreen: function (on) { fsSet(on !== false); }, isFull: function () { return el.classList.contains('t3-full'); }, destroy: function () { fsSet(false); f.remove(); }, refresh: function () { if (!demo && f.contentWindow) f.contentWindow.location.reload(); }, frame: f,
      ready: function () { return !!api(); }, state: function () { var a = api(); return a ? a.state() : null; }, setHour: function (h) { var a = api(); if (a) a.setClock(h); }, gl: function () { return api(); },
      renderMs: function () { var a = api(); return a ? a.renderMs() : null; }, setSel: function (i) { var a = api(); return a ? a.setSel(i) : null; } };
  }
  document.addEventListener('change', function (e) {
    if (e.target && (e.target.id === 't3-wd' || e.target.id === 't3-ws')) { MANUAL_WIND.wd = Number($('#t3-wd').value); MANUAL_WIND.ws = Number($('#t3-ws').value); engines().forEach(function (x) { x.refresh(); }); }
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-state')) {
      var ab = e.target.getAttribute('data-state'), i = S.settings.states.indexOf(ab);
      if (e.target.checked && i < 0) S.settings.states.push(ab); else if (!e.target.checked && i >= 0) { S.settings.states.splice(i, 1); delete S.settings.areas[ab]; }
      S.settings.statesAsked = true; save(); render();
    }
    if (e.target && e.target.getAttribute && e.target.getAttribute('data-area')) { var a2 = e.target.getAttribute('data-area'); if (e.target.value) S.settings.areas[a2] = e.target.value; else delete S.settings.areas[a2]; save(); toast('Area saved'); }
  });


  /* ================= v3: photo / buck / camera extras ================= */
  function visibleDeer() { return S.settings.hideSmall ? S.deer.filter(function (b) { return b.points === null || b.points > S.settings.smallMax; }) : S.deer.slice(); }
  function visitDetailsPhoto(p) {
    var vs = visits('any', p.cam), v = null;
    vs.some(function (x) { if (x.photos.indexOf(p) >= 0) { v = x; return true; } return false; });
    if (!v) { var d = eff(p); v = { d: d, end: d, cam: p.cam, photos: [p] }; }
    return visitDetails(v, 'any', p);
  }
  function photoExtras(p) {
    var c = cam(p.cam), h = '<hr><h3>Temp on the ribbon</h3><div style="display:flex;gap:8px;align-items:flex-end"><label class="field" style="flex:1;margin:0"><span>°F printed on the photo</span><input type="number" id="ph-temp" inputmode="numeric" min="-40" max="130" value="' + (p.temp === null ? '' : p.temp) + '"></label><button class="btn ink" data-act="ph-temp" data-id="' + esc(p.id) + '">Save</button></div>' +
      (p.thumb ? '<button class="btn ink block" style="margin-top:8px" data-act="ph-ocr" data-id="' + esc(p.id) + '">Read temp from photo</button><p class="tiny muted" id="ocr-msg" style="margin:6px 0 0">Reads the ribbon on this phone (first use loads the reader, about 10 MB). Always check the number before you save.</p>' : '');
    h += '<hr><h3>Which way was he moving?</h3><div class="btn-row">' + ['L', 'R', 'T', 'A'].map(function (k) { return '<button class="tok' + (p.dir === k ? ' on' : '') + '" data-act="ph-dir" data-dir="' + k + '" data-id="' + esc(p.id) + '">' + { L: '← Left', R: 'Right →', T: 'Toward', A: 'Away' }[k] + '</button>'; }).join('') + '</div>';
    if (c && c.rotating) h += '<label class="field" style="margin-top:8px"><span>Camera view (rotating camera)</span><select id="ph-zone" data-id="' + esc(p.id) + '"><option value="">Pick the view…</option>' + c.zones.map(function (z) { return '<option' + (p.zone === z.name ? ' selected' : '') + '>' + esc(z.name) + '</option>'; }).join('') + '</select></label>';
    var hd = headingOf(p);
    h += '<p class="small" style="margin:6px 0 0">' + (hd !== null ? 'Travel heading: <b>' + C8L[c8(hd)] + '</b>' : (p.dir ? 'Set which way the camera faces (Cameras) to get his heading.' : 'Tap a direction to log his travel heading.')) + '</p>';
    return h;
  }
  function buckExtras(b, vs) {
    var h = '<div class="paper" id="buck-extra"><h3>Profile</h3><div style="display:flex;gap:12px;align-items:center">' + (b.photo && PI[b.photo] && PI[b.photo].thumb ? '<img class="thumb" style="width:84px;height:64px;object-fit:cover;border-radius:8px" alt="" src="' + thumbURL(PI[b.photo]) + '">' : '<span class="thumb">★</span>') +
      '<div>' + (b.points !== null ? '<p style="margin:0"><b>' + b.points + ' points</b></p>' : '') + '<button class="btn sm ink" data-act="buck-photo" data-id="' + esc(b.id) + '"' + (vs.length ? '' : ' disabled') + '>Pick profile photo</button></div></div>';
    if (b.renames.length) h += '<p class="small" style="margin:8px 0 0">Was called: ' + b.renames.slice().reverse().map(function (r) { return '<b>' + esc(r.from) + '</b> (until ' + esc(fmtDay(r.at)) + ')'; }).join(', ') + '</p>';
    h += '<a class="btn ink block" style="margin-top:10px" href="#/predict">Predict his next visit</a></div>';
    return h;
  }
  function camExtras(c) {
    var opts = function (sel) { return '<option value="">Not set</option>' + C8L.map(function (n, i) { return '<option value="' + (i * 45) + '"' + (sel === i * 45 ? ' selected' : '') + '>' + n.charAt(0).toUpperCase() + n.slice(1) + '</option>'; }).join(''); };
    var h = '<div class="paper" id="cam-facing"><h3>Which way does it face?</h3><p class="tiny muted" style="margin:0 0 8px">The direction the lens looks. With this, the way a deer crosses the frame becomes a travel heading.</p>' +
      '<label class="field"><span>Facing</span><select id="cam-face"' + (c.rotating ? ' disabled' : '') + '>' + opts(c.facing) + '</select></label>' +
      '<label class="chk"><input type="checkbox" id="cam-rot"' + (c.rotating ? ' checked' : '') + '> It rotates or has more than one view</label>';
    if (c.rotating || !c.zones.length) h += '<div id="cam-zones"' + (c.rotating ? '' : ' style="display:none"') + '>' + (c.zones.length ? c.zones : [{ name: 'View 1', facing: 0 }]).map(function (z, i) { return '<div class="dt2 zone"><input type="text" maxlength="30" class="z-name" value="' + esc(z.name) + '" aria-label="View name"><select class="z-face" aria-label="View facing">' + opts(z.facing).replace('<option value="">Not set</option>', '') + '</select></div>'; }).join('') + '<button class="btn sm plain" data-act="cam-zone-add">＋ Add a view</button></div>';
    else h += '<div id="cam-zones" style="display:none">' + c.zones.map(function (z) { return '<div class="dt2 zone"><input type="text" maxlength="30" class="z-name" value="' + esc(z.name) + '"><select class="z-face">' + opts(z.facing).replace('<option value="">Not set</option>', '') + '</select></div>'; }).join('') + '<button class="btn sm plain" data-act="cam-zone-add">＋ Add a view</button></div>';
    h += '<button class="btn ink block" style="margin-top:8px" data-act="cam-face-save" data-id="' + esc(c.id) + '">Save facing</button></div>';
    var ev = S.bait.filter(function (b) { return b.cam === c.id; }).sort(function (a, b) { return a.day < b.day ? 1 : -1; });
    h += '<div class="paper" id="cam-bait"><h3>Bait log</h3><p class="tiny muted" style="margin:0 0 8px">Log when you put bait or feed out. Visits show days since bait, and predictions at baited cameras are flagged: they are not a clean test.</p>' +
      '<div class="dt2"><label class="field"><span>Day</span><input type="date" id="bait-day" value="' + ymdOf(new Date()) + '"></label><label class="field"><span>What</span><input type="text" id="bait-what" maxlength="60" placeholder="Corn, mineral…"></label></div>' +
      '<button class="btn ink block" data-act="bait-add" data-id="' + esc(c.id) + '">Log bait</button>' +
      (ev.length ? '<ul class="list small" style="margin-top:8px">' + ev.map(function (b) { return '<li class="baitrow"><span>' + esc(fmtDate(dayFrom(b.day))) + (b.what ? ' · ' + esc(b.what) : '') + '</span><button class="btn sm plain" data-act="bait-del" data-id="' + esc(b.id) + '">Remove</button></li>'; }).join('') + '</ul>' : '') + '</div>';
    return h;
  }
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'cam-rot') { var z = $('#cam-zones'); if (z) z.style.display = e.target.checked ? '' : 'none'; var f = $('#cam-face'); if (f) f.disabled = e.target.checked; }
    if (e.target && e.target.id === 'ph-zone') { var p = PI[e.target.getAttribute('data-id')]; if (p) { p.zone = e.target.value || null; photoPut(p); render(); } }
  });

  /* ---------------- sheets ---------------- */
  function promptSheet(title, body, yes, val) {
    return sheet('<h2>' + esc(title) + '</h2><p class="muted">' + esc(body) + '</p><input type="text" id="prompt-in" maxlength="60" value="' + esc(val || '') + '" style="margin-bottom:12px"><div class="btn-row"><button class="btn ink" data-x="no">Cancel</button><button class="btn go" data-x="ok">' + esc(yes) + '</button></div>', function (x, b, close) {
      if (x === 'ok') { var v = ($('#prompt-in').value || '').trim(); if (!v) { toast('Type a name'); return false; } close(v); return false; }
    }).then(function (v) { return typeof v === 'string' ? v : null; });
  }
  function buyBtn(t, label) {
    var url = checkoutFor(t), price = priceOf(t);
    if (url) return '<a class="btn go block" id="buy-' + t + '" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(label) + (price ? ': ' + esc(price) : '') + '</a>';
    return '';  // no checkout configured: show no buy button (never a "coming soon" placeholder)
  }
  function proSheet(kind) {
    var t = tier(), what = kind === 'cam' ? plural(camLimit(), 'camera') : plural(buckLimit(), 'named buck');
    var body = t === 'free'
      ? '<p>The free version keeps ' + what + '. <b>Pro</b>' + (priceOf('pro') ? ' (' + esc(priceOf('pro')) + ')' : '') + ' keeps ' + plural(C.PRO_CAMERA_LIMIT, 'camera') + ' and ' + plural(C.PRO_BUCK_LIMIT, 'named buck') + '. <b>Elite</b>' + (priceOf('elite') ? ' (' + esc(priceOf('elite')) + ')' : '') + ' is unlimited and adds the 3D Terrain Sim. ' + esc(C.PRO_PRICE_NOTE || '') + '</p>' + buyBtn('pro', 'Get Pro') + '<div style="height:8px"></div>' + buyBtn('elite', 'Get Elite')
      : '<p>Pro keeps ' + what + '. <b>Elite</b> is unlimited and adds the 3D Terrain Sim. Pro owners pay just the difference.</p>' + buyBtn('upgrade', 'Upgrade to Elite');
    sheet('<h2>' + TIER_NAME[t] + ' limit reached</h2>' + body + (proOnSale() ? '<a class="btn ink block" style="margin-top:8px" href="#/more" data-x="close">I have a license key</a>' : '') +
      '<button class="btn ink block" style="margin-top:8px" data-x="close">Not now</button>');
  }

  /* ---------------- backup / restore / CSV ---------------- */
  function blobToDataURL(b) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; r.readAsDataURL(b); }); }
  function dataURLToBlob(u) {
    var m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/=]+)$/.exec(String(u || '')); if (!m) return null;
    try { var bin = atob(m[2]), arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); return new Blob([arr], { type: m[1] }); } catch (e) { return null; }
  }
  function saveFile(blob, name, mime) {
    var file = null; try { file = new File([blob], name, { type: mime }); } catch (e) {}
    var share = (isIOS() && file && navigator.canShare && navigator.canShare({ files: [file] }))
      ? navigator.share({ files: [file], title: name }).then(function () { return true; }).catch(function (e) { return e && e.name === 'AbortError' ? 'abort' : false; })
      : Promise.resolve(false);
    return share.then(function (ok) {
      if (ok === 'abort') return false;
      if (!ok) { var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000); }
      return true;
    });
  }
  function stamp() { var d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function exportBackup(withPhotos) {
    toast('Building backup…', 1500);
    var st = JSON.parse(JSON.stringify(S)); st.settings.license = null; st.settings.deviceId = null;
    var photos = [];
    return P.reduce(function (pr, p) {
      return pr.then(function () {
        var o = { id: p.id, cam: p.cam, pull: p.pull, name: p.name, size: p.size, t: p.t, tsrc: p.tsrc, fileT: p.fileT, tags: p.tags, deer: p.deer, done: p.done, added: p.added, temp: p.temp, tempSrc: p.tempSrc, dir: p.dir, zone: p.zone };
        photos.push(o);
        if (withPhotos && p.thumb) return blobToDataURL(p.thumb).then(function (u) { o.thumb = u; });
      });
    }, Promise.resolve()).then(function () {
      var data = { app: 'buckledger', schema: SCHEMA, exportedAt: new Date().toISOString(), withPhotos: !!withPhotos, state: st, photos: photos };
      var name = 'buck-ledger-backup-' + stamp() + (withPhotos ? '' : '-data') + '.json';
      return saveFile(new Blob([JSON.stringify(data)], { type: 'application/json' }), name, 'application/json').then(function (ok) {
        if (ok) { S.settings.lastBackup = Date.now(); save(); toast('Backup saved: ' + name, 3000); }
      });
    }).catch(function () { toast('Backup failed. Try “Backup without photos”.', 4000); });
  }
  function restoreFrom(file) {
    var r = new FileReader();
    r.onload = function () {
      var data; try { data = JSON.parse(r.result); } catch (e) { toast('That file isn’t a Buck Ledger backup.'); return; }
      if (!data || data.app !== 'buckledger' || !data.state || !Array.isArray(data.photos)) { toast('That file isn’t a Buck Ledger backup.'); return; }
      confirmSheet('Restore this backup?', 'It has ' + plural(data.photos.length, 'photo') + ' from ' + (data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'an unknown date') + '. It replaces everything on this phone.', 'Restore').then(function (ok) {
        if (!ok) return;
        var next = migrate(data.state);
        next.settings.license = S.settings.license; next.settings.deviceId = S.settings.deviceId; // licenses never come from files
        var camIds = {}, deerIds = {}; next.cameras.forEach(function (c) { camIds[c.id] = 1; }); next.deer.forEach(function (b) { deerIds[b.id] = 1; });
        var list = [], ids = {};
        data.photos.forEach(function (o) {
          if (!o || typeof o !== 'object') return;
          var thumb = o.thumb ? dataURLToBlob(o.thumb) : null;
          var p = cleanPhoto(Object.assign({}, o, { thumb: thumb }), camIds, deerIds);
          if (p && !ids[p.id]) { ids[p.id] = 1; list.push(p); }
        });
        photosClear().then(function () { return list.length ? photosPutMany(list) : null; }).then(function () {
          Object.keys(urlCache).forEach(dropURL);
          S = next; P = list; PI = {}; P.forEach(function (p) { PI[p.id] = p; });
          return flush();
        }).then(function () { toast('Backup restored: ' + plural(list.length, 'photo')); go('#/'); }).catch(function () { toast('Restore failed. Nothing was changed.', 4000); });
      });
    };
    r.readAsText(file);
  }
  function csvCell(v) { v = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function exportCSV() {
    var vs = visits('any');
    var rows = [['date', 'time', 'end_time', 'camera', 'who', 'light', 'sun', 'period', 'moon_phase', 'moon_lit_pct', 'wind_dir', 'wind_mph', 'gust_mph', 'air_temp_f', 'pressure_hpa', 'rain_in', 'ribbon_temp_f', 'heading', 'days_since_bait', 'photos', 'time_source', 'files']];
    vs.slice().reverse().forEach(function (v) {
      var srcs = {}; v.photos.forEach(function (p) { srcs[p.tsrc || ''] = 1; });
      rows.push([v.d.getFullYear() + '-' + pad(v.d.getMonth() + 1) + '-' + pad(v.d.getDate()), pad(v.d.getHours()) + ':' + pad(v.d.getMinutes()), pad(v.end.getHours()) + ':' + pad(v.end.getMinutes()),
        camName(v.cam), whoOf(v), v.light ? LIGHT_LABEL[v.light] : '', sunNote(v.d)].concat((function () {
          var per = periodOf(v.d), mo = moonInfo(v.d), w = wxAt(v.d), hd = visitHeading(v), bt = baitBefore(v.cam, v.d), tp = tempOfVisit(v);
          return [per ? PERIOD_LABEL[per] : '', mo ? mo.name : '', mo ? mo.pct : '', w && w.wd !== null ? BLWx.compass(w.wd) : '', w && w.ws !== null ? Math.round(w.ws) : '', w && w.wg !== null ? Math.round(w.wg) : '', w && w.t !== null ? Math.round(w.t) : '', w && w.p !== null ? Math.round(w.p) : '', w && w.r !== null ? w.r : '', tp === null ? '' : tp, hd === null ? '' : C8[c8(hd)], bt ? bt.days : ''];
        })(), [v.photos.length, Object.keys(srcs).join('+'), v.photos.map(function (p) { return p.name; }).join(' ')]));
    });
    var csv = rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
    return saveFile(new Blob(['\ufeff' + csv], { type: 'text/csv' }), 'buck-ledger-' + stamp() + '.csv', 'text/csv').then(function (ok) { if (ok) toast('Exported ' + plural(vs.length, 'visit')); });
  }

  /* ---------------- actions ---------------- */
  function deletePhotos(ids) {
    var set = {}; ids.forEach(function (id) { set[id] = 1; dropURL(id); });
    P = P.filter(function (p) { return !set[p.id]; }); ids.forEach(function (id) { delete PI[id]; });
    return photoDel(ids);
  }
  document.addEventListener('click', function (e) {
    if (sortClick(e)) return;
    var vis = e.target.closest('[data-visit]');
    if (vis && !e.target.closest('.sheet')) { visitSheet(vis.getAttribute('data-visit'), vis.getAttribute('data-sub')); return; }
    var pt = e.target.closest('[data-ptoggle]');
    if (pt) {
      var p0 = PI[R.id]; if (!p0) return; var v = pt.getAttribute('data-ptoggle');
      if (v.indexOf('deer:') === 0) { var did = v.slice(5), i = p0.deer.indexOf(did); if (i >= 0) p0.deer.splice(i, 1); else p0.deer.push(did); p0.tags = p0.tags.filter(function (x) { return x !== 'empty'; }); }
      else if (v === 'empty') { p0.tags = p0.tags.indexOf('empty') >= 0 ? [] : ['empty']; p0.deer = []; }
      else { var j = p0.tags.indexOf(v); if (j >= 0) p0.tags.splice(j, 1); else { p0.tags.push(v); p0.tags = p0.tags.filter(function (x) { return x !== 'empty'; }); } }
      p0.done = p0.tags.length + p0.deer.length > 0; photoPut(p0); render(); return;
    }
    var a = e.target.closest('[data-act]'); if (!a) return;
    var act = a.getAttribute('data-act'), id = a.getAttribute('data-id');
    if (act.indexOf('bulk-') === 0 && bulkClick(act, a)) return;
    switch (act) {
      case 'pick-photos': {
        var sel = $('#pull-cam');
        if (sel && sel.value === '__new' && !($('#pull-new').value || '').trim()) { toast('Name the camera first'); $('#pull-new').focus(); return; }
        $('#pull-file').click(); return;
      }
      case 'pull-again': pullState = null; render(); return;
      case 'dedup-show': if (pullState) { pullState.dupOpen = !pullState.dupOpen; render(); } return;
      case 'dedup-import': if (pullState && pullState.dups && pullState.dups.length) { runPull(pullState.dups.map(function (d) { return d.file; }), pullState.cam, true); } return;
      case 'more-rows': ledgerLimit += 200; render(); return;
      case 'sort-undo': sortUndoLast(); return;
      case 'stamp-band': stampBand = stampBand === 'bottom' ? 'top' : 'bottom'; stampY = null; render(); return;
      case 'stamp-pan': stampX = stampX >= 100 ? 0 : Math.min(100, stampX + 25); var sx = $('#stamp-x'); if (sx) sx.value = stampX; stampDraw(); return;
      case 'stamp-save': stampSave(id, false); return;
      case 'stamp-filedate': stampSave(id, true); return;
      case 'stamp-skip': {
        var q = P.filter(function (p) { return !p.t; }).sort(function (x, y) { return x.name.localeCompare(y.name, undefined, { numeric: true }); });
        var k = q.findIndex(function (p) { return p.id === id; }), nx = q[(k + 1) % q.length];
        go('#/stamp/' + encodeURIComponent(nx ? nx.id : '')); return;
      }
      case 'clock-apply': {
        var c = cam(a.getAttribute('data-cam')), pp = PI[a.getAttribute('data-p')]; if (!c || !pp) return;
        var o = clockOffsetFromInputs(pp); if (o === null) { toast('Type the real date and time'); return; }
        c.offsetMin = o; save(); toast(o ? 'Clock fixed: ' + fmtOffset(o) + (o > 0 ? ' behind' : ' ahead') : 'Clock was right. No fix needed.', 3000); go('#/cam/' + encodeURIComponent(c.id)); return;
      }
      case 'clock-clear': { var c2 = cam(a.getAttribute('data-cam')); if (c2) { c2.offsetMin = 0; save(); toast('Clock fix removed'); render(); } return; }
      case 'ph-time': {
        var ph = PI[id]; if (!ph) return; var dv = $('#ph-date').value, tv = $('#ph-time').value;
        if (!dv || !tv) { toast('Type both the date and the time'); return; }
        var val = dv + 'T' + (tv.length === 5 ? tv + ':00' : tv.slice(0, 8)); if (!parseLocal(val)) { toast('That date/time doesn’t look right'); return; }
        if (val !== ph.t) { ph.t = val; ph.tsrc = 'stamp'; photoPut(ph); toast('Time saved'); render(); }
        return;
      }
      case 'ph-del': confirmSheet('Delete this photo?', 'It’s removed from this phone and your ledger.', 'Delete', true).then(function (ok) { if (ok) deletePhotos([id]).then(function () { toast('Photo deleted'); history.length > 1 ? history.back() : go('#/'); }); }); return;
      case 'add-buck': { var nm = ($('#new-buck').value || '').trim(); if (!nm) { toast('Type a name'); return; } if (addBuck(nm)) { toast('Added ' + nm); render(); } return; }
      case 'buck-save': {
        var b = deer(id); if (!b) return; var n2 = ($('#buck-name').value || '').trim();
        if (n2 && clampStr(n2, 60) !== b.name) { b.renames.push({ from: b.name, at: Date.now() }); if (b.renames.length > 50) b.renames.shift(); b.name = clampStr(n2, 60); }
        var pv = ($('#buck-points') || {}).value; if (pv === '' || pv === undefined) b.points = null; else { var pn = Number(pv); if (!isFinite(pn) || pn < 0 || pn > 40) { toast('Points 0–40, or leave it blank'); return; } b.points = Math.round(pn); }
        b.notes = clampStr($('#buck-notes').value, 2000); save(); toast('Saved'); render(); return;
      }
      case 'buck-del': confirmSheet('Remove this buck?', 'His photos stay in the ledger, just without his name.', 'Remove', true).then(function (ok) {
        if (!ok) return; S.deer = S.deer.filter(function (x) { return x.id !== id; });
        var ch = []; P.forEach(function (p) { var i2 = p.deer.indexOf(id); if (i2 >= 0) { p.deer.splice(i2, 1); if (p.tags.indexOf('buck') < 0) p.tags.push('buck'); ch.push(p); } });
        save(); (ch.length ? photosPutMany(ch) : Promise.resolve()).then(function () { go('#/bucks'); });
      }); return;
      case 'cam-save': { var c3 = cam(id); if (!c3) return; var n3 = ($('#cam-name').value || '').trim(); if (n3) { c3.name = clampStr(n3, 60); save(); toast('Saved'); render(); } return; }
      case 'cam-del': {
        var c4 = cam(id); if (!c4) return; var ids = P.filter(function (p) { return p.cam === id; }).map(function (p) { return p.id; });
        confirmSheet('Delete ' + c4.name + '?', 'This deletes the camera and its ' + plural(ids.length, 'photo') + ' from this phone. Save a backup first if you might want them.', 'Delete', true).then(function (ok) {
          if (!ok) return; S.cameras = S.cameras.filter(function (x) { return x.id !== id; }); S.pulls = S.pulls.filter(function (u) { return u.cam !== id; }); save();
          deletePhotos(ids).then(function () { toast('Camera deleted'); go('#/cams'); });
        }); return;
      }
      case 'unlock': {
        var msg = $('#lic-msg'), key = ($('#lic') || {}).value; a.disabled = true; if (msg) msg.textContent = 'Checking…';
        tryUnlock(key).then(function (r) { a.disabled = false; if (r.ok) { toast(r.msg, 3500); render(); } else if ($('#lic-msg')) $('#lic-msg').textContent = r.msg; });
        return;
      }
      case 'loc-here':
        if (!navigator.geolocation) { toast('Location isn’t available here. Type it in.'); return; }
        toast('Finding you…', 4000);
        navigator.geolocation.getCurrentPosition(function (pos) { $('#lat').value = pos.coords.latitude.toFixed(4); $('#lng').value = pos.coords.longitude.toFixed(4); toast('Got it. Tap Save.'); }, function () { toast('Couldn’t get your location. Type it in.'); }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
        return;
      case 'loc-save': {
        var la = $('#lat').value.trim(), lo = $('#lng').value.trim();
        if (!la && !lo) { S.settings.lat = null; S.settings.lng = null; save(); sunCache = {}; toast('Location cleared'); render(); return; }
        var lan = Number(la), lon = Number(lo);
        if (!la || !lo || !isFinite(lan) || !isFinite(lon) || Math.abs(lan) > 90 || Math.abs(lon) > 180) { toast('Latitude −90…90 and longitude −180…180, please'); return; }
        S.settings.lat = Math.round(lan * 10000) / 10000; S.settings.lng = Math.round(lon * 10000) / 10000; sunCache = {}; save(); toast('Location saved'); render(); return;
      }
      case 'settings-save': {
        var sm = Number($('#shoot').value), gm = Number($('#gap').value);
        if (!isFinite(sm) || sm < 0 || sm > 90 || !isFinite(gm) || gm < 1 || gm > 240) { toast('Shooting light 0–90 min, visit gap 1–240 min'); return; }
        S.settings.shootMin = Math.round(sm); S.settings.gapMin = Math.round(gm); save(); toast('Settings saved'); render(); return;
      }
      case 'backup-full': exportBackup(true); return;
      case 'backup-data': exportBackup(false); return;
      case 'restore': $('#restore-file').click(); return;
      case 'csv': exportCSV(); return;
      case 'del-empties': {
        var em = P.filter(function (p) { return p.done && p.tags.indexOf('empty') >= 0; }).map(function (p) { return p.id; });
        confirmSheet('Delete ' + plural(em.length, 'empty photo') + '?', 'Frees up space. They’re already left out of your ledger.', 'Delete', true).then(function (ok) { if (ok) deletePhotos(em).then(function () { toast('Deleted ' + plural(em.length, 'photo')); render(); }); });
        return;
      }
      case 'erase': confirmSheet('Erase everything?', 'All photos, cameras, bucks and tags on this phone will be deleted. This can’t be undone.', 'Erase', true).then(function (ok) {
        if (!ok) return; var lic = S.settings.license, dev = S.settings.deviceId;
        photosClear().then(function () { Object.keys(urlCache).forEach(dropURL); P = []; PI = {}; S = defaults(); S.settings.license = lic; S.settings.deviceId = dev; WX = {}; DEM = null; return Promise.all([kvPut('wx', {}), kvPut('dem', null)]).then(flush); }).then(function () { toast('Erased'); go('#/'); });
      }); return;
      case 'states-later': S.settings.statesAsked = true; save(); var sp = $('#state-prompt'); if (sp) sp.remove(); return;
      case 'small-show': S.settings.hideSmall = false; save(); render(); return;
      case 'small-hide': S.settings.hideSmall = true; save(); render(); return;
      case 'ph-suggest': { var ps = PI[id], did2 = a.getAttribute('data-deer'); if (!ps || !deer(did2)) return; if (ps.deer.indexOf(did2) < 0) ps.deer.push(did2); ps.tags = ps.tags.filter(function (x) { return x !== 'empty'; }); ps.done = true; photoPut(ps); toast('Tagged ' + deer(did2).name); render(); return; }
      case 'ph-temp': { var pt2 = PI[id]; if (!pt2) return; var tv3 = $('#ph-temp').value; if (tv3 === '') { pt2.temp = null; pt2.tempSrc = null; } else { var tn2 = Number(tv3); if (!isFinite(tn2) || tn2 < -40 || tn2 > 130) { toast('Temp −40 to 130 °F'); return; } pt2.temp = Math.round(tn2); pt2.tempSrc = a.getAttribute('data-src') === 'ocr' ? 'ocr' : 'typed'; } photoPut(pt2); toast('Temp saved'); render(); return; }
      case 'ph-ocr': {
        var po = PI[id]; if (!po || !po.thumb) return; var om = $('#ocr-msg'); a.disabled = true; if (om) om.textContent = 'Reading the ribbon… (first time can take a bit)';
        var go2 = function () { return window.BLOcr ? Promise.resolve() : new Promise(function (res, rej) { var sc = document.createElement('script'); sc.src = 'ocr.js'; sc.onload = res; sc.onerror = rej; document.head.appendChild(sc); }); };
        go2().then(function () { return BLOcr.readTemp(po.thumb); }).then(function (r) {
          a.disabled = false; var m2 = $('#ocr-msg'), inp = $('#ph-temp');
          if (!r) { if (m2) m2.textContent = 'Couldn’t find a temperature on this photo. Type it in.'; return; }
          if (inp) inp.value = r.f; var sb = document.querySelector('[data-act="ph-temp"]'); if (sb) sb.setAttribute('data-src', 'ocr');
          if (m2) m2.innerHTML = 'Looks like <b>' + r.f + '°F</b>' + (r.sure ? ' (°F and °C agree)' : r.fromC ? ' (read from °C)' : '') + '. Check it against the photo, then tap Save.';
        }).catch(function () { a.disabled = false; var m3 = $('#ocr-msg'); if (m3) m3.textContent = 'The reader couldn’t load. It needs internet the first time. Type the temp instead.'; });
        return;
      }
      case 'ph-dir': { var pd = PI[id]; if (!pd) return; var dv2 = a.getAttribute('data-dir'); pd.dir = pd.dir === dv2 ? null : dv2; photoPut(pd); render(); return; }
      case 'buck-photo': {
        var bb = deer(id); if (!bb) return; var mine = P.filter(function (q) { return q.deer.indexOf(id) >= 0 && q.thumb; }).slice(-60).reverse();
        sheet('<h2>Pick his profile photo</h2><div class="pgrid">' + mine.map(function (q) { return '<a href="javascript:void(0)" data-x="pick" data-pid="' + esc(q.id) + '"><img alt="" src="' + thumbURL(q) + '"></a>'; }).join('') + '</div><div class="btn-row" style="margin-top:10px"><button class="btn ink" data-x="close">Cancel</button></div>', function (x, el, close) {
          if (x === 'pick') { bb.photo = el.getAttribute('data-pid'); save(); close(); render(); return false; }
          if (x === 'close') { close(); return false; }
        });
        return;
      }
      case 'cam-face-save': {
        var cf = cam(id); if (!cf) return; var rot = $('#cam-rot').checked, fv = $('#cam-face').value;
        cf.facing = fv === '' ? null : Number(fv); cf.rotating = rot;
        cf.zones = Array.prototype.map.call(document.querySelectorAll('#cam-zones .zone'), function (z, i) { return { name: clampStr((z.querySelector('.z-name').value || '').trim() || ('View ' + (i + 1)), 30), facing: Number(z.querySelector('.z-face').value) || 0 }; }).slice(0, 8);
        if (!rot) cf.zones = cf.zones.length && cf.zones.some(function (z) { return z.name !== 'View 1' || z.facing; }) ? cf.zones : [];
        if (rot && !cf.zones.length) { toast('Add at least one view'); return; }
        save(); toast('Facing saved'); render(); return;
      }
      case 'cam-zone-add': { var wrap = $('#cam-zones'), n4 = wrap.querySelectorAll('.zone').length; if (n4 >= 8) { toast('Up to 8 views'); return; } var row = document.createElement('div'); row.className = 'dt2 zone'; row.innerHTML = '<input type="text" maxlength="30" class="z-name" value="View ' + (n4 + 1) + '"><select class="z-face">' + C8L.map(function (nm, i) { return '<option value="' + (i * 45) + '">' + nm.charAt(0).toUpperCase() + nm.slice(1) + '</option>'; }).join('') + '</select>'; wrap.insertBefore(row, a); return; }
      case 'bait-add': { var cb = cam(id); if (!cb) return; var bd = $('#bait-day').value; if (!/^\d{4}-\d\d-\d\d$/.test(bd)) { toast('Pick the day'); return; } S.bait.push({ id: uid(), cam: cb.id, day: bd, what: clampStr(($('#bait-what').value || '').trim(), 60) }); save(); toast('Bait logged'); render(); return; }
      case 'bait-del': S.bait = S.bait.filter(function (b) { return b.id !== id; }); save(); render(); return;
      case 'pred-lock': {
        if (!canPredict()) { toast('Prediction limit reached'); return; }
        var dr2 = predDraft(predForm.who, predForm.days); if (!dr2) return;
        dr2.cam = $('#pred-cam').value; dr2.from = a.getAttribute('data-from'); dr2.to = a.getAttribute('data-to');
        var t0 = ($('#pred-m0').value || '').split(':'), t1 = ($('#pred-m1').value || '').split(':');
        dr2.m0 = (+t0[0]) * 60 + (+t0[1] || 0); dr2.m1 = (+t1[0]) * 60 + (+t1[1] || 0);
        if (!(dr2.m1 > dr2.m0)) { toast('The end time must be after the start (same day)'); return; }
        var here2 = visits(dr2.who === 'bucks' ? 'bucks' : 'deer:' + dr2.who, dr2.cam); dr2.n = here2.length; dr2.last = here2[0];
        dr2.inWin = here2.filter(function (v) { var mm = v.d.getHours() * 60 + v.d.getMinutes(); return mm >= dr2.m0 && mm <= dr2.m1; }).length;
        makePrediction(dr2).then(function () { toast('Locked in'); render(); }); return;
      }
      case 'wx-visits': closeSheet(); fetchWeatherForVisits().then(function () { render(); }); return;
      case 't3-box': {
        var ac = Number($('#t3-acres').value); if (!isFinite(ac) || ac < 5 || ac > 5000) { toast('5 to 5,000 acres'); return; }
        if (!hasLoc()) { toast('Add your property location first'); return; }
        if (S.settings.lat < 18 || S.settings.lat > 72 || S.settings.lng > -60) { toast('The 3D sim covers the US only'); return; }
        S.t3 = { box: { lat: S.settings.lat, lng: S.settings.lng, acres: Math.round(ac) }, parking: (S.t3 && S.t3.parking) || [] }; save(); render(); return;
      }
      case 't3-dem': a.disabled = true; fetchDem().then(function () { render(); }); return;
      case 't3-reset': confirmSheet('Change the box?', 'You’ll pick the size again and download the elevation again.', 'Change').then(function (ok) { if (ok) { S.t3 = null; save(); render(); } }); return;
      case 't3-park': parkSheet(); return;
      case 't3-wx': {
        var bx = (S.t3 && S.t3.box) || (hasLoc() ? { lat: S.settings.lat, lng: S.settings.lng } : null); if (!bx) { toast('Add your property location first (More)'); return; }
        var dd = t3Day || new Date(), d0 = new Date(dd.getTime() - DAYMS), d1 = new Date(dd.getTime() + DAYMS);
        if (!navigator.onLine) { toast('No internet right now. Try again when you’re online.', 3500); return; }
        toast('Getting weather…', 2500);
        BLWx.fillSite(WX, bx.lat, bx.lng, ymdOf(d0), ymdOf(d1)).then(function () { wxSave(); toast('Weather saved'); engines().forEach(function (e) { e.refresh(); }); })
          .catch(function () { toast('Couldn’t get the weather. Try again later.', 3500); }); return;
      }
      case 'install': if (deferredInstall) { deferredInstall.prompt(); deferredInstall = null; } return;
      case 'install-dismiss': S.settings.installDismissed = true; save(); var n = $('#install-note'); if (n) n.remove(); return;
    }
  });
  document.addEventListener('change', function (e) { if (e.target && e.target.id === 'restore-file') { var f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) restoreFrom(f); } });
  document.addEventListener('keydown', function (e) {
    if (!$('#sort-pass') || /input|textarea|select/i.test((e.target.tagName || ''))) return;
    if (e.key === 'Enter') { e.preventDefault(); sortCommit(sortSel); } else if (e.key === 'e' || e.key === 'E') sortCommit({ tags: ['empty'], deer: [] });
  });

  window.addEventListener('pagehide', function () { if (saveTimer) flush(); });
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden' && saveTimer) flush(); });

  /* ---------------- start ---------------- */
  function boot() {
    openDB().then(function () { return Promise.all([kvGet('state'), photosAll(), kvGet('wx').catch(function () { return null; }), kvGet('dem').catch(function () { return null; })]); }).then(function (r) {
      S = migrate(r[0]);
      WX = (r[2] && typeof r[2] === 'object') ? r[2] : {};
      if (r[3] && r[3].z && r[3].z.length === 80 * 104 && typeof r[3].key === 'string') DEM = { key: r[3].key, z: Float32Array.from(r[3].z), at: r[3].at };
      var camIds = {}, deerIds = {}; S.cameras.forEach(function (c) { camIds[c.id] = 1; }); S.deer.forEach(function (b) { deerIds[b.id] = 1; });
      P = (r[1] || []).map(function (p) { return cleanPhoto(p, camIds, deerIds); }).filter(Boolean);
      PI = {}; P.forEach(function (p) { PI[p.id] = p; });
      render();
      if (window.BLDedup) setTimeout(function () { BLDedup.backfill(P, function (p, one) { if (one) photoPut(p); }); }, 4000);
      setTimeout(function () { recheckLicense().catch(function () {}); }, 3000);
      readyResolve();
    }).catch(function (e) {
      $('#app').innerHTML = '<main class="wrap"><div class="panel"><h2>Storage isn’t available</h2><p>' + esc(APP) + ' keeps your photos in this browser’s storage, and it’s turned off here (private browsing does this). Open it in a normal browser tab.</p></div></main>';
      readyResolve();
    });
  }
  var readyResolve; var ready = new Promise(function (r) { readyResolve = r; });
  if ('serviceWorker' in navigator && /^https?:/.test(location.protocol)) {
    window.addEventListener('load', function () {
      var had = !!navigator.serviceWorker.controller, reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () { if (had && !reloaded) { reloaded = true; location.reload(); } }); // a new version took over: show it now, not on the next visit
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') reg.update().catch(function () {}); });
      }).catch(function () {});
    });
  }
  window.BuckLedger = {
    ready: ready, state: function () { return S; }, photos: function () { return P; },
    readExif: readExif, sunTimes: sunTimes, lightOf: function (d) { return lightOf(d); }, visits: function (s, c) { return visits(s || 'any', c); },
    plainRead: function (s) { return plainRead(visits(s)); }, flush: flush, isPro: function () { return isPro(); }, tier: function () { return tier(); }, sim: function () { return simApi; },
    t3: function () { return t3Api; }, simDemo: function () { return simDemo; }, sha256: sha256, predStatus: function (id) { var p = S.preds.filter(function (x) { return x.id === id; })[0]; return p ? predStatus(p) : null; },
    predOk: function (id) { var p = S.preds.filter(function (x) { return x.id === id; })[0]; return p ? predOk(p) : null; }, idSuggest: function (pid) { return idSuggest(PI[pid]); },
    periodOf: function (d) { return periodOf(d); }, moonInfo: function (d) { return moonInfo(d); }, headingOf: function (pid) { return headingOf(PI[pid]); }, wx: function () { return WX; },
    bulk: function () { return bulk; }, dem: function () { return DEM; }, canPredict: function () { return canPredict(); }
  };
  if (window.BLPins) window.BLPins.attach({ views: VIEWS, S: function () { return S; }, save: save, render: render, isPro: isPro, cam: cam, deer: deer, camName: camName, visits: function (s, c) { return visits(s, c); }, fmtDate: fmtDate, fmtTime: fmtTime, head: head, sheet: sheet, toast: toast, uid: uid, addCamera: addCamera });
  if (window.BLTcl) window.BLTcl.attach({ views: VIEWS, S: function () { return S; }, save: save, render: render, isPro: isPro, cam: cam, camName: camName, visits: function (sub, c) { return visits(sub, c); }, visibleDeer: visibleDeer, photos: function () { return P; }, thumbURL: thumbURL, fmtDate: fmtDate, head: head, toast: toast, esc: esc });
  boot();
})();
