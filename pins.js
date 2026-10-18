/* Bring Your Pins (Pro). Import waypoints from a GPX / KML / KMZ file the hunter exported himself.
 * Everything runs on this device: no network, no logins, no map layers. Pure parsing lives at the top
 * (testable in Node); the screens attach to the app through BLPins.attach(host). */
(function (root) {
  'use strict';
  var TYPES = ['stand', 'camera', 'sign', 'parking'];
  var LABEL = { stand: 'Stand', camera: 'Camera', sign: 'Sign', parking: 'Parking' };
  var ICON = { stand: '🌲', camera: '📷', sign: '🪧', parking: '🅿️' };
  var MAX_PINS = 3000, MAX_FILE = 25 * 1024 * 1024, MAX_XML = 60 * 1024 * 1024, DUP_M = 10;

  /* ---------- small inflate (RFC 1951), no network, no deps ---------- */
  var LBASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258], LEXT = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  var DBASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577], DEXT = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  var CLORD = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
  function huff(lens) {            // canonical Huffman table: counts + sorted symbols
    var count = new Uint16Array(16), offs = new Uint16Array(16), syms = new Uint16Array(lens.length), i;
    for (i = 0; i < lens.length; i++) count[lens[i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (i = 0; i < lens.length; i++) if (lens[i]) syms[offs[lens[i]]++] = i;
    return { count: count, syms: syms };
  }
  var FIXL, FIXD;
  function inflate(src, maxOut) {
    var pos = 0, bitBuf = 0, bitCnt = 0, out = new Uint8Array(Math.min(Math.max(src.length * 4, 1024), maxOut)), op = 0;
    function bits(n) {
      while (bitCnt < n) { if (pos >= src.length) throw new Error('inflate: truncated'); bitBuf |= src[pos++] << bitCnt; bitCnt += 8; }
      var v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v;
    }
    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1); var c = h.count[len];
        if (code - c < first) return h.syms[index + (code - first)];
        index += c; first += c; first <<= 1; code <<= 1;
      }
      throw new Error('inflate: bad code');
    }
    function put(b) {
      if (op >= out.length) { if (out.length >= maxOut) throw new Error('inflate: too large'); var n = new Uint8Array(Math.min(out.length * 2, maxOut)); n.set(out); out = n; }
      out[op++] = b;
    }
    if (!FIXL) { var l = new Uint8Array(288), k; for (k = 0; k < 144; k++) l[k] = 8; for (; k < 256; k++) l[k] = 9; for (; k < 280; k++) l[k] = 7; for (; k < 288; k++) l[k] = 8; FIXL = huff(l); FIXD = huff(new Uint8Array(30).fill(5)); }
    var last;
    do {
      last = bits(1); var type = bits(2);
      if (type === 0) {
        bitBuf = 0; bitCnt = 0;
        if (pos + 4 > src.length) throw new Error('inflate: truncated');
        var len = src[pos] | (src[pos + 1] << 8); pos += 4;
        if (pos + len > src.length) throw new Error('inflate: truncated');
        for (var j = 0; j < len; j++) put(src[pos++]);
      } else if (type === 1 || type === 2) {
        var lt, dt;
        if (type === 1) { lt = FIXL; dt = FIXD; }
        else {
          var nl = bits(5) + 257, nd = bits(5) + 1, nc = bits(4) + 4, cl = new Uint8Array(19), i;
          for (i = 0; i < nc; i++) cl[CLORD[i]] = bits(3);
          var ch = huff(cl), lens = new Uint8Array(nl + nd); i = 0;
          while (i < nl + nd) {
            var s = decode(ch), rep, val = 0;
            if (s < 16) { lens[i++] = s; continue; }
            if (s === 16) { if (!i) throw new Error('inflate: bad lengths'); val = lens[i - 1]; rep = 3 + bits(2); }
            else if (s === 17) rep = 3 + bits(3); else rep = 11 + bits(7);
            if (i + rep > nl + nd) throw new Error('inflate: bad lengths');
            while (rep--) lens[i++] = val;
          }
          lt = huff(lens.subarray(0, nl)); dt = huff(lens.subarray(nl));
        }
        for (;;) {
          var sym = decode(lt);
          if (sym < 256) put(sym);
          else if (sym === 256) break;
          else {
            sym -= 257; if (sym >= 29) throw new Error('inflate: bad symbol');
            var ln = LBASE[sym] + bits(LEXT[sym]), ds = decode(dt); if (ds >= 30) throw new Error('inflate: bad distance');
            var dist = DBASE[ds] + bits(DEXT[ds]); if (dist > op) throw new Error('inflate: bad distance');
            while (ln--) put(out[op - dist]);
          }
        }
      } else throw new Error('inflate: bad block');
    } while (!last);
    return out.subarray(0, op);
  }

  /* ---------- KMZ (zip) ---------- */
  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function unzipKml(b) {
    var e = -1, i;
    for (i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) if (u32(b, i) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('zip');
    var n = u16(b, e + 10), p = u32(b, e + 16), pick = null, first = null;
    for (i = 0; i < n; i++) {
      if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('zip');
      var meth = u16(b, p + 10), csz = u32(b, p + 20), usz = u32(b, p + 24), nl = u16(b, p + 28), el = u16(b, p + 30), cl = u16(b, p + 32), lo = u32(b, p + 42);
      var name = ''; for (var k = 0; k < nl; k++) name += String.fromCharCode(b[p + 46 + k]);
      var ent = { name: name, meth: meth, csz: csz, usz: usz, lo: lo }, low = name.toLowerCase();
      if (/\.kml$/.test(low)) { if (low === 'doc.kml') { pick = ent; break; } if (!first) first = ent; }
      p += 46 + nl + el + cl;
    }
    pick = pick || first; if (!pick) throw new Error('nokml');
    if (pick.csz === 0xffffffff || pick.usz === 0xffffffff) throw new Error('zip64');
    if (pick.usz > MAX_XML) throw new Error('big');
    if (u32(b, pick.lo) !== 0x04034b50) throw new Error('zip');
    var ds = pick.lo + 30 + u16(b, pick.lo + 26) + u16(b, pick.lo + 28);
    if (ds + pick.csz > b.length) throw new Error('zip');
    var data = b.subarray(ds, ds + pick.csz);
    if (pick.meth === 0) return data;
    if (pick.meth === 8) return inflate(data, MAX_XML);
    throw new Error('method');
  }

  /* ---------- text helpers ---------- */
  var ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeText(s) {
    if (s == null) return '';
    s = String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, function (m, t) { return t.replace(/&/g, '\u0001'); });
    s = s.replace(/<[^>]*>/g, ' ');
    s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, function (m, t) {
      if (t.charAt(0) === '#') { var c = t.charAt(1).toLowerCase() === 'x' ? parseInt(t.slice(2), 16) : parseInt(t.slice(1), 10); return c > 31 && c < 0x110000 ? String.fromCodePoint(c) : ' '; }
      var r = ENT[t.toLowerCase()]; return r === undefined ? m : r;
    });
    return s.replace(/\u0001/g, '&').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function tag(block, name) {
    var m = new RegExp('<(?:[\\w-]+:)?' + name + '\\b[^>]*?(?:/>|>([\\s\\S]*?)</(?:[\\w-]+:)?' + name + '\\s*>)', 'i').exec(block);
    return m ? (m[1] || '') : '';
  }
  function attr(s, name) {
    var m = new RegExp('\\b' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(s);
    return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
  }
  function okCoord(lat, lng) {
    return typeof lat === 'number' && typeof lng === 'number' && isFinite(lat) && isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180 && !(lat === 0 && lng === 0);
  }
  function numStr(s) { s = String(s == null ? '' : s).trim(); return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s) ? Number(s) : NaN; }
  function r6(x) { return Math.round(x * 1e6) / 1e6; }

  /* ---------- type guess (name first, then icon / symbol text) ---------- */
  var RX = {
    camera: /\b(cams?|camera|cameras|trail ?cams?|trailcams?|t-?cams?|game ?cams?|cell ?cam|spypoint|moultrie|reconyx|stealth ?cam|browning|bushnell|tactacam|wildgame)\b/i,
    parking: /\b(park|parking|truck|gate|access|trailhead|th|lot|road|atv|utv|camp|camper|launch)\b/i,
    stand: /\b(stands?|blinds?|ladder|ladderstand|lock-?on|saddle|hang-?on|tower|treestand|tree ?stand|box|perch|hunt(ing)? ?spot|tripod|shooting ?house|bow ?stand|stnd)\b/i,
    sign: /\b(signs?|rubs?|scrapes?|tracks?|beds?|bedding|trail|funnel|crossing|scat|droppings?|shed|sheds|pinch|saddle|rut|buck|doe|deer|bait|feeder|food ?plot|plot|water|pond)\b/i
  };
  function guessType(name, extra) {
    var order = ['camera', 'parking', 'stand', 'sign'], i, t;
    for (i = 0; i < 4; i++) if (RX[order[i]].test(name || '')) return { type: order[i], sure: true };
    for (i = 0; i < 4; i++) if (RX[order[i]].test(extra || '')) return { type: order[i], sure: true };
    return { type: 'stand', sure: false };
  }

  /* ---------- parse ---------- */
  function toText(bytes) {
    if (typeof bytes === 'string') return bytes.replace(/^\ufeff/, '');
    var b = bytes, t;
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) t = new TextDecoder('utf-16le').decode(b);
    else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) t = new TextDecoder('utf-16be').decode(b);
    else t = new TextDecoder('utf-8').decode(b);
    return t.replace(/^\ufeff/, '');
  }
  function count(s, rx) { var m = s.match(rx); return m ? m.length : 0; }
  function parseGPX(x, res) {
    var rx = /<(?:[\w-]+:)?wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?wpt\s*>)/gi, m;
    res.skipped.tracks += count(x, /<(?:[\w-]+:)?trk\b/gi); res.skipped.routes += count(x, /<(?:[\w-]+:)?rte\b/gi);
    while ((m = rx.exec(x))) {
      res.seen++;
      var lat = numStr(attr(m[1], 'lat')), lng = numStr(attr(m[1], 'lon')), body = m[2] || '';
      if (!okCoord(lat, lng)) { res.skipped.invalid++; continue; }
      if (res.pins.length >= MAX_PINS) { res.truncated = true; continue; }
      var name = decodeText(tag(body, 'name')), g = guessType(name, decodeText(tag(body, 'sym') + ' ' + tag(body, 'type')));
      res.pins.push({ name: name.slice(0, 60), lat: r6(lat), lng: r6(lng), type: g.type, sure: g.sure });
    }
  }
  function parseKML(x, res) {
    var rx = /<(?:[\w-]+:)?Placemark\b[^>]*?>([\s\S]*?)<\/(?:[\w-]+:)?Placemark\s*>/gi, m;
    while ((m = rx.exec(x))) {
      var body = m[1], pr = /<(?:[\w-]+:)?Point\b[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?Point\s*>/gi, pm, got = 0;
      var name = decodeText(tag(body, 'name')), extra = decodeText(tag(body, 'styleUrl') + ' ' + tag(body, 'href'));
      while ((pm = pr.exec(body))) {
        got++; res.seen++;
        var c = decodeText(tag(pm[1], 'coordinates')).split(/\s+/)[0].split(','), lng = numStr(c[0]), lat = numStr(c[1]);
        if (!okCoord(lat, lng)) { res.skipped.invalid++; continue; }
        if (res.pins.length >= MAX_PINS) { res.truncated = true; continue; }
        var g = guessType(name, extra);
        res.pins.push({ name: name.slice(0, 60), lat: r6(lat), lng: r6(lng), type: g.type, sure: g.sure });
      }
      if (!got) { if (/<(?:[\w-]+:)?(LineString|LinearRing|Polygon|Track|MultiTrack)\b/i.test(body)) res.skipped.shapes++; else res.skipped.other++; }
    }
  }
  function parse(input, filename) {
    var res = { pins: [], skipped: { tracks: 0, routes: 0, shapes: 0, invalid: 0, other: 0 }, seen: 0, truncated: false, error: null };
    try {
      var len = typeof input === 'string' ? input.length : input.length;
      if (!len) { res.error = 'empty'; return res; }
      if (len > MAX_FILE) { res.error = 'big'; return res; }
      var bytes = input;
      if (typeof input !== 'string' && len > 3 && input[0] === 0x50 && input[1] === 0x4b) bytes = unzipKml(input);
      var x = toText(bytes), kmlish = /<(?:[\w-]+:)?kml\b/i.test(x) || /<(?:[\w-]+:)?Placemark\b/i.test(x), gpxish = /<(?:[\w-]+:)?gpx\b/i.test(x) || /<(?:[\w-]+:)?wpt\b/i.test(x);
      if (!kmlish && !gpxish) { res.error = 'format'; return res; }
      if (gpxish && !(kmlish && /\.(kml|kmz)$/i.test(filename || ''))) parseGPX(x, res); else parseKML(x, res);
      if (!res.pins.length && !res.error) res.error = res.seen || res.skipped.tracks || res.skipped.routes || res.skipped.shapes ? 'nopins' : 'empty';
    } catch (e) {
      res.error = /zip|nokml|method|big|too large|inflate/.test(String(e && e.message)) ? 'zip' : 'format';
    }
    return res;
  }

  /* ---------- geometry, dedup, camera match ---------- */
  function meters(a, b) {
    var R = 6371000, p1 = a.lat * Math.PI / 180, p2 = b.lat * Math.PI / 180, dp = p2 - p1, dl = (b.lng - a.lng) * Math.PI / 180;
    var h = Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function mergeNew(existing, incoming) {   // -> { add:[], dup:n }  (same type + within ~10 m)
    var grid = {}, add = [], dup = 0;
    function key(p) { return p.type + '|' + Math.round(p.lat * 1000) + '|' + Math.round(p.lng * 1000); }
    function near(p) {
      var la = Math.round(p.lat * 1000), ln = Math.round(p.lng * 1000);
      for (var i = -1; i <= 1; i++) for (var j = -1; j <= 1; j++) {
        var l = grid[p.type + '|' + (la + i) + '|' + (ln + j)]; if (!l) continue;
        for (var k = 0; k < l.length; k++) if (meters(l[k], p) <= DUP_M) return true;
      }
      return false;
    }
    function put(p) { (grid[key(p)] = grid[key(p)] || []).push(p); }
    existing.forEach(put);
    incoming.forEach(function (p) { if (near(p)) dup++; else { put(p); add.push(p); } });
    return { add: add, dup: dup };
  }
  function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }
  function matchCamera(name, cams) {
    var n = normName(name); if (n.length < 2) return null;
    var i, c;
    for (i = 0; i < cams.length; i++) if (normName(cams[i].name) === n) return cams[i];
    for (i = 0; i < cams.length; i++) { c = normName(cams[i].name); if (c.length >= 3 && n.length >= 3 && (n.indexOf(c) >= 0 || c.indexOf(n) >= 0)) return cams[i]; }
    return null;
  }

  /* ---------- state: clean on load ---------- */
  function clean(list, camIds, deerIds, uid) {
    var out = [], seen = {};
    (Array.isArray(list) ? list : []).slice(0, MAX_PINS).forEach(function (p) {
      if (!p || typeof p !== 'object') return;
      var lat = typeof p.lat === 'number' ? p.lat : numStr(p.lat), lng = typeof p.lng === 'number' ? p.lng : numStr(p.lng);
      if (!okCoord(lat, lng) || TYPES.indexOf(p.type) < 0) return;
      var id = String(p.id || uid()).slice(0, 40); if (seen[id]) return; seen[id] = 1;
      var o = { id: id, type: p.type, name: String(p.name == null ? '' : p.name).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60), lat: r6(lat), lng: r6(lng), createdAt: (isFinite(Number(p.createdAt)) && p.createdAt >= 0 && p.createdAt <= 1e14) ? Number(p.createdAt) : Date.now() };
      if (typeof p.camId === 'string' && camIds && camIds[p.camId]) o.camId = p.camId;
      if (typeof p.deerlink === 'string' && deerIds && deerIds[p.deerlink]) o.deerlink = p.deerlink;
      out.push(o);
    });
    return out;
  }

  /* ---------- how to export (vendor links verified live) ---------- */
  var HOW = [
    { id: 'onx', name: 'onX Hunt', steps: ['Open My Content and tap Select.', 'Check your waypoints. Swipe the bottom buttons left and tap Export.', 'Save the GPX file to Files.'], url: 'https://support.onxmaps.com/hc/en-us/articles/115002196452-How-to-import-and-export-Markups', link: 'onX’s export help' },
    { id: 'garmin', name: 'Garmin Explore', steps: ['Open Explore on the web and go to your library.', 'Choose your waypoints, then Export.', 'Pick GPX or KML.'], url: 'https://www8.garmin.com/manuals/webhelp/explorewebsiteInd/EN-US/GUID-D1BE278E-D824-4EE5-88BB-2160D9A92C56.html', link: 'Garmin’s export help' },
    { id: 'earth', name: 'Google Earth', steps: ['Open your project.', 'Choose File, then Export as KML file.', 'Save it to Files.'], url: 'https://support.google.com/earth/answer/148150', link: 'Google’s export help' },
    { id: 'basemap', name: 'BaseMap', steps: ['On a computer, open the BaseMap web app.', 'Click Import/Export, then the Export tab.', 'Check your markers and Export. You get BaseMap.kml.'], url: 'https://www.basemap.com/support', link: 'BaseMap support' }
  ];

  var API = { parse: parse, guessType: guessType, mergeNew: mergeNew, matchCamera: matchCamera, clean: clean, meters: meters, inflate: inflate, unzipKml: unzipKml, decodeText: decodeText, TYPES: TYPES, LABEL: LABEL, HOW: HOW, MAX_PINS: MAX_PINS, MAX_FILE: MAX_FILE };

  /* ---------- screens ---------- */
  var H = null, imp = null, shown = 100;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function mapsUrl(p) {
    var ll = p.lat.toFixed(6) + ',' + p.lng.toFixed(6), ios = /iPad|iPhone|iPod|Macintosh/.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1;
    return ios ? 'https://maps.apple.com/?ll=' + ll + '&q=' + encodeURIComponent(p.name || LABEL[p.type]) : 'https://www.google.com/maps/search/?api=1&query=' + ll;
  }
  function coords(p) { return p.lat.toFixed(5) + ', ' + p.lng.toFixed(5); }
  function pinById(id) { var l = H.S().pins; for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null; }
  function pinCam(p) { return p.camId ? H.cam(p.camId) : null; }
  function pinDeer(p) { return p.deerlink ? H.deer(p.deerlink) : null; }
  function sightings(p, memo) {
    var c = pinCam(p), d = pinDeer(p), k = c ? 'c' + c.id : d ? 'd' + d.id : null;
    if (!k) return [];
    if (memo && memo[k]) return memo[k];
    var v = c ? H.visits('any', c.id) : H.visits('deer:' + d.id);
    if (memo) memo[k] = v; return v;
  }
  function fmtV(v) { return H.fmtDate(v.d) + ' ' + H.fmtTime(v.d); }
  function head(title, back) { return H.head(title, back); }
  function pinsView() {
    var S = H.S(), h = head('Bring Your Pins', '#/more');
    if (!H.isPro()) return h + '<div class="paper" id="pins-lock"><p style="margin:0 0 10px"><b>Pro feature.</b> Bring your own pins from a GPX, KML or KMZ file.</p><a class="btn go block" href="#/more">See Pro</a></div>';
    if (imp) return h + reviewHtml();
    var list = S.pins.slice(), memo = {}, counts = {};
    TYPES.forEach(function (t) { counts[t] = 0; }); list.forEach(function (p) { counts[p.type]++; });
    h += '<div class="paper" id="pins-import"><button class="btn go block" data-pin="pick">Choose a pin file</button><input type="file" id="pins-file" accept=".gpx,.kml,.kmz" hidden>' +
      '<p class="small muted" style="margin:8px 0 0">.gpx, .kml or .kmz. Stays on this phone. Colors, notes and photos may not carry over.</p>' +
      '<p class="small" style="margin:6px 0 0"><a href="#/pinhow">How to export from your app</a></p></div>';
    if (!list.length) return h + '<div class="paper"><p class="muted" style="margin:0">No pins yet.</p></div>';
    list.sort(function (a, b) { return TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || a.name.localeCompare(b.name); });
    h += '<div class="paper" id="pins-list"><p class="small muted" style="margin:0 0 8px">' + TYPES.filter(function (t) { return counts[t]; }).map(function (t) { return LABEL[t] + 's ' + counts[t]; }).join(' · ') + '</p><ul class="list">' +
      list.slice(0, shown).map(function (p) {
        var n = sightings(p, memo).length;
        return '<li><button class="item" style="width:100%;text-align:left;background:none;border:0;font:inherit;color:inherit" data-pin="open" data-id="' + esc(p.id) + '"><span class="thumb">' + ICON[p.type] + '</span><span class="t"><b>' + esc(p.name || LABEL[p.type]) + '</b><span>' + esc(LABEL[p.type]) + ' · ' + coords(p) + '</span></span><span>' + (n ? plural(n) : '') + ' ›</span></button></li>';
      }).join('') + '</ul>' + (list.length > shown ? '<button class="btn block" style="margin-top:8px" data-pin="more">Show more (' + (list.length - shown) + ')</button>' : '') + '</div>';
    return h;
  }
  function plural(n) { return n + (n === 1 ? ' sighting' : ' sightings'); }
  function reviewHtml() {
    var S = H.S(), m = mergeNew(S.pins, imp.pins), sk = imp.skipped, skn = sk.tracks + sk.routes + sk.shapes + sk.other, dupSet = {};
    var addSet = {}; m.add.forEach(function (p) { addSet[p._i] = 1; });
    var unsure = imp.pins.filter(function (p) { return !p.sure; }).length;
    var h = '<div class="paper" id="pins-review"><p style="margin:0 0 4px"><b>' + imp.pins.length + (imp.pins.length === 1 ? ' pin' : ' pins') + '</b> in ' + esc(imp.file) + '</p>' +
      '<p class="small muted" style="margin:0 0 8px">' + (skn ? 'Skipped ' + skn + ' track/line/shape' + (skn === 1 ? '' : 's') + '. ' : '') + (sk.invalid ? sk.invalid + ' with bad coordinates skipped. ' : '') + (imp.truncated ? 'Only the first ' + MAX_PINS + ' kept. ' : '') + (m.dup ? m.dup + ' already saved. ' : '') + 'Tap a type to change it.' + (unsure ? ' Unsure ones are marked ?.' : '') + '</p>';
    h += '<ul class="list">' + imp.pins.slice(0, 300).map(function (p) {
      var isDup = !addSet[p._i];
      return '<li style="' + (isDup ? 'opacity:.5' : '') + '"><div class="item" style="display:flex;align-items:center;gap:10px"><button class="btn sm" data-pin="cycle" data-i="' + p._i + '" aria-label="Change type" style="min-width:92px">' + ICON[p.type] + ' ' + LABEL[p.type] + (p.sure ? '' : ' ?') + '</button><span class="t"><b>' + esc(p.name || 'No name') + '</b><span>' + (isDup ? 'Already saved' : coords(p)) + '</span></span></div></li>';
    }).join('') + '</ul>' + (imp.pins.length > 300 ? '<p class="tiny muted">Showing the first 300. The rest keep their guessed type.</p>' : '');
    h += '<div class="btn-row" style="margin-top:10px"><button class="btn go" data-pin="save"' + (m.add.length ? '' : ' disabled') + '>Save ' + m.add.length + '</button><button class="btn ink" data-pin="cancel">Cancel</button></div></div>';
    return h;
  }
  function howView() {
    var h = head('Export your pins', '#/pins');
    h += '<div class="paper"><p class="small muted" style="margin:0">Export a file from your other app, then choose it in Bring Your Pins. Steps can change; the vendor’s page is the source.</p></div>';
    HOW.forEach(function (a) {
      h += '<div class="paper"><h3>' + esc(a.name) + '</h3><ol class="small" style="margin:0 0 8px;padding-left:20px">' + a.steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol><a href="' + esc(a.url) + '" target="_blank" rel="noopener">' + esc(a.link) + ' ↗</a></div>';
    });
    return h + '<a class="btn go block" href="#/pins">Choose a pin file</a>';
  }
  function openPin(id) {
    var p = pinById(id); if (!p) return;
    var S = H.S(), c = pinCam(p), d = pinDeer(p), vs = sightings(p), match = !c && p.type === 'camera' ? matchCamera(p.name, S.cameras) : null;
    var h = '<h2>' + ICON[p.type] + ' ' + esc(p.name || LABEL[p.type]) + '</h2>' +
      '<div class="btn-row" style="margin-bottom:8px">' + TYPES.map(function (t) { return '<button class="btn sm ' + (t === p.type ? 'go' : '') + '" data-x="type" data-t="' + t + '">' + LABEL[t] + '</button>'; }).join('') + '</div>' +
      '<p style="margin:0 0 8px">' + coords(p) + ' · <a href="' + esc(mapsUrl(p)) + '" target="_blank" rel="noopener">Open in Maps ↗</a></p>';
    if (p.type === 'camera' || p.type === 'stand') {
      h += '<label class="field"><span>Linked camera</span><select id="pin-cam"><option value="">None</option>' + S.cameras.map(function (x) { return '<option value="' + esc(x.id) + '"' + (c && c.id === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label>';
      if (!c && p.type === 'camera') h += (match ? '<button class="btn block" data-x="link" data-c="' + esc(match.id) + '">Link to “' + esc(match.name) + '”</button>' : '<button class="btn block" data-x="mkcam">Make camera “' + esc(p.name || 'Camera') + '”</button>');
      if (S.deer.length) h += '<label class="field"><span>Linked buck</span><select id="pin-deer"><option value="">None</option>' + S.deer.map(function (x) { return '<option value="' + esc(x.id) + '"' + (d && d.id === x.id ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select></label>';
    }
    h += '<h3 style="margin:10px 0 4px">Recent sightings</h3>' + (vs.length ? '<ul class="small" style="margin:0 0 8px;padding-left:18px">' + vs.slice(0, 5).map(function (v) { return '<li>' + esc(fmtV(v)) + ' · ' + esc(H.camName(v.cam)) + '</li>'; }).join('') + '</ul>' : '<p class="small muted" style="margin:0 0 8px">' + (c || d ? 'None yet.' : 'Link a camera or buck to see sightings.') + '</p>');
    h += '<div class="btn-row"><button class="btn ink" data-x="close">Done</button><button class="btn danger" data-x="del">Delete pin</button></div>';
    H.sheet(h, function (x, b, close) {
      if (x === 'type') { p.type = b.getAttribute('data-t'); H.save(); close(null); H.render(); return false; }
      if (x === 'link') { p.camId = b.getAttribute('data-c'); H.save(); close(null); H.render(); return false; }
      if (x === 'mkcam') { var nc = H.addCamera(p.name || 'Camera'); if (nc) { p.camId = nc; H.save(); H.toast('Camera made and linked.'); } close(null); H.render(); return false; }
      if (x === 'del') { var S2 = H.S(); S2.pins = S2.pins.filter(function (q) { return q.id !== p.id; }); H.save(); close(null); H.render(); return false; }
    });
    var sc = document.getElementById('pin-cam'), sd = document.getElementById('pin-deer');
    if (sc) sc.addEventListener('change', function () { if (sc.value) p.camId = sc.value; else delete p.camId; H.save(); H.render(); document.getElementById('sheet-root').innerHTML = ''; openPin(id); });
    if (sd) sd.addEventListener('change', function () { if (sd.value) p.deerlink = sd.value; else delete p.deerlink; H.save(); H.render(); document.getElementById('sheet-root').innerHTML = ''; openPin(id); });
  }
  function startImport(file) {
    if (!H.isPro()) { H.toast('Bring Your Pins is a Pro feature.'); return; }
    if (file.size > MAX_FILE) { H.toast('That file is too big (25 MB max).', 3500); return; }
    var r = new FileReader();
    r.onerror = function () { H.toast('Couldn’t read that file.', 3000); };
    r.onload = function () {
      var res = parse(new Uint8Array(r.result), file.name);
      var msg = { empty: 'No pins found in that file.', nopins: 'No pins found. Only waypoints are imported, not tracks or routes.', format: 'That doesn’t look like a GPX, KML or KMZ file.', zip: 'Couldn’t open that KMZ file.', big: 'That file is too big (25 MB max).' }[res.error];
      if (msg) { H.toast(msg, 3500); return; }
      res.pins.forEach(function (p, i) { p._i = i; });
      imp = { file: file.name.slice(0, 40), pins: res.pins, skipped: res.skipped, truncated: res.truncated };
      H.render(); window.scrollTo(0, 0);
    };
    r.readAsArrayBuffer(file);
  }
  function saveImport() {
    var S = H.S(), m = mergeNew(S.pins, imp.pins), linked = 0, room = MAX_PINS - S.pins.length;
    m.add.slice(0, Math.max(0, room)).forEach(function (p) {
      var o = { id: H.uid(), type: p.type, name: p.name, lat: p.lat, lng: p.lng, createdAt: Date.now() };
      if (p.type === 'camera') { var c = matchCamera(p.name, S.cameras); if (c) { o.camId = c.id; linked++; } }
      S.pins.push(o);
    });
    var n = Math.min(m.add.length, Math.max(0, room));
    imp = null; shown = 100; H.save(); H.render();
    H.toast('Saved ' + n + (n === 1 ? ' pin' : ' pins') + (linked ? ' · ' + linked + ' linked to cameras' : '') + (m.add.length > n ? ' · pin limit reached' : ''), 3500);
  }
  function attach(host) {
    H = host;
    H.views.pins = pinsView; H.views.pinhow = howView;
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-pin]'); if (!b) return;
      var a = b.getAttribute('data-pin');
      if (a === 'pick') { var f = document.getElementById('pins-file'); if (f) f.click(); }
      else if (a === 'open') openPin(b.getAttribute('data-id'));
      else if (a === 'more') { shown += 200; H.render(); }
      else if (a === 'cancel') { imp = null; H.render(); }
      else if (a === 'save') { if (imp && H.isPro()) saveImport(); }
      else if (a === 'cycle') { var p = imp && imp.pins[+b.getAttribute('data-i')]; if (p) { p.type = TYPES[(TYPES.indexOf(p.type) + 1) % 4]; p.sure = true; var y = window.scrollY; H.render(); window.scrollTo(0, y); } }
    });
    document.addEventListener('change', function (e) {
      if (!e.target || e.target.id !== 'pins-file') return;
      var f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) startImport(f);
    });
    window.addEventListener('hashchange', function () { if (!/^#\/pins/.test(location.hash)) imp = null; });
  }
  API.attach = attach;
  API.__test = { reviewHtml: function () { return imp ? reviewHtml() : ''; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.BLPins = API;
})(typeof window !== 'undefined' ? window : globalThis);
