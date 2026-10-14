// Split chunks are fetched lazily, so a deploy (or desktop server swap)
// between page load and a later fetch can 404 the old hashed assets. One
// reload picks up the fresh index.html. sessionStorage remembers which
// failures already had their reload, so a chunk that keeps failing, even one
// every boot requests, reloads once and then surfaces. A later deploy fails a
// different asset and gets its own reload. The list is capped per build and
// restarts when the page's build changes, so a long-lived tab keeps reloading
// for each new deploy.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloads";
const MAX_CHUNK_RELOADS = 20;

/**
 * Called from the `vite:preloadError` listener with the page's build and a
 * key naming the asset that failed. Reloads at most once per key and returns
 * whether it did, so the caller knows whether to swallow the event or let
 * the error surface through the normal paths.
 */
export function reloadOnceForChunkLoadError(
  build: string,
  failure: string,
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  try {
    const storage = getStorage();
    const stored: unknown = JSON.parse(storage.getItem(CHUNK_RELOAD_GUARD_KEY) ?? "null");
    const reloaded =
      stored !== null &&
      typeof stored === "object" &&
      "build" in stored &&
      stored.build === build &&
      "failures" in stored &&
      Array.isArray(stored.failures)
        ? stored.failures
        : [];
    if (reloaded.includes(failure) || reloaded.length >= MAX_CHUNK_RELOADS) return false;
    storage.setItem(
      CHUNK_RELOAD_GUARD_KEY,
      JSON.stringify({ build, failures: [...reloaded, failure] }),
    );
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  reload();
  return true;
}

let speculativeLoads = 0;
const speculativeFailures = new WeakSet<object>();

/** Swallow speculative failures; real use must import again to retry and get a guarded reload. */
export function preloadSpeculatively<T>(load: () => Promise<T>): Promise<T | undefined> {
  speculativeLoads += 1;
  return new Promise<T>((resolve) => resolve(load())).then(
    (value) => {
      speculativeLoads -= 1;
      return value;
    },
    (error: unknown) => {
      if (typeof error === "object" && error !== null) speculativeFailures.add(error);
      speculativeLoads -= 1;
      return undefined;
    },
  );
}

// Rejections settle after vite:preloadError, so the listener must check ownership a task later.
export function isSpeculativeLoadPending(): boolean {
  return speculativeLoads > 0;
}

export function isSpeculativeLoadFailure(failure: unknown): boolean {
  return typeof failure === "object" && failure !== null && speculativeFailures.has(failure);
}

let routePreloads = 0;

// Route components retain chunk failures and reload on navigation; leave those failures to them.
export function preloadRouteSpeculatively<T>(load: () => Promise<T>): Promise<T> {
  routePreloads += 1;
  return new Promise<T>((resolve) => resolve(load())).finally(() => {
    routePreloads -= 1;
  });
}

export function isRoutePreloadPending(): boolean {
  return routePreloads > 0;
}
