// Split chunks are fetched lazily, so a deploy (or desktop server swap) between
// page load and a later fetch can 404 the old hashed assets. One reload picks
// up the fresh index.html.
const CHUNK_RELOAD_GUARD_KEY = "t3code:chunk-load-reloaded";
const CHUNK_RELOAD_COOLDOWN_MS = 30_000;

export function reloadOnceForChunkLoadError(
  getStorage: () => Storage = () => window.sessionStorage,
  reload: () => void = () => window.location.reload(),
): boolean {
  let alreadyReloaded: boolean;
  try {
    const storage = getStorage();
    const now = Date.now();
    const elapsed = now - Number(storage.getItem(CHUNK_RELOAD_GUARD_KEY));
    alreadyReloaded = elapsed >= 0 && elapsed < CHUNK_RELOAD_COOLDOWN_MS;
    if (!alreadyReloaded) storage.setItem(CHUNK_RELOAD_GUARD_KEY, String(now));
  } catch {
    // Without storage the guard cannot survive a reload, so a persistent
    // failure would loop forever. Let the error surface instead.
    return false;
  }
  if (alreadyReloaded) return false;
  reload();
  return true;
}

export function clearChunkReloadGuard(getStorage: () => Storage = () => window.sessionStorage) {
  try {
    getStorage().removeItem(CHUNK_RELOAD_GUARD_KEY);
  } catch {}
}

let chunkLoadFailed = false;
let reloadScheduled = false;

export function recoverChunkLoadError(): boolean {
  if (reloadScheduled) return false;
  chunkLoadFailed = true;
  reloadScheduled = reloadOnceForChunkLoadError();
  return reloadScheduled;
}

export function isChunkReloadScheduled(): boolean {
  return reloadScheduled;
}

export function clearChunkReloadGuardAfterStartup(): void {
  if (chunkLoadFailed) return;
  try {
    // Restored lazy surfaces can fail after a healthy boot; keep recent recovery.
    const elapsed = Date.now() - Number(window.sessionStorage.getItem(CHUNK_RELOAD_GUARD_KEY));
    if (!(elapsed >= 0 && elapsed < CHUNK_RELOAD_COOLDOWN_MS)) clearChunkReloadGuard();
  } catch {}
}

export async function loadOnDemand<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    // Hover and real use can share the same rejected import and error object.
    recoverChunkLoadError();
    throw error;
  }
}

let speculativeLoads = 0;
const speculativeFailures = new WeakSet<object>();

// A failed hover preload must not trigger stale-chunk recovery.
export async function preloadSpeculatively<T>(load: () => Promise<T>): Promise<T | undefined> {
  speculativeLoads += 1;
  try {
    return await load();
  } catch (error) {
    if (typeof error === "object" && error !== null) speculativeFailures.add(error);
    return undefined;
  } finally {
    speculativeLoads -= 1;
  }
}

export function isSpeculativeLoadPending(): boolean {
  return speculativeLoads > 0;
}

export function isSpeculativeLoadFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && speculativeFailures.has(error);
}
