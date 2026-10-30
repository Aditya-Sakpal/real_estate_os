/**
 * The scanner's service worker, so the scan page opens with no signal once
 * it has been opened with one. It keeps the page and the static files it
 * loads, and nothing else: the check-ins themselves wait in the phone's own
 * queue (IndexedDB), never in this cache, and are sent through the network
 * or not at all.
 *
 * Served as a route so it can carry `Service-Worker-Allowed`: the page lives
 * at `/dashboard/visits/scan`, which is not inside the folder this script's
 * own address would limit it to.
 */
export const dynamic = "force-static";

const SCOPE = "/dashboard/visits/scan";
const CACHE = "salesdesk-scan-v1";

const SOURCE = `
const CACHE = ${JSON.stringify(CACHE)};
const PAGE = ${JSON.stringify(SCOPE)};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE && k.startsWith("salesdesk-scan-")) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Hashed build files never change under one name: the cache first.
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  // The page: the network first, the last copy when there is no signal.
  if (url.pathname === PAGE && req.mode === "navigate") {
    e.respondWith((async () => {
      const c = await caches.open(CACHE);
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected) c.put(PAGE, res.clone());
        return res;
      } catch {
        return (await c.match(PAGE)) || Response.error();
      }
    })());
  }
});
`;

export function GET() {
  return new Response(SOURCE, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": SCOPE,
    },
  });
}
