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
    if (F !== null && (F < -40 || F > 130)) F = null;
    if (Cc !== null && (Cc < -40 || Cc > 55)) Cc = null;
    if (F !== null && Cc !== null) return { f: F, sure: Math.abs(Math.round((F - 32) * 5 / 9) - Cc) <= 1 };
    if (F !== null) return { f: F, sure: false };
    if (Cc !== null) return { f: Math.round(Cc * 9 / 5 + 32), sure: false, fromC: true };
    return null;
  }
  function readTemp(blob) {
    return Promise.all([getWorker(), blobImg(blob)]).then(function (r) {
      var w = r[0], img = r[1], tries = ['bottom', 'top'].map(function (k) { return band(img, k); }).filter(Boolean);
      return tries.reduce(function (p, cv) {
        return p.then(function (got) { if (got) return got; return w.recognize(cv).then(function (o) { var v = parse(o.data.text); if (v) v.raw = o.data.text.trim(); return v; }); });
      }, Promise.resolve(null));
    });
  }
  window.BLOcr = { readTemp: readTemp, parse: parse };
})();
