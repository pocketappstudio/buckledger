/* Duplicate check for photos (Bulk Import and normal upload). Runs on the phone only.
   A photo is a duplicate of an existing entry when ANY of these match:
     exact   SHA-256 of the file bytes
     stamp   time printed on the photo (or the logged time) + same camera + same temperature (a missing temp doesn't block)
     exif    EXIF time + file size
     look    near-identical picture (64-bit difference hash, <= 10 of 64 bits apart) at the same time and camera: catches recompressed or resized copies
   Entries store hash / dh / w / h; older entries get dh back-filled lazily from their saved picture.
   (Old entries only keep a shrunk picture, not the original file, so their SHA-256 can't be rebuilt; they match by stamp / exif / look.) */
(function () {
  'use strict';
  var WHY = { exact: 'same file', stamp: 'same stamp, camera and temp', exif: 'same time and size', look: 'same picture, recompressed or resized' };

  function hex(buf) { var u = new Uint8Array(buf), s = ''; for (var i = 0; i < u.length; i++) s += (u[i] < 16 ? '0' : '') + u[i].toString(16); return s; }
  function sha256(file) {
    if (!(window.crypto && crypto.subtle && file.arrayBuffer)) return Promise.resolve('');
    return file.arrayBuffer().then(function (b) { return crypto.subtle.digest('SHA-256', b); }).then(hex, function () { return ''; });
  }
  // difference hash of a decoded image source (img/canvas/ImageBitmap): 9x8 grayscale, compare neighbours -> 16 hex chars
  function dhashOf(src, sw, sh) {
    try {
      var c = document.createElement('canvas'); c.width = 9; c.height = 8; var g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, sw, sh, 0, 0, 9, 8);
      var d = g.getImageData(0, 0, 9, 8).data, bits = '';
      for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
        var a = (y * 9 + x) * 4, b = a + 4;
        bits += (d[a] * 0.3 + d[a + 1] * 0.59 + d[a + 2] * 0.11) > (d[b] * 0.3 + d[b + 1] * 0.59 + d[b + 2] * 0.11) ? '1' : '0';
      }
      var out = ''; for (var i = 0; i < 64; i += 4) out += parseInt(bits.substr(i, 4), 2).toString(16);
      return out;
    } catch (e) { return ''; }
  }
  // 32x18 grayscale thumbnail as hex (2 chars a pixel). Two copies of one picture (recompressed, resized) differ by under 1 gray level on average;
  // different frames of a burst by 2.5 or more, even in an empty scene. Used when two photos share a minute but their seconds are unknown.
  function tvOf(src, sw, sh) {
    try {
      var c = document.createElement('canvas'); c.width = 32; c.height = 18; var g = c.getContext('2d', { willReadFrequently: true });
      g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, sw, sh, 0, 0, 32, 18);
      var d = g.getImageData(0, 0, 32, 18).data, out = '';
      for (var i = 0; i < d.length; i += 4) { var v = Math.round(d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11); out += (v < 16 ? '0' : '') + v.toString(16); }
      return out;
    } catch (e) { return ''; }
  }
  function tvDiff(a, b) {
    if (!a || !b || a.length !== b.length) return 99;
    var n = a.length / 2, t = 0; for (var i = 0; i < n; i++) t += Math.abs(parseInt(a.substr(i * 2, 2), 16) - parseInt(b.substr(i * 2, 2), 16));
    return t / n;
  }
  function decode(blob) {
    return new Promise(function (res) {
      var url; try { url = URL.createObjectURL(blob); } catch (e) { return res(null); }
      var img = new Image(), done = false, to = setTimeout(function () { if (!done) { done = true; URL.revokeObjectURL(url); res(null); } }, 15000);
      img.onload = function () { if (done) return; done = true; clearTimeout(to); var r = { img: img, w: img.naturalWidth, h: img.naturalHeight, url: url }; res(r); };
      img.onerror = function () { if (done) return; done = true; clearTimeout(to); URL.revokeObjectURL(url); res(null); };
      img.src = url;
    });
  }
  function dhash(blob) {
    return decode(blob).then(function (d) {
      if (!d) return { dh: '', w: 0, h: 0, tv: '' };
      var dh = dhashOf(d.img, d.w, d.h), tv = tvOf(d.img, d.w, d.h); URL.revokeObjectURL(d.url); return { dh: dh, w: d.w, h: d.h, tv: tv };
    });
  }
  function ham(a, b) {
    if (!a || !b || a.length !== b.length) return 99;
    var n = 0; for (var i = 0; i < a.length; i++) { var x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } } return n;
  }
  var MIN_LOOK = 4;
  var norm = function (s) { return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9]/g, ''); };

  // opts: { exifT: 'YYYY-MM-DDTHH:MM:SS'|null, stamp: {date,time,temp,name}|null, camId }
  function fingerprint(file, opts) {
    opts = opts || {};
    return Promise.all([sha256(file), dhash(file)]).then(function (r) { return build(file, r[0], r[1], opts); });
  }
  // opts.sec: false when the stamp time has no seconds (minute only); opts.minute: also compare look-alikes within the same minute
  function build(file, hash, dh, opts) {
    var st = opts.stamp || null, stampT = st && st.date && st.time ? st.date + 'T' + st.time : null, t = opts.exifT || stampT || null;
    return { hash: hash, dh: dh.dh, tv: dh.tv || '', w: dh.w, h: dh.h, size: file.size || 0, exifT: opts.exifT || null,
      t: t, stampT: stampT, temp: st && st.temp != null ? st.temp : (opts.temp != null ? opts.temp : null),
      cam: opts.camId || null, camName: st && st.name ? norm(st.name) : '',
      sec: opts.sec, minT: opts.minute && t ? String(t).slice(0, 16) : null };
  }
  // fields saved on a photo record
  function fields(fp) { return { hash: fp.hash || '', dh: fp.dh || '', tv: fp.tv || '', w: fp.w || 0, h: fp.h || 0 }; }

  function newIndex() { return { hash: {}, exif: {}, time: {}, min: {}, day: {}, n: 0 }; }
  function addTo(idx, e) {   // e: { id, hash, dh, size, exifT, t, temp, cam, camName, stampT }
    idx.n++;
    if (e.hash) idx.hash[e.hash] = e;
    if (e.exifT) idx.exif[e.exifT + '|' + e.size] = e;
    var t = e.stampT || e.t; if (t) { (idx.time[t] = idx.time[t] || []).push(e); var m = String(t).slice(0, 16); (idx.min[m] = idx.min[m] || []).push(e); var dy = String(t).slice(0, 10); (idx.day[dy] = idx.day[dy] || []).push(e); }
  }
  function fromPhoto(p) {
    var st = p.stamp || null;
    return { id: p.id, name: p.name, hash: p.hash || '', dh: p.dh || '', tv: p.tv || '', size: p.size || 0, exifT: p.tsrc === 'exif' ? p.t : null, t: p.t || null,
      stampT: st && st.date && st.time ? st.date + 'T' + st.time : (p.tsrc === 'stamp' ? p.t : null), sec: p.tsrc === 'exif' || !!(st && st.s),
      temp: p.temp == null ? null : p.temp, cam: p.cam || null, camName: st && st.name ? norm(st.name) : '' };
  }
  function buildIndex(photos) { var idx = newIndex(); (photos || []).forEach(function (p) { addTo(idx, fromPhoto(p)); }); return idx; }

  function tempOk(a, b) { return a == null || b == null || Math.round(a) === Math.round(b); }
  function camOk(a, b) { return (a.cam && b.cam && a.cam === b.cam) || (a.camName && b.camName && a.camName === b.camName); }
  function match(idx, fp) {
    if (fp.hash && idx.hash[fp.hash]) return { why: 'exact', of: idx.hash[fp.hash] };
    var t = fp.stampT || fp.t, same = t ? (idx.time[t] || []) : [], i, e;
    if (fp.stampT && fp.sec !== false) for (i = 0; i < same.length; i++) { e = same[i]; if (camOk(fp, e) && tempOk(fp.temp, e.temp)) return { why: 'stamp', of: e }; }
    if (fp.exifT && idx.exif[fp.exifT + '|' + fp.size]) return { why: 'exif', of: idx.exif[fp.exifT + '|' + fp.size] };
    if (fp.dh) {
      var cands = fp.minT ? (idx.min[fp.minT] || []) : same;
      for (i = 0; i < cands.length; i++) {
        e = cands[i]; if (!e.dh && !e.tv) continue;
        var exact = fp.sec !== false && e.sec !== false && (e.stampT || e.t) === t;   // same instant: the loose limit
        if (!exact && fp.sec && e.sec) continue;   // both know their seconds and they differ
        var pic = exact ? ham(fp.dh, e.dh) <= 10 : (fp.tv && e.tv ? tvDiff(fp.tv, e.tv) <= 1.2 : ham(fp.dh, e.dh) <= 2);   // same minute only: a tight test, so burst frames are not taken for copies
        if (pic && (camOk(fp, e) || (!fp.cam && !e.cam)) && tempOk(fp.temp, e.temp)) return { why: 'look', of: e };
      }
    }
    // One misread digit in the hour of a recompressed copy (the stamp reader can slip on a softened picture, e.g. 17:51 read as 18:51): same day,
    // same minute (and same seconds when both know them), hour off by one digit, and the picture matches as tightly as a recompressed copy does.
    // Distinct frames are minutes apart or differ far more in the picture, so the hour-only rule keeps burst frames from being taken for copies.
    if (fp.stampT && fp.tv && fp.dh) {
      var ds = idx.day[String(fp.stampT).slice(0, 10)] || [], a = String(fp.stampT).slice(11, 19), n, k;
      for (i = 0; i < ds.length; i++) {
        e = ds[i]; var et = e.stampT || e.t; if (!e.tv || !et || et === t) continue;
        var b = String(et).slice(11, 19); if (b.length !== 8 || a.slice(3, 5) !== b.slice(3, 5)) continue;
        if (fp.sec !== false && e.sec !== false && a.slice(6) !== b.slice(6)) continue;
        for (n = 0, k = 0; k < 2; k++) if (a[k] !== b[k]) n++;
        if (n === 1 && tvDiff(fp.tv, e.tv) <= 1.2 && ham(fp.dh, e.dh) <= 10 && camOk(fp, e) && tempOk(fp.temp, e.temp)) return { why: 'look', of: e };
      }
    }
    return null;
  }
  function entryFromFp(fp, extra) { var e = { id: null, name: '', hash: fp.hash, dh: fp.dh, tv: fp.tv, size: fp.size, exifT: fp.exifT, t: fp.t, stampT: fp.stampT, temp: fp.temp, cam: fp.cam, camName: fp.camName, sec: fp.sec !== false }; for (var k in extra) e[k] = extra[k]; return e; }

  // Lazy back-fill: compute dh (and w/h) from each saved thumb, a few per idle slot, saving through save(p).
  function backfill(photos, save, opts) {
    opts = opts || {};
    var todo = (photos || []).filter(function (p) { return p.thumb && (!p.dh || !p.tv); }), changed = 0, running = false;
    if (!todo.length) return Promise.resolve(0);
    return new Promise(function (res) {
      function step() {
        var batch = todo.splice(0, opts.batch || 6);
        if (!batch.length) { if (changed && save) save(); return res(changed); }
        Promise.all(batch.map(function (p) { return dhash(p.thumb).then(function (r) { if (r.dh) { if (!p.dh) p.dh = r.dh; p.tv = r.tv; if (!p.w) { p.w = r.w; p.h = r.h; } changed++; if (save) save(p, true); } }); })).then(function () {
          (window.requestIdleCallback || function (f) { setTimeout(f, 60); })(step);
        });
      }
      step();
    });
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // Review block used by both screens. dups: [{ name, why, ofName }]. State kept by the caller.
  function reviewHtml(dups, open) {
    if (!dups || !dups.length) return '';
    var h = '<div class="dedup-box" id="dedup-box"><b>' + dups.length + (dups.length === 1 ? ' duplicate' : ' duplicates') + ' skipped</b>' +
      '<span class="small muted"> (already in your ledger)</span><div class="btn-row" style="margin-top:8px"><button class="btn ink" data-act="dedup-show">' + (open ? 'Hide duplicates' : 'Show duplicates') +
      '</button><button class="btn ink" data-act="dedup-import">Import anyway</button></div>';
    if (open) h += '<ul class="small dedup-list" style="padding-left:18px;margin:8px 0 0">' + dups.map(function (d) {
      return '<li><span class="mono">' + esc(d.name) + '</span> <span class="muted">· ' + esc(WHY[d.why] || d.why) + (d.ofName ? ' (' + esc(d.ofName) + ')' : '') + '</span></li>'; }).join('') + '</ul>';
    return h + '</div>';
  }
  window.BLDedup = { fingerprint: fingerprint, build: build, dhashOf: dhashOf, tvOf: tvOf, tvDiff: tvDiff, MIN_LOOK: function () { return MIN_LOOK; }, fields: fields, buildIndex: buildIndex, newIndex: newIndex, add: addTo, match: match, entryFromFp: entryFromFp, backfill: backfill, reviewHtml: reviewHtml, dhash: dhash, sha256: sha256, ham: ham, WHY: WHY };
})();
