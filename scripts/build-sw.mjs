import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const version = createHash("sha256")
  .update(readFileSync("dist/client/index.html"))
  .digest("hex")
  .slice(0, 12);
writeFileSync(
  "dist/client/sw.js",
  `const CACHE='loop55-shell-${version}';const PUBLIC=['/offline.html','/offline.css','/icon-192.png','/icon-512.png','/apple-touch-icon.png','/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PUBLIC))));
self.addEventListener('message',e=>{if(e.data?.type==='ACTIVATE')self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('loop55-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.match('/offline.html')));return}if(PUBLIC.includes(u.pathname))e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request)));});
${readFileSync("public/push-events.js", "utf8")}
`,
);
