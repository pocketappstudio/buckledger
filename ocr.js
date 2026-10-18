/* Buck Ledger: read the temperature printed on a trail-cam ribbon, ON THE PHONE.
 * Loads the self-hosted Tesseract engine (vendor/ocr) only when the user taps "Read temp from photo".
 * The result is always a suggestion the user must check and save. */
(function () {
  'use strict';
  var worker = null, loading = null;
  function loadScript(src) { return new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { rej(new Error('load ' + src)); }; document.head.appendChild(s); }); }
  function getWorker() {
    if (worker) return Promise.resolve(worker);
    if (loading) return loading;
    loading = (window.Tesseract ? Promise.resolve() : loadScript('vendor/ocr/tesseract.min.js')).then(function () {
      var base = new URL('vendor/ocr/', location.href).href;
      return window.Tesseract.createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, cacheMethod: 'none', workerBlobURL: false });
    }).then(function (w) {
      return w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789-°FC/:AMP ' }).then(function () { worker = w; return w; });
    }).catch(function (e) { loading = null; throw e; });
    return loading;
  }
  function blobImg(blob) { return new Promise(function (res, rej) { var u = URL.createObjectURL(blob), i = new Image(); i.onload = function () { URL.revokeObjectURL(u); res(i); }; i.onerror = function () { URL.revokeObjectURL(u); rej(new Error('img')); }; i.src = u; }); }
  // find the solid dark ribbon at the bottom (or top) edge; returns a black-on-white, 2x upscaled canvas
  function band(img, where) {
    var W = img.naturalWidth, H = img.naturalHeight, c = document.createElement('canvas'); c.width = W; c.height = H;
    // screenshots: crop to the photo first (black bars, phone status / app bars trimmed), so the ribbon sits at the edge
    var r = window.BLStampTrim ? window.BLStampTrim(img) : null;
    if (r && r.trimmed && r.w > 20 && r.h > 20) { W = r.w; H = r.h; c.width = W; c.height = H; }
    var g = c.getContext('2d'); if (r && r.trimmed && r.w > 20 && r.h > 20) g.drawImage(img, r.x, r.y, W, H, 0, 0, W, H); else g.drawImage(img, 0, 0); var d = g.getImageData(0, 0, W, H).data;
    function dark(y) { var n = 0, k = 0; for (var x = 0; x < W; x += 8) { var i = (y * W + x) * 4; if (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11 < 40) n++; k++; } return n / k > 0.6; }
    var y0, y1;
    if (where === 'top') { y1 = 0; while (y1 < H * 0.2 && dark(y1)) y1++; y0 = 0; if (y1 - y0 < 8) return null; }
    else { y0 = H - 1; while (y0 > H * 0.8 && dark(y0)) y0--; y0++; y1 = H; if (y1 - y0 < 8) return null; }
    var h = y1 - y0, o = document.createElement('canvas'); o.width = W * 2; o.height = h * 2;
    var og = o.getContext('2d'); og.imageSmoothingQuality = 'high'; og.drawImage(c, 0, y0, W, h, 0, 0, W * 2, h * 2);
    var od = og.getImageData(0, 0, o.width, o.height), p = od.data;
    for (var i = 0; i < p.length; i += 4) { var v = p[i] * 0.3 + p[i + 1] * 0.59 + p[i + 2] * 0.11 > 150 ? 0 : 255; p[i] = p[i + 1] = p[i + 2] = v; }
    og.putImageData(od, 0, 0); return o;
  }
  function parse(text) {
    var t = String(text || '').replace(/[oO]F/g, '°F'), f = /(-?\d{1,3})\s*°?\s*F(?![A-Z])/.exec(t), c = /(-?\d{1,2})\s*°?\s*C(?![A-Z])/.exec(t);
    var F = f ? Number(f[1]) : null, Cc = c ? Number(c[1]) : null;
    if (F !== null && /^8\d\d$/.test(f[1])) F = Number(f[1].slice(1));   // thermometer icon read as an '8' in front of the digits ("832F" is 32F); 800+ is never a real temperature
    if (F !== null && (F < -40 || F > 130)) F = null;
    if (Cc !== null && (Cc < -40 || Cc > 55)) Cc = null;
    if (F !== null && Cc !== null) return { f: F, sure: Math.abs(Math.round((F - 32) * 5 / 9) - Cc) <= 1 };
    if (F !== null) return { f: F, sure: false };
    if (Cc !== null) return { f: Math.round(Cc * 9 / 5 + 32), sure: false, fromC: true };
    return null;
  }
  function readTemp(blob) {
    return Promise.all([getWorker(), blobImg(blob)]).then(function (r) {
      return setMode(r[0], 'temp').then(function () { return r; });
    }).then(function (r) {
      var w = r[0], img = r[1], tries = ['bottom', 'top'].map(function (k) { return band(img, k); }).filter(Boolean);
      return tries.reduce(function (p, cv) {
        return p.then(function (got) { if (got) return got; return w.recognize(cv).then(function (o) { var v = parse(o.data.text); if (v) v.raw = o.data.text.trim(); return v; }); });
      }, Promise.resolve(null));
    });
  }
  /* ---------- Bulk import: read the whole stamp (date, time, temp, camera name) ---------- */
  var mode = 'temp';
  function setMode(w, m) {
    if (mode === m) return Promise.resolve();
    var prm = m === 'stamp' ? { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '0123456789-°FC/:.AMP ' } : m === 'name' ? { tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ' } : { tessedit_pageseg_mode: '7', tessedit_char_whitelist: '0123456789-°FC/:AMP ' };
    return w.setParameters(prm).then(function () { mode = m; });
  }
  function lum(d, i) { return d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; }
  // The ribbon (solid dark or light strip) touching the top or bottom edge of the photo area; null when the stamp is printed straight on the picture
  function ribbon(img, r, where) {
    var s = Math.min(1, 640 / r.w), w = Math.max(1, Math.round(r.w * s)), h = Math.max(1, Math.round(r.h * s));
    var c = document.createElement('canvas'); c.width = w; c.height = h; var g = c.getContext('2d'); g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, w, h);
    var d = g.getImageData(0, 0, w, h).data;
    // text rows are only ~55-65% dark (the letters are bright), so a row counts when 40% of it is dark; a 2-row gap is tolerated
    function kind(y) { var dk = 0, lt = 0, n = 0; for (var x = 0; x < w; x += 2) { var l = lum(d, (y * w + x) * 4); if (l < 40) dk++; else if (l > 215) lt++; n++; } return dk / n > 0.4 ? 'd' : lt / n > 0.6 ? 'l' : ''; }
    var y = where === 'top' ? 0 : h - 1, step = where === 'top' ? 1 : -1, k0 = kind(y), run = 0, good = 0, gap = 0, cap = h * 0.25;
    if (!k0) return null;
    while (y >= 0 && y < h && run < cap) {
      if (kind(y) === k0) { gap = 0; good = run + 1; } else if (++gap > 2) break;
      y += step; run++;
    }
    if (run >= cap) return null;   // dark all the way to the cap: that is the picture, not a ribbon
    run = good;
    if (run < 5) return null;
    return Math.round(run / s);
  }
  function otsu(hist, total) {
    var sum = 0, i; for (i = 0; i < 256; i++) sum += i * hist[i];
    var sB = 0, wB = 0, best = 0, th = 128;
    for (i = 0; i < 256; i++) { wB += hist[i]; if (!wB) continue; var wF = total - wB; if (!wF) break; sB += i * hist[i]; var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; th = i; } }
    return th;
  }
  // black-on-white canvas of the stamp band, text about 35-40 px tall
  function stampCanvas(img, r, where, target, x0, x1) {
    var rb = ribbon(img, r, where), bh = rb || Math.max(24, Math.round(r.h * 0.08)), onPhoto = !rb;
    var xs = x0 ? Math.round(r.w * x0) : 0, sw = (x1 ? Math.round(r.w * x1) : r.w) - xs;   // x0: skip the left part (logo) of the band
    var sc = Math.max(0.35, Math.min(3, (target || 72) / bh)); if (sw * sc > 2400) sc = 2400 / sw;
    var pad = 12, cw = Math.round(sw * sc), ch = Math.round(bh * sc);
    var c = document.createElement('canvas'); c.width = cw + pad * 2; c.height = ch + pad * 2; var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high';
    g.drawImage(img, r.x + xs, where === 'top' ? r.y : r.y + r.h - bh, sw, bh, pad, pad, cw, ch);
    var id = g.getImageData(pad, pad, cw, ch), p = id.data, hist = new Array(256).fill(0), n = cw * ch, i;
    for (i = 0; i < p.length; i += 4) hist[Math.round(lum(p, i))]++;
    var th = otsu(hist, n), hi = 0; for (i = 0; i < 256; i++) if (i > th) hi += hist[i];
    var textBright = hi < n - hi;   // text is the smaller share of pixels
    for (i = 0; i < p.length; i += 4) { var l = lum(p, i), isText = textBright ? l > th : l <= th, v = isText ? 0 : 255; p[i] = p[i + 1] = p[i + 2] = v; }
    g.putImageData(id, pad, pad); c.__ribbon = !onPhoto; return c;
  }
  var MAP = { O: '0', Q: '0', D: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6' };
  function fixNum(tok) { return tok.replace(/[OQDILSBZG]/g, function (c) { return MAP[c]; }); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function parseStamp(text, opts) {
    opts = opts || {};
    var raw = String(text || '').toUpperCase().replace(/[\n\r]+/g, '  '), out = { date: null, time: null, temp: null, name: '', raw: raw.trim() };
    var toks = raw.split(/\s+/).filter(Boolean), rest = [];
    var dateStr = null, timeStr = null, ampm = null, dotTime = null;
    toks.forEach(function (t) {
      var core = t.replace(/(AM|PM)$/, ''), ap = /(AM|PM)$/.exec(t);
      var digits = (core.match(/[0-9]/g) || []).length, fixed = fixNum(core);
      var fd = (fixed.match(/[0-9]/g) || []).length;
      if (!dateStr && /^\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{2,4}$/.test(fixed) && fd >= 5) { dateStr = fixed; return; }
      if (!timeStr && /^\d{1,2}[:.;]\d{2}([:.;]\d{2})?$/.test(fixed) && digits >= 2) {
        if (/^\d{1,2}\.\d{2}$/.test(fixed) && !ap) { dotTime = dotTime || { t: fixed, ap: null }; rest.push(t); return; }   // "23.57" (barometer, inHg): only a time when no real "08:50" turns up
        timeStr = fixed; if (ap) ampm = ap[1]; return;
      }
      rest.push(t);
    });
    if (!timeStr && dotTime) { timeStr = dotTime.t; }
    /* Trail Cam Link: fallbacks, used only when the token pass above found nothing */
    if (!dateStr) {   // joined to other marks ("2026-11-14-.18:13"), or ':' read for '/' ("09:17:2026"); a 4-digit year keeps it from being a time
      var rz = raw.replace(/([0-9\/\-.:;])[OQD](?=[0-9\/\-.:;])/g, '$10'), mm1 = /(?:^|[^0-9])((?:19|20)\d{2})\s?[\/\-.]\s?(\d{1,2})\s?[\/\-.]\s?(\d{1,2})(?![0-9])/.exec(rz) || /(?:^|[^0-9])(\d{1,2})\s?[\/\-.:;]\s?(\d{1,2})\s?[\/\-.:;]\s?((?:19|20)\d{2})(?![0-9])/.exec(rz);
      if (mm1) { dateStr = mm1[1] + '/' + mm1[2] + '/' + mm1[3]; out.dateFb = true; if (!timeStr) { var rt = rz.replace(mm1[0], ' '), tm1 = /(?:^|[^0-9])(\d{1,2}[:;.]\d{2}(?:[:;.]\d{2})?)(?![0-9])/.exec(rt); if (tm1) { timeStr = tm1[1]; } } }
    }
    if (timeStr && !ampm) { var m = /(^|\s)(AM|PM)(\s|$)/.exec(rest.join(' ')); if (m) ampm = m[2]; }
    var cur = new Date(), yMax = cur.getFullYear() + 1;
    if (dateStr) {
      var q = dateStr.split(/[\/\-.]/).map(Number), y, mo, d;
      if (q[0] > 31) { y = q[0]; mo = q[1]; d = q[2]; }
      else { y = q[2] < 100 ? 2000 + q[2] : q[2]; if (q[0] > 12 && q[1] <= 12) { d = q[0]; mo = q[1]; } else { mo = q[0]; d = q[1]; } }
      if (y >= 2000 && y <= yMax && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) { var dd = new Date(y, mo - 1, d); if (dd.getMonth() === mo - 1) out.date = y + '-' + pad2(mo) + '-' + pad2(d); }
      if (q[0] <= 31) { out.order = q[0] > 12 && q[1] <= 12 ? 'dm' : q[1] > 12 && q[0] <= 12 ? 'md' : (q[0] !== q[1] && q[0] <= 12 && q[1] <= 12 ? 'amb' : null); }
      if (!out.date) {   // one impossible digit (0 read as 6 or 8, 3 as 8 ...): fix it only when exactly one swap gives a real date
        var cf = { '6': ['0', '8', '5'], '8': ['0', '6', '3'], '9': ['0', '8'], '5': ['6', '3'], '1': ['7'], '7': ['1'], '2': ['7'], '3': ['8'] }, ds = dateStr, cands = [];
        for (var ci = 0; ci < ds.length; ci++) (cf[ds[ci]] || []).forEach(function (r2) {
          var c2 = ds.slice(0, ci) + r2 + ds.slice(ci + 1), z = c2.split(/[\/\-.]/).map(Number), y2, m2, d2;
          if (z[0] > 31) { y2 = z[0]; m2 = z[1]; d2 = z[2]; } else { y2 = z[2] < 100 ? 2000 + z[2] : z[2]; if (z[0] > 12 && z[1] <= 12) { d2 = z[0]; m2 = z[1]; } else { m2 = z[0]; d2 = z[1]; } }
          if (y2 >= 2000 && y2 <= yMax && m2 >= 1 && m2 <= 12 && d2 >= 1 && d2 <= 31) { var e2 = new Date(y2, m2 - 1, d2); var v2 = y2 + '-' + pad2(m2) + '-' + pad2(d2); if (e2.getMonth() === m2 - 1 && cands.indexOf(v2) < 0) cands.push(v2); }
        });
        if (cands.length === 1) { out.date = cands[0]; out.dateFixed = true; }
      }
    }
    /* a 0 read as 6 ("16/05/2026" for 10/05/2026, "16/05/2626" too): keep the 6-to-0 reading of day and month as the other choice; the batch decides (bulkFinalize) */
    if (dateStr && out.date) {
      var tk = dateStr.split(/[\/\-.]/);
      if (tk[0].length <= 2 && tk.length === 3 && (/6/.test(tk[0]) || /6/.test(tk[1]))) {
        var a0 = Number(tk[0].replace(/6/g, '0')), b0 = Number(tk[1].replace(/6/g, '0')), y0 = Number(out.date.slice(0, 4)), m0, d0;
        if (a0 > 12 && b0 <= 12) { d0 = a0; m0 = b0; } else { m0 = a0; d0 = b0; }
        if (m0 >= 1 && m0 <= 12 && d0 >= 1 && d0 <= 31 && new Date(y0, m0 - 1, d0).getMonth() === m0 - 1) { var v0 = y0 + '-' + pad2(m0) + '-' + pad2(d0); if (v0 !== out.date) out.dateAlt = v0; }
      }
    }
    if (timeStr) {
      var tq = timeStr.split(/[:.;]/).map(Number), hh = tq[0], mm = tq[1], ss = tq[2] || 0;
      if (ampm) { if (hh >= 1 && hh <= 12) { hh = hh % 12 + (ampm === 'PM' ? 12 : 0); } else hh = -1; }
      if (hh >= 0 && hh < 24 && mm < 60 && ss < 60) out.time = pad2(hh) + ':' + pad2(mm) + ':' + pad2(ss);
    }
    var tp = parse(raw.replace(/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}\b/g, ' ').replace(/\b\d{1,2}[:.;]\d{2}([:.;]\d{2})?\b/g, ' '));
    if (tp) { out.temp = tp.f; out.tempSure = tp.sure; }
    // camera name: a run of letters (with digits allowed inside), at least 3 characters, not AM / PM / unit letters
    var names = rest.filter(function (t) { var L = t.replace(/[^A-Z0-9]/g, ''); if (/^[A-Z]{0,2}(STEALTH|TEALTH|STEAL|EALTHCAM|ALTHCAM|LTHCAM|THCAM|HCAM)|^[A-Z]{0,3}CAM$/.test(L)) return false; if (/^(BROWNING|BUSHNELL|RECONYX|MOULTRIE|SPYPOINT|TACTACAM|COVERT|MUDDY|WILDGAME|BROWNIN|BUSHNEL|MOULTRI|SPYPOIN|TACTACA|REVEAL|REVIEAL|RIEVIEAL|RIEVEAL|TACTAC)/.test(L)) return false; return L.length >= 3 && /[A-Z]{2}/.test(L) && !/^(AM|PM)$/.test(L) && !/^\d/.test(L) && !/^[A-Z]?\d{1,3}[FC]?$/.test(L); });
    out.name = names.slice(0, 2).join(' ').replace(/[^A-Z0-9 ]/g, '').slice(0, 24);
    out.name = out.name.replace(/\b([A-Z]{3,})(?:O0|0O|OO)(\d)\b/g, '$100$2').replace(/\b(CAM(?:ERA)?)O(\d)\b/g, '$10$2');   // CAMOO1 -> CAM001 (zeros read as letter O after a name)
    /* Trail Cam Link: names that end in a number ("BACK 40", "CREEK 2", "CAM 04") lose the number above because bare digits look like a temp. */
    (function () {
      var picked = names.slice(0, 2), li = picked.length ? toks.lastIndexOf(picked[picked.length - 1]) : -1, nx = li >= 0 ? toks[li + 1] : null;
      if (li >= 0 && nx && /^\d{1,2}$/.test(nx) && out.name.length + nx.length < 24) out.name = (out.name + ' ' + nx).slice(0, 24);
      else if (!out.name) { for (var k = 0; k < toks.length - 1; k++) if (/^CAM$/.test(toks[k]) && /^\d{1,2}$/.test(toks[k + 1])) { out.name = 'CAM ' + toks[k + 1]; break; } }
    })();
    return out;
  }
  // Read one photo (an already decoded <img>). pos: 'auto' tries the bottom then the top; 'top' / 'bottom' only that edge.
  // Each band is read at two (up to three) sizes; digits that two reads agree on are 'agreed', the rest is flagged for a look.
  function mode3(list) {   // most frequent value (first seen wins ties); returns [value, votes]
    var cnt = {}, best = null, bn = 0; list.forEach(function (v) { if (v) cnt[v] = (cnt[v] || 0) + 1; });
    list.forEach(function (v) { if (v && cnt[v] > bn) { best = v; bn = cnt[v]; } }); return [best, bn];
  }
  // Second, independent look at the temperature only: the digits are cut out of the band and read again on their own at a bigger size.
  // A different answer flags the temperature (v.tempDisagree) so it lands in 'needs a look'.
  function tempPass(w, cv, r0, v) {
    if (v.temp === null || !r0 || !r0.words) return Promise.resolve(v);
    var t = String(v.temp), hit = null;
    r0.words.forEach(function (wd) { var tx = String(wd.text || ''); if (!hit && wd.bbox && tx.replace(/[^0-9]/g, '').indexOf(t) >= 0 && /[°F]/.test(tx.toUpperCase().replace(/O/g, '°'))) hit = wd.bbox; });
    if (!hit) return Promise.resolve(v);
    var pad = Math.round((hit.y1 - hit.y0) * 0.3), x0 = Math.max(0, hit.x0 - pad), y0 = Math.max(0, hit.y0 - pad), x1 = Math.min(cv.width, hit.x1 + pad), y1 = Math.min(cv.height, hit.y1 + pad);
    var sw = x1 - x0, sh = y1 - y0; if (sw < 4 || sh < 4) return Promise.resolve(v);
    var sc = Math.max(1, Math.min(4, 90 / sh)), m = 20, c = document.createElement('canvas'); c.width = Math.round(sw * sc) + m * 2; c.height = Math.round(sh * sc) + m * 2;
    var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high'; g.drawImage(cv, x0, y0, sw, sh, m, m, Math.round(sw * sc), Math.round(sh * sc));
    return setMode(w, 'temp').then(function () { return w.recognize(c); }).then(function (o) {
      var p = parse(o.data.text); v.temp2 = p ? p.f : null;
      if (p && p.f !== v.temp && !v.tempSure) v.tempDisagree = true;
      return setMode(w, 'stamp');
    }).then(function () { return v; }, function () { return setMode(w, 'stamp').then(function () { return v; }, function () { return v; }); });
  }
  function wordsOf(d) {   // tesseract.js 7 gives words inside blocks > paragraphs > lines
    if (d.words && d.words.length) return d.words;
    var out = []; (d.blocks || []).forEach(function (b) { (b.paragraphs || []).forEach(function (p) { (p.lines || []).forEach(function (l) { (l.words || []).forEach(function (wd) { out.push(wd); }); }); }); }); return out;
  }
  /* Trail Cam Link rescue: only runs when the normal read found no date or no time (text printed straight on the picture, outlines, odd colours).
     Binarizes by brightness percentile at a few band heights instead of Otsu, and keeps the best-scoring read. Always a suggestion the user checks. */
  function rescueCanvas(img, r, where, pct, hfrac) {
    var bh = Math.max(24, Math.round(r.h * hfrac)), sc = Math.max(1, Math.min(3, 96 / bh)); if (r.w * sc > 2400) sc = 2400 / r.w;
    var pad = 12, cw = Math.round(r.w * sc), ch = Math.round(bh * sc), c = document.createElement('canvas'); c.width = cw + pad * 2; c.height = ch + pad * 2;
    var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.imageSmoothingQuality = 'high';
    g.drawImage(img, r.x, where === 'top' ? r.y : r.y + r.h - bh, r.w, bh, pad, pad, cw, ch);
    var id = g.getImageData(pad, pad, cw, ch), p = id.data, hist = new Array(256).fill(0), n = cw * ch, i, acc = 0, th = 255;
    for (i = 0; i < p.length; i += 4) hist[Math.round(lum(p, i))]++;
    for (i = 255; i >= 0; i--) { acc += hist[i]; if (acc >= n * pct) { th = i; break; } }
    th = Math.max(th, 120);
    for (i = 0; i < p.length; i += 4) { var v = lum(p, i) >= th ? 0 : 255; p[i] = p[i + 1] = p[i + 2] = v; }
    g.putImageData(id, pad, pad); return c;
  }
  function rescue(w, img, rect, best) {
    var tries = []; ['bottom', 'top'].forEach(function (wh) { [[0.10, 0.10], [0.06, 0.10], [0.12, 0.07], [0.16, 0.14]].forEach(function (t) { tries.push([wh, t[0], t[1]]); }); });
    var cur = best, ix = 0;
    function sc2(v) { return v ? (v.date ? 2 : 0) + (v.time ? 2 : 0) + (v.temp !== null && v.temp !== undefined ? 1 : 0) : -1; }
    function next() {
      if (ix >= tries.length || (cur && cur.date && cur.time)) return Promise.resolve(cur);
      var t = tries[ix++], cv; try { cv = rescueCanvas(img, rect, t[0], t[1], t[2]); } catch (e) { return next(); }
      return w.recognize(cv).then(function (o) {
        var v = parseStamp(o.data.text); v.band = t[0]; v.rescued = true; v.reads = 1; v.agreed = false; v.conf = o.data.confidence; v.dateVotes = v.date ? 1 : 0; v.timeVotes = v.time ? 1 : 0; v.tempVotes = v.temp !== null ? 1 : 0; v.tempDisagree = false; v.tempSure = !!v.tempSure;
        v.score = sc2(v); v.trimmed = !!rect.trimmed; v.ribbon = false; v.name = '';
        if (!cur || v.score > (cur.score || 0)) cur = v;
        return next();
      }, function () { return next(); });
    }
    return next();
  }
  /* Real-sample fix: a thermometer icon in front of the temperature is read as a digit ("80F" for 0F, "87F" for 7F, "48C" for 8C). The icon is a weakly-read glyph set apart from the digits;
     strip it only when the first glyph is a digit read at <= 90% confidence with a clear gap before the next glyph, and two or more real digits follow. */
  function iconStrip(v) {
    try {
      (v.words || []).forEach(function (wd) {
        if (v.iconStripped || !wd.symbols || wd.symbols.length < 3) return;
        var tx = String(wd.text || '').toUpperCase().replace(/\s/g, ''), um = /([FC])$/.exec(tx); if (!um || /[°O]/.test(tx.slice(0, -1))) return;   // a degree sign means the digits were read cleanly
        var sy = wd.symbols.filter(function (z) { return z.text && /[0-9]/.test(z.text); }); if (sy.length !== 2) return;   // icon + ONE digit ("80F" = 0F); longer fused runs starting with 8 are handled in parse()
        var a = sy[0], b = sy[1]; if (!a.bbox || !b.bbox || a.confidence > 90) return;
        var gap = b.bbox.x0 - a.bbox.x1, hh = a.bbox.y1 - a.bbox.y0; if (!(gap >= Math.max(6, hh * 0.2))) return;
        if (wd.symbols.indexOf(a) > 1) return;
        var after = wd.symbols.slice(wd.symbols.indexOf(a) + 1).filter(function (z) { return z.bbox && /[0-9]/.test(z.text || ''); }), refs = [];
        for (var gi = 1; gi < after.length; gi++) refs.push(after[gi].bbox.x0 - after[gi - 1].bbox.x1);
        refs.sort(function (x, y) { return x - y; }); var ref = refs.length ? refs[refs.length >> 1] : 0;
        if (gap < 2 * ref + 3) return;   // wide-spaced fonts (every gap is big) have no icon to strip   // the icon is the first glyph of the group
        var digits = sy.slice(1).map(function (z) { return z.text; }).join(''); if (!/^\d{1,3}$/.test(digits)) return;
        var n = Number(digits), t = um[1] === 'C' ? Math.round(n * 9 / 5 + 32) : n;
        if ((um[1] === 'F' && n > 130) || (um[1] === 'C' && n > 55)) return;
        v.tempRaw = v.temp; v.temp = t; v.iconStripped = true; v.tempSure = false;
      });
    } catch (e) {}
  }
  /* Real-sample fix (Reconyx): date and temperature are in the top bar, the camera name sits at the left of the bottom bar (logo at the right). Read just that left part. */
  function otherBandName(w, img, rc) {
    var cv; try { cv = stampCanvas(img, rc, 'bottom', 72, 0, 0.3); } catch (e) { return Promise.resolve(''); }
    if (!cv || !cv.__ribbon) return Promise.resolve('');
    return w.recognize(cv).then(function (o) {
      var t = String(o.data.text || '').toUpperCase().replace(/[^A-Z0-9 \-]/g, ' ').replace(/\s+/g, ' ').trim(), tk = t.split(' ').filter(function (x) { return x.replace(/-/g, '').length >= 1; });
      var j = tk.join(' ').replace(/ ?- ?/g, '-');
      var L = j.replace(/[^A-Z0-9]/g, '');
      if (L.length < 3 || L.length > 12 || !/[A-Z]{2}/.test(L) || /^\d/.test(L) || !/\d/.test(L)) return '';   // names like AM174, FS-004, IDFG-027: letters then digits
      return j.replace(/-/g, ' ').replace(/\s+/g, ' ').slice(0, 24);
    }, function () { return ''; });
  }
  function readStamp(img, pos) {
    return getWorker().then(function (w) {
      return setMode(w, 'stamp').then(function () {
        var rect = window.BLStampTrim ? window.BLStampTrim(img) : null;
        if (!rect || !(rect.w > 20 && rect.h > 20)) rect = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
        var order = pos === 'top' ? ['top'] : pos === 'bottom' ? ['bottom'] : ['bottom', 'top'];
        var best = null, bi = 0;
        function readBand(where) {
          var sizes = [72, 56, 96], reads = [], k = 0, cvs = [];
          function one() {
            var cv = stampCanvas(img, rect, where, sizes[k++]); cvs.push(cv);
            return w.recognize(cv, {}, { blocks: true, symbols: true }).then(function (o) { var v = parseStamp(o.data.text); v.conf = o.data.confidence; v.words = wordsOf(o.data); iconStrip(v); reads.push(v); });
          }
          function more() {
            if (reads.length < 2) return one().then(more);
            var a = reads[0], b = reads[1];
            if (reads.length === 2 && (a.date !== b.date || a.time !== b.time || a.temp !== b.temp)) return one().then(more);
            return null;
          }
          return one().then(more).then(function () {
            var d = mode3(reads.map(function (v) { return v.date; })), t = mode3(reads.map(function (v) { return v.time; })), f = mode3(reads.map(function (v) { return v.temp === null ? null : String(v.temp); }));
            var r0 = reads[0], conf = reads.reduce(function (m, v) { return Math.max(m, v.conf || 0); }, 0);
            var v = { date: d[0], time: t[0], temp: f[0] === null ? null : Number(f[0]), dateVotes: d[1], timeVotes: t[1], reads: reads.length, band: where, conf: conf, trimmed: !!rect.trimmed, ribbon: !!cvs[0].__ribbon, raw: r0.raw, name: '' };
            v.agreed = !!(v.date && v.time && d[1] >= 2 && t[1] >= 2);
            v.dateFixed = reads.some(function (r) { return r.dateFixed && r.date === v.date; }); v.dateAlt = (reads.filter(function (r) { return r.dateAlt && r.date === v.date; })[0] || {}).dateAlt || null; v.order = (reads.filter(function (r) { return r.order; })[0] || {}).order || null;
            var tv = {}; reads.forEach(function (r) { if (r.temp !== null) tv[r.temp] = 1; });
            v.tempVotes = f[1]; v.tempDisagree = Object.keys(tv).length > 1 || (reads.length > 1 && f[1] < 2 && Object.keys(tv).length === 1 && reads.some(function (r) { return r.temp === null; }));
            var sure = reads.some(function (r) { return r.tempSure; }); v.tempSure = sure;
            v.score = (v.date ? 2 : 0) + (v.time ? 2 : 0) + (v.temp !== null ? 1 : 0) + (v.agreed ? 1 : 0);
            v._cv = cvs[0]; v._rect = rect;
            return tempPass(w, cvs[0], reads[0], v);
          });
        }
        var fullTried = false;
        function nextBand() {
          if (bi >= order.length) {
            if (rect.trimmed && !fullTried && !(best && best.date && best.time)) {   // trimming may have cut too much: look at the whole image once
              fullTried = true; rect = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight }; bi = 0; return nextBand();
            }
            return Promise.resolve(best);
          }
          return readBand(order[bi++]).then(function (v) {
            if (!best || v.score > best.score) best = v;
            if (v.date && v.time && v.agreed) return best;
            return nextBand();
          });
        }
        return nextBand().then(function (v0) { return (v0 && v0.date && v0.time) ? v0 : rescue(w, img, rect, v0); }).then(function (v) {
          if (!v) return v;
          var cv = v._cv, rc = v._rect; delete v._cv; delete v._rect;
          if (v.date && v.time) {   // second look at the same band with letters allowed, only for the camera name: first the right part (no logo), then the whole band
            var nm = '';
            return setMode(w, 'name').then(function () { return v.band === 'top' ? otherBandName(w, img, rc) : ''; }).then(function (on) { if (on) { nm = on; return null; } return w.recognize(stampCanvas(img, rc, v.band, 72, 0.4)).then(function (o2) { nm = parseStamp(o2.data.text).name; if (nm) return null; return w.recognize(cv).then(function (o3) { nm = parseStamp(o3.data.text).name; }); }); })
              .then(function () { v.name = nm; return setMode(w, 'stamp'); }).then(function () { return v; }, function () { return setMode(w, 'stamp').then(function () { return v; }, function () { return v; }); });
          }
          return v;
        });
      });
    });
  }
  window.BLOcr = { readTemp: readTemp, parse: parse, readStamp: readStamp, parseStamp: parseStamp, _getWorker: getWorker, _stampCanvas: stampCanvas, _setMode: setMode };
})();
