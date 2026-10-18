/* Buck Ledger service worker: caches the app files on the phone.
 * Bump VERSION whenever you publish changes. */
var VERSION = 'buckledger-v3.6.0';
var ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'sim.js', 'terrain.js', 'astro.js', 'wx.js', 'ocr.js', 'dedup.js', 'pins.js', 'tcl.js', 'data/states.js', 'data/example.js', 'fieldtips.js', 'config.js', 'manifest.webmanifest', 'privacy.html',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'
];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(ASSETS.map(function (u) { return new Request(u, { cache: 'reload' }); })); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('buckledger-') === 0 && k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
// Cache first (instant), then refresh the cached copy in the background.
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  var isNav = req.mode === 'navigate' && req.destination !== 'iframe'; // the 3D sim frame is its own page
  e.respondWith(caches.open(VERSION).then(function (cache) {
    return cache.match(isNav ? 'index.html' : req, { ignoreSearch: true }).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok && res.type === 'basic') cache.put(isNav ? 'index.html' : req, res.clone());
        return res;
      }).catch(function () { return hit; });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net.then(function (r) { return r || new Response('Offline', { status: 503 }); });
    });
  }));
});
