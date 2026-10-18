/* Trail Cam Link (Pro). One screen that ties the card import, your cameras (and their pins) and your bucks together.
 * Nothing new is stored: the buck inventory is computed from the photos you already tagged, the camera list is the
 * same one Bring Your Pins links to. Everything stays on this phone. Pure helpers are testable in Node. */
(function (root) {
  'use strict';
  var H = null, API = {};
  function dayKey(d) { return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }
  /* Inventory rows from sightings (visit lists as returned by the app: newest first, each {cam, d, photos[]}). Pure. */
  function inventory(deerList, visitsOf) {
    return deerList.map(function (b) {
      var vs = visitsOf(b.id) || [], byCam = {}, lit = {}, photos = 0, i;
      for (i = 0; i < vs.length; i++) { var k = vs[i].cam || '_'; byCam[k] = (byCam[k] || 0) + 1; photos += vs[i].photos.length; if (vs[i].light === 'day' || vs[i].light === 'light') lit[k] = (lit[k] || 0) + 1; }
      var best = null; Object.keys(byCam).forEach(function (k) { if (best === null || byCam[k] > byCam[best] || (byCam[k] === byCam[best] && (lit[k] || 0) > (lit[best] || 0))) best = k; });
      return { id: b.id, name: b.name, points: b.points, sightings: vs.length, photos: photos, first: vs.length ? vs[vs.length - 1].d : null, last: vs.length ? vs[0].d : null, bestCam: best === '_' ? null : best, bestN: best ? byCam[best] : 0, cams: Object.keys(byCam).length, cover: vs.length ? vs[0].photos[0] : null };
    }).sort(function (a, b) { return (b.last ? b.last.getTime() : 0) - (a.last ? a.last.getTime() : 0) || a.name.localeCompare(b.name); });
  }
  function norm(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  /* After a card import made a new camera: link a same-named camera pin that has no camera yet. Returns the pin or null. */
  function autoLink(S, camera) {
    if (!camera || !S || !Array.isArray(S.pins)) return null;
    var n = norm(camera.name); if (n.length < 2) return null;
    if (S.pins.some(function (p) { return p.camId === camera.id; })) return null;
    var hit = S.pins.filter(function (p) { return !p.camId && p.type === 'camera' && norm(p.name) === n; });
    if (hit.length !== 1) return null;
    hit[0].camId = camera.id; return hit[0];
  }
  function esc(s) { return H.esc(s); }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
  function view() {
    var S = H.S(), h = H.head('Trail Cam Link', '#/more');
    if (!H.isPro()) return h + '<div class="paper" id="tcl-lock"><p style="margin:0 0 10px"><b>Pro feature.</b> Import your card, link cameras to your pins, and see every buck at a glance.</p><a class="btn go block" href="#/more">See Pro</a></div>';
    h += '<div class="paper" id="tcl-import"><a class="btn go block" href="#/bulk" data-tcl="import">Import card photos</a><p class="small muted" style="margin:8px 0 0">Any brand. Date and time come from the photo, or from the printed stamp. Stays on this phone.</p></div>';
    var rows = inventory(H.visibleDeer(), function (id) { return H.visits('deer:' + id); });
    h += '<div class="paper" id="tcl-bucks"><h3>Buck inventory</h3>';
    if (!rows.length) h += '<p class="small muted" style="margin:0">No bucks yet. Tag one in the <a href="#/sort">Sort Pass</a>.</p>';
    else h += '<ul class="list">' + rows.map(function (r) {
      var cv = r.cover;
      return '<li><a class="item" data-tcl="buck" href="#/buck/' + encodeURIComponent(r.id) + '">' + (cv && cv.thumb ? '<img class="thumb" alt="" src="' + H.thumbURL(cv) + '">' : '<span class="thumb">★</span>') +
        '<span class="t"><b>' + esc(r.name) + (r.points !== null ? ' <span class="pts">' + r.points + ' pts</span>' : '') + '</b><span style="display:block">' + (r.sightings ? plural(r.photos, 'photo') + ' · ' + plural(r.sightings, 'sighting') : 'No photos yet') + '</span>' +
        (r.sightings ? '<span style="display:block">' + esc(H.fmtDate(r.first)) + (dayKey(r.first) !== dayKey(r.last) ? ' → ' + esc(H.fmtDate(r.last)) : '') + '</span>' : '') +
        (r.bestCam ? '<span style="display:block">Best: ' + esc(H.camName(r.bestCam)) + (r.cams > 1 ? ' (' + r.bestN + ' of ' + r.sightings + ')' : '') + '</span>' : '') + '</span><span>›</span></a></li>';
    }).join('') + '</ul>';
    var todo = H.photos().filter(function (p) { return !p.done; }).length;
    h += '<a class="btn ink block" style="margin-top:10px" href="#/sort" data-tcl="sort">' + (todo ? 'Tag photos (' + todo + ')' : 'Sort Pass') + '</a></div>';
    h += '<div class="paper" id="tcl-cams"><h3>Camera spots</h3>';
    if (!S.cameras.length) h += '<p class="small muted" style="margin:0">No cameras yet. Your first card import makes one.</p>';
    else {
      var free = S.pins.filter(function (p) { return !p.camId; });
      h += '<ul class="list">' + S.cameras.map(function (c) {
        var n = H.photos().filter(function (p) { return p.cam === c.id; }).length, pin = S.pins.filter(function (p) { return p.camId === c.id; })[0];
        return '<li><div class="item" style="display:block"><span class="t"><b>' + esc(c.name) + '</b><span style="display:block">' + plural(n, 'photo') + '</span></span>' +
          '<div style="display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">' + (pin ? '<span class="small">📍 ' + esc(pin.name || 'Pin') + ' <button class="btn sm plain" style="color:var(--ink);border-color:var(--ink2)" data-tcl="unlink" data-c="' + esc(c.id) + '">Unlink</button></span>' :
          (free.length ? '<select class="tcl-pin" data-c="' + esc(c.id) + '" aria-label="Link a pin to ' + esc(c.name) + '"><option value="">Link a pin…</option>' + free.map(function (p) { return '<option value="' + esc(p.id) + '">' + esc(p.name || 'Pin') + '</option>'; }).join('') + '</select>' : '<span class="small muted">No pin</span>')) +
          '<button class="btn sm ink" data-tcl="card" data-c="' + esc(c.id) + '" style="margin-left:auto">Import card here</button></div></div></li>';
      }).join('') + '</ul>';
    }
    return h + '</div>';
  }
  function attach(host) {
    H = host; H.views.tcl = view;
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('[data-tcl]'); if (!b) return;
      var a = b.getAttribute('data-tcl'), S = H.S(), c = b.getAttribute('data-c');
      if (a === 'card') { S.settings.lastCam = c; H.save(); location.hash = '#/bulk'; e.preventDefault(); }
      else if (a === 'unlink') { S.pins.forEach(function (p) { if (p.camId === c) delete p.camId; }); H.save(); H.render(); }
    });
    document.addEventListener('change', function (e) {
      var t = e.target; if (!t || !t.classList || !t.classList.contains('tcl-pin') || !t.value) return;
      var S = H.S(), p = S.pins.filter(function (x) { return x.id === t.value; })[0]; if (!p || !H.cam(t.getAttribute('data-c'))) return;
      p.camId = t.getAttribute('data-c'); H.save(); H.toast('Pin linked.'); H.render();
    });
  }
  API.inventory = inventory; API.autoLink = autoLink; API.attach = attach;
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.BLTcl = API;
})(typeof window !== 'undefined' ? window : globalThis);
