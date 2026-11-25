// Build first. This isolated HTTP server serves dist and mirrors the Vercel SPA routes.
const assert = require("node:assert/strict");
const { chromium, devices } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { once } = require("node:events");

async function run() {
  const dist = path.resolve("dist");
  const html = await readFile(path.join(dist, "index.html"), "utf8");
  const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
  const documents = new Set(["/", "/index.html", ...vercel.rewrites
    .filter(({ destination }) => destination === "/index.html").map(({ source }) => source)]);
  assert.ok(documents.has("/human") && documents.has("/ai"));
  const types = {
    ".html": "text/html", ".webmanifest": "application/manifest+json", ".js": "text/javascript",
    ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png",
  };
  let release = "one";
  let staleNavigation = false;
  let requests = [];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    requests.push([request.method, pathname]);
    if (pathname.startsWith("/api/")) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ fixture: pathname }));
      return;
    }
    try {
      if (documents.has(pathname)) {
        const stale = staleNavigation && pathname === "/human";
        let document = html.replace('<html lang="en">', '<html lang="en" data-release="' + (stale ? "one" : release) + '">');
        if (stale) {
          staleNavigation = false;
          document = document.replace(/src="\/assets\/[^"]+\.js"/, 'src="/assets/previous-generation.js"');
        }
        if (release === "three") document = document.replace(/src="(\/assets\/[^"]+\.js)"/, 'src="$1?release=three"');
        response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" }).end(document);
        return;
      }
      const file = path.resolve(dist, "." + pathname);
      if (!file.startsWith(dist + path.sep)) return response.writeHead(404).end();
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" }).end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = "http://127.0.0.1:" + server.address().port;
  let context;
  let safari;
  try {
    context = await chromium.launchPersistentContext("", { channel: "chrome", ...devices["Pixel 7"] });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(base + "/human");
    await page.getByRole("button", { name: "Choose the other person's language" }).waitFor();
    await page.waitForFunction(() => navigator.serviceWorker.controller?.scriptURL.endsWith("/sw.js"));
    const cdp = await context.newCDPSession(page);
    const { installabilityErrors } = await cdp.send("Page.getInstallabilityErrors");
    assert.deepEqual(installabilityErrors, []);
    const { url } = await cdp.send("Page.getAppManifest");
    assert.equal(url, base + "/manifest.webmanifest");
    const manifest = await (await context.request.get(url)).json();
    assert.equal(manifest.display, "standalone");
    assert.equal(manifest.start_url, "/");
    assert.equal(manifest.scope, "/");
    assert.equal(manifest.name, "Language Friend");
    assert.ok(manifest.icons.some((icon) => icon.sizes === "512x512" && icon.purpose === "maskable"));
    const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute("href");
    for (const { src, sizes } of [...manifest.icons, { src: apple, sizes: "180x180" }]) {
      const bytes = await (await context.request.get(base + src)).body();
      assert.equal(bytes.subarray(1, 4).toString(), "PNG");
      assert.equal(bytes.readUInt32BE(16) + "x" + bytes.readUInt32BE(20), sizes);
    }
    console.log("Chromium installability, manifest, maskable icon and Apple touch icon passed");

    await page.evaluate(() => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      event.prompt = async () => { window.promptRequested = true; };
      window.dispatchEvent(event);
    });
    await page.getByRole("button", { name: "Open Settings" }).click();
    await page.getByRole("button", { name: "Install Language Friend", exact: true }).click();
    assert.equal(await page.evaluate(() => window.promptRequested), true);
    await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
    assert.equal(await page.getByRole("button", { name: "Install Language Friend", exact: true }).count(), 0);

    safari = await chromium.launchPersistentContext("", { channel: "chrome", ...devices["iPhone 13"] });
    const safariPage = safari.pages()[0] ?? await safari.newPage();
    await safariPage.goto(base + "/ai");
    await safariPage.getByRole("heading", { name: "AI Bot", exact: true }).waitFor();
    await safariPage.getByRole("button", { name: "Open Settings" }).click();
    await safariPage.getByText("Share → Add to Home Screen", { exact: true }).waitFor();
    await safariPage.addInitScript(() => Object.defineProperty(navigator, "standalone", { get: () => true }));
    await safariPage.goto(base + manifest.start_url);
    await safariPage.waitForURL(base + "/human");
    await safariPage.getByRole("button", { name: "Open Settings" }).click();
    assert.equal(await safariPage.getByText("Share → Add to Home Screen", { exact: true }).count(), 0);
    assert.equal(await safariPage.getByRole("button", { name: "Install Language Friend", exact: true }).count(), 0);
    console.log("Install prompt, iPhone guidance, standalone start route and hidden controls passed with simulation");

    await page.goto(base + "/ai");
    await page.getByRole("heading", { name: "AI Bot", exact: true }).waitFor();
    await page.evaluate(async () => {
      for (const endpoint of ["/api/transcribe", "/api/conversations/text", "/api/conversations/pronunciation", "/api/bot/reply", "/api/speech"]) {
        const body = new FormData();
        body.set("sample", "fixture");
        const response = await fetch(endpoint, { method: "POST", body });
        if (!response.ok || (await response.json()).fixture !== endpoint) throw new Error("Service request failed: " + endpoint);
      }
    });
    assert.equal(requests.filter(([method, url]) => method === "POST" && url.startsWith("/api/")).length, 5);
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    await context.setOffline(true);
    await page.getByText(/Recording, translation, AI Bot and audio playback need an internet connection/).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "You're offline" }).waitFor();
    await context.setOffline(false);
    await page.getByRole("link", { name: "Try again" }).click();
    await page.getByRole("heading", { name: "AI Bot", exact: true }).waitFor();
    console.log("Direct routes, offline notice and relaunch, reconnection, and network-only services passed");

    release = "two";
    staleNavigation = true;
    requests = [];
    await page.goto(base + "/human");
    await page.getByRole("button", { name: "Choose the other person's language" }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-release"), "two");
    assert.equal(requests.filter(([, url]) => url === "/assets/previous-generation.js").length, 1);
    assert.equal(requests.filter(([, url]) => url === "/human").length, 2);
    assert.deepEqual(await page.evaluate(() => caches.keys()), []);
    console.log("Update fixture recovered once from a missing previous-generation entry and loaded current HTML");

    release = "three";
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const reload = page.getByRole("button", { name: "Reload app", exact: true });
    await reload.waitFor();
    await reload.click();
    await page.getByRole("button", { name: "Choose the other person's language" }).waitFor();
    assert.equal(await page.locator("html").getAttribute("data-release"), "three");
    assert.equal(await reload.count(), 0);
    console.log("Foreground update fixture offered a reload and loaded the newer entry on tap");
  } finally {
    if (safari) await safari.close();
    if (context) await context.close();
    server.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
