/* All resources are same-origin. Preparing offline never sends source pixels. */
const VERSION = "__BUILD_VERSION__";
const CACHE = "prism-stage-" + VERSION;
const BASE = new URL("./", self.location.href);
let preparing = false;
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys())
        if (name.startsWith("prism-stage-") && name !== CACHE)
          await caches.delete(name);
      await self.clients.claim();
    })(),
  ),
);
async function notify(status) {
  for (const client of await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  }))
    client.postMessage({ type: "OFFLINE_STATUS", status });
}
async function manifest() {
  const cache = await caches.open(CACHE);
  const url = new URL("offline-manifest.json", BASE);
  let response;
  try {
    response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error("Cannot read offline manifest.");
    await cache.put(url, response.clone());
  } catch (error) {
    response = await cache.match(url);
    if (!response) throw error;
  }
  return response.json();
}
self.addEventListener("message", (event) => {
  if (event.data?.type === "CHECK_OFFLINE")
    event.waitUntil(
      (async () => {
        try {
          const data = await manifest(),
            cache = await caches.open(CACHE);
          const matches = await Promise.all(
            data.files.map((file) => cache.match(new URL(file, BASE))),
          );
          const ready = matches.every(Boolean);
          await notify({
            state: ready ? "ready" : "idle",
            progress: ready ? 1 : 0,
            message: ready
              ? "All studio resources are cached."
              : "Download studio resources for offline use.",
          });
        } catch (error) {
          await notify({ state: "error", progress: 0, message: String(error) });
        }
      })(),
    );
  if (event.data?.type === "PREPARE_OFFLINE")
    event.waitUntil(
      (async () => {
        if (preparing) return;
        preparing = true;
        try {
          const data = await manifest(),
            cache = await caches.open(CACHE);
          let completed = 0;
          await notify({
            state: "loading",
            progress: 0,
            message: "Downloading local models and studio assets.",
          });
          const queue = [...data.files];
          const outcomes = await Promise.allSettled(
            Array.from({ length: 4 }, async () => {
              while (queue.length) {
                const path = queue.shift();
                const url = new URL(path, BASE);
                if (!(await cache.match(url))) {
                  const res = await fetch(url);
                  if (!res.ok)
                    throw new Error(`Cannot cache ${path}. Please retry.`);
                  await cache.put(url, res);
                }
                completed++;
                await notify({
                  state: "loading",
                  progress: completed / data.files.length,
                  message: `${completed} of ${data.files.length} resources ready.`,
                });
              }
            }),
          );
          const failed = outcomes.find(
            (result) => result.status === "rejected",
          );
          if (failed) throw failed.reason;
          await notify({
            state: "ready",
            progress: 1,
            message:
              "All studio resources are cached. You can reopen the studio offline.",
          });
        } catch (error) {
          await notify({ state: "error", progress: 0, message: String(error) });
        } finally {
          preparing = false;
        }
      })(),
    );
});
self.addEventListener("fetch", (event) => {
  const request = event.request,
    url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== BASE.origin ||
    !url.pathname.startsWith(BASE.pathname)
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // This cache contains only public, same-origin static build resources.
      // Module requests can carry Origin while the preparation fetch does not;
      // a development/static host's Vary: Origin must not break offline boot.
      const cached = await cache.match(request, { ignoreVary: true });
      if (cached) return cached;
      if (request.mode === "navigate") {
        try {
          return await fetch(request);
        } catch (error) {
          const index = await cache.match(new URL("index.html", BASE));
          if (index) return index;
          throw error;
        }
      }
      return fetch(request);
    })(),
  );
});
