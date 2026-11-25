const APP_ROUTES = new Set(["/", "/index.html", "/human", "/ai"]);
const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#17101e"><title>Language Friend is offline</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 1.25rem; box-sizing: border-box; background: #17101e; color: #fff4f7; font: 1rem/1.6 system-ui, sans-serif }
  main { max-width: 28rem }
  a { color: #e4cbff }
</style>
<main><h1>You're offline</h1><p>Language Friend needs an internet connection for recording, translation, AI Bot and audio playback.</p>
<p><a href="">Try again</a> after you reconnect.</p></main></html>`;

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Online navigations always load the latest frontend. All assets and API traffic
  // bypass this handler, and the worker never writes to Cache Storage.
  if (request.method !== "GET" || request.mode !== "navigate" || url.origin !== self.location.origin ||
      !APP_ROUTES.has(url.pathname)) return;
  event.respondWith(fetch(request, { cache: "no-store" }).catch(() => new Response(OFFLINE_PAGE, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  })));
});
