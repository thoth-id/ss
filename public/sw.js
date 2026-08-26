// two reasons for this worker, and offline-first is neither: a call whose media
// is peer-to-peer and whose signaling is a WebSocket does nothing without the
// network.
//
//   1. installability. chrome only offers the install prompt to a page that has
//      a manifest, an icon and a fetch handler.
//   2. a blip mid-call shows this page, already loaded, instead of the
//      browser's error page, so the client's own 1.5s reconnect loop keeps
//      running where a reload would have killed it.
//
// the strategy is network-first for everything, which is backwards for a PWA
// and deliberate here. the client is one hand-edited HTML file served from
// inside the tailnet: the network is a millisecond away, and a cache hit is the
// only way this page could ever go stale. the cache is a safety net, not the
// normal path, for the same reason there is no build step.
const CACHE = "tailcast-v1";

const SHELL = [
	"/",
	"/manifest.webmanifest",
	"/favicon.svg",
	"/favicon-32x32.png",
	"/apple-touch-icon.png",
	"/android-chrome-192x192.png",
	"/android-chrome-512x512.png",
];

self.addEventListener("install", (e) => {
	e.waitUntil(
		caches
			.open(CACHE)
			.then((c) => c.addAll(SHELL))
			.then(() => self.skipWaiting()),
	);
});

// takes over immediately instead of waiting for tabs to close. safe precisely
// because the strategy is network-first: a new worker driving an old tab has no
// way to serve old content.
self.addEventListener("activate", (e) => {
	e.waitUntil(
		caches
			.keys()
			.then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (e) => {
	const url = new URL(e.request.url);
	if (e.request.method !== "GET" || url.origin !== location.origin) return;
	// /config is server state: a cached copy would describe limits that no longer
	// hold. /ws is a WebSocket upgrade and never reaches a fetch handler, listed
	// here to say the omission is deliberate.
	if (url.pathname === "/config" || url.pathname === "/ws") return;

	e.respondWith(
		fetch(e.request)
			.then((res) => {
				// only a good response is stored. a 404 written here would outlive the
				// fix for the missing file.
				if (res.ok) {
					const copy = res.clone();
					caches.open(CACHE).then((c) => c.put(e.request, copy));
				}
				return res;
			})
			.catch(async () => {
				const hit = await caches.match(e.request);
				if (hit) return hit;
				// a navigation with no exact match still lands on the shell: same page.
				if (e.request.mode === "navigate") {
					const shell = await caches.match("/");
					if (shell) return shell;
				}
				return Response.error();
			}),
	);
});
