import { readFileSync, writeFileSync } from "node:fs";
import { readBuildStamp } from "./build-stamp.ts";
const stamp = readBuildStamp();
if (!stamp) throw new Error("Build stamp missing; run npm run build.");
writeFileSync(
  "dist/web/sw.js",
  `const CACHE=${JSON.stringify(`loop-shell-${stamp.id}`)};const PUBLIC=['/offline.html','/offline.css','/icon-192.png','/icon-512.png','/apple-touch-icon.png','/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PUBLIC))));
self.addEventListener('message',e=>{if(e.data?.type==='ACTIVATE')self.skipWaiting()});
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('loop-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET'||u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;if(e.request.mode==='navigate'){e.respondWith(fetch(e.request).catch(()=>caches.open(CACHE).then(c=>c.match('/offline.html'))));return}if(PUBLIC.includes(u.pathname))e.respondWith(caches.open(CACHE).then(c=>c.match(e.request)).then(r=>r||fetch(e.request)));});
${readFileSync("public/push-events.js", "utf8")}
`,
);
