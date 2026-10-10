import type { EnvironmentId, OrchestrationV2ShellSnapshot, ServerConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

/**
 * The first screen's data, kept in localStorage so the first React commit can
 * paint the real sidebar and composer before the auth check, the connection
 * runtime, IndexedDB or the server answer anything.
 *
 * It mirrors the IndexedDB environment cache (connection/storage.ts writes
 * both), so it is never more authoritative than that cache: consumers present
 * it as cached data and the live connection replaces it. A document written by
 * another build is ignored, because the stored values skip schema decoding.
 */

const STORAGE_KEY = "t3code:boot-snapshot:v1";
const FORMAT = 1;
// localStorage holds about 5M characters per origin and drafts share it.
const MAX_DOCUMENT_LENGTH = 2_500_000;
const DATE_MARKER = "$t3date";
const DURATION_MARKER = "$t3duration";

export type BootCatalogEntryKind = "primary" | "bearer" | "relay" | "ssh";

export interface BootCatalogEntry {
  readonly environmentId: EnvironmentId;
  readonly kind: BootCatalogEntryKind;
  readonly label: string;
  readonly enabled: boolean;
  readonly connectionId?: string;
  readonly httpBaseUrl?: string;
  readonly wsBaseUrl?: string;
}

export interface BootSnapshot {
  readonly savedAt: number;
  readonly catalog: ReadonlyArray<BootCatalogEntry>;
  readonly shells: ReadonlyMap<EnvironmentId, OrchestrationV2ShellSnapshot>;
  readonly serverConfigs: ReadonlyMap<EnvironmentId, ServerConfig>;
}

// The hashed chunk URL changes with every build that could change these types.
const BUILD_ID = (() => {
  try {
    return new URL(import.meta.url).pathname;
  } catch {
    return "unknown";
  }
})();

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

class UnsupportedBootValue extends Error {}

function encodeDuration(duration: Duration.Duration): number | string {
  const value = duration.value;
  switch (value._tag) {
    case "Millis":
      return value.millis;
    case "Nanos":
      return `${value.nanos}n`;
    case "Infinity":
      return "Infinity";
    default:
      return "-Infinity";
  }
}

function decodeDuration(encoded: unknown): Duration.Duration | null {
  if (typeof encoded === "number") return Duration.millis(encoded);
  if (encoded === "Infinity") return Duration.infinity;
  if (encoded === "-Infinity") return Duration.negativeInfinity;
  if (typeof encoded === "string" && /^-?\d+n$/.test(encoded)) {
    return Duration.nanos(BigInt(encoded.slice(0, -1)));
  }
  return null;
}

/**
 * JSON with DateTime and Duration support. Values the reviver could not
 * rebuild exactly (class instances, Options, bigints) abort the write instead
 * of coming back as plain objects.
 */
function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
  const raw = this[key];
  if (typeof raw === "object" && raw !== null) {
    if (DateTime.isDateTime(raw)) {
      if (!DateTime.isUtc(raw)) throw new UnsupportedBootValue("zoned DateTime");
      return { [DATE_MARKER]: DateTime.toEpochMillis(raw) };
    }
    if (Duration.isDuration(raw)) return { [DURATION_MARKER]: encodeDuration(raw) };
    const prototype = Object.getPrototypeOf(raw);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new UnsupportedBootValue(`unsupported object at ${key}`);
    }
    return value;
  }
  if (typeof raw === "bigint" || typeof raw === "symbol" || typeof raw === "function") {
    throw new UnsupportedBootValue(`unsupported ${typeof raw} at ${key}`);
  }
  if (typeof raw === "number" && !Number.isFinite(raw)) {
    throw new UnsupportedBootValue(`non-finite number at ${key}`);
  }
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  if (DATE_MARKER in value) {
    const millis = (value as Record<string, unknown>)[DATE_MARKER];
    if (typeof millis === "number" && Object.keys(value).length === 1) {
      return DateTime.makeUnsafe(millis);
    }
  } else if (DURATION_MARKER in value && Object.keys(value).length === 1) {
    return decodeDuration((value as Record<string, unknown>)[DURATION_MARKER]) ?? value;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isShellSnapshot(value: unknown): value is OrchestrationV2ShellSnapshot {
  return (
    isRecord(value) &&
    typeof value.snapshotSequence === "number" &&
    Array.isArray(value.threads) &&
    Array.isArray(value.archivedThreads) &&
    Array.isArray(value.projects)
  );
}

function isServerConfig(value: unknown): value is ServerConfig {
  return (
    isRecord(value) &&
    isRecord(value.environment) &&
    typeof value.environment.environmentId === "string" &&
    Array.isArray(value.providers) &&
    isRecord(value.settings)
  );
}

function isCatalogEntry(value: unknown): value is BootCatalogEntry {
  return (
    isRecord(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.enabled === "boolean" &&
    (value.kind === "primary" ||
      value.kind === "bearer" ||
      value.kind === "relay" ||
      value.kind === "ssh")
  );
}

function parseDocument(raw: string): BootSnapshot | null {
  const parsed: unknown = JSON.parse(raw, reviver);
  if (
    !isRecord(parsed) ||
    parsed.format !== FORMAT ||
    parsed.build !== BUILD_ID ||
    typeof parsed.savedAt !== "number" ||
    !Array.isArray(parsed.catalog) ||
    !isRecord(parsed.shells) ||
    !isRecord(parsed.serverConfigs)
  ) {
    return null;
  }
  const catalog = parsed.catalog.filter(isCatalogEntry);
  const known = new Set(catalog.map((entry) => entry.environmentId));
  const shells = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
  for (const [environmentId, snapshot] of Object.entries(parsed.shells)) {
    if (known.has(environmentId as EnvironmentId) && isShellSnapshot(snapshot)) {
      shells.set(environmentId as EnvironmentId, snapshot);
    }
  }
  const serverConfigs = new Map<EnvironmentId, ServerConfig>();
  for (const [environmentId, config] of Object.entries(parsed.serverConfigs)) {
    if (
      known.has(environmentId as EnvironmentId) &&
      isServerConfig(config) &&
      config.environment.environmentId === environmentId
    ) {
      serverConfigs.set(environmentId as EnvironmentId, config);
    }
  }
  return { savedAt: parsed.savedAt, catalog, shells, serverConfigs };
}

let loaded = false;
let bootSnapshot: BootSnapshot | null = null;

/**
 * The snapshot this page booted with, read once. Null when there is none, it
 * came from another build, or it was discarded.
 */
export function readBootSnapshot(): BootSnapshot | null {
  if (loaded) return bootSnapshot;
  loaded = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY) ?? null;
    bootSnapshot = raw === null ? null : parseDocument(raw);
  } catch {
    bootSnapshot = null;
  }
  return bootSnapshot;
}

// ── Writing ────────────────────────────────────────────────────────────────

let catalog: ReadonlyArray<BootCatalogEntry> | null = null;
const shells = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
const serverConfigs = new Map<EnvironmentId, ServerConfig>();
const encoded = new WeakMap<object, string | null>();
let seeded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let listening = false;
let discarded = false;

// The first write keeps the values this page booted with for environments the
// live data has not written yet.
function seedFromBootSnapshot() {
  if (seeded) return;
  seeded = true;
  const initial = readBootSnapshot();
  if (initial === null) return;
  catalog ??= initial.catalog;
  for (const [environmentId, snapshot] of initial.shells) {
    if (!shells.has(environmentId)) shells.set(environmentId, snapshot);
  }
  for (const [environmentId, config] of initial.serverConfigs) {
    if (!serverConfigs.has(environmentId)) serverConfigs.set(environmentId, config);
  }
}

function encode(value: object): string | null {
  const cached = encoded.get(value);
  if (cached !== undefined) return cached;
  let json: string | null;
  try {
    json = JSON.stringify(value, replacer);
  } catch {
    json = null;
  }
  encoded.set(value, json);
  return json;
}

function flush() {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (discarded) return;
  seedFromBootSnapshot();
  const store = storage();
  if (store === null || catalog === null) return;
  const known = new Set(
    catalog.filter((entry) => entry.enabled).map((entry) => entry.environmentId),
  );
  const parts: string[] = [];
  for (const [environmentId, snapshot] of shells) {
    if (!known.has(environmentId)) continue;
    const json = encode(snapshot);
    if (json !== null) parts.push(`${JSON.stringify(environmentId)}:${json}`);
  }
  const configParts: string[] = [];
  for (const [environmentId, config] of serverConfigs) {
    if (!known.has(environmentId)) continue;
    const json = encode(config);
    if (json !== null) configParts.push(`${JSON.stringify(environmentId)}:${json}`);
  }
  const document =
    `{"format":${FORMAT},"build":${JSON.stringify(BUILD_ID)},"savedAt":${Date.now()},` +
    `"catalog":${JSON.stringify(catalog)},"shells":{${parts.join(",")}},` +
    `"serverConfigs":{${configParts.join(",")}}}`;
  try {
    if (parts.length === 0 || document.length > MAX_DOCUMENT_LENGTH) {
      store.removeItem(STORAGE_KEY);
      return;
    }
    store.setItem(STORAGE_KEY, document);
  } catch {
    // Quota or a disabled store: an older document must not outlive this one.
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      // Nothing else to clean up.
    }
  }
}

function scheduleFlush() {
  if (typeof window === "undefined" || discarded) return;
  if (!listening) {
    listening = true;
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flush();
    });
  }
  if (flushTimer === null) flushTimer = setTimeout(flush, 1_500);
}

/** Called after the environment shell cache saved this snapshot. */
export function recordBootShell(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
): void {
  if (shells.get(environmentId) === snapshot) return;
  seedFromBootSnapshot();
  shells.set(environmentId, snapshot);
  scheduleFlush();
}

/** Called after the server configuration cache saved this config. */
export function recordBootServerConfig(environmentId: EnvironmentId, config: ServerConfig): void {
  if (serverConfigs.get(environmentId) === config) return;
  seedFromBootSnapshot();
  serverConfigs.set(environmentId, config);
  scheduleFlush();
}

/** The live connection catalog, so the next boot knows which environments to show. */
export function recordBootCatalog(entries: ReadonlyArray<BootCatalogEntry>): void {
  seedFromBootSnapshot();
  catalog = entries;
  scheduleFlush();
}

/** Called when an environment's cache is cleared. */
export function forgetBootEnvironment(environmentId: EnvironmentId): void {
  seedFromBootSnapshot();
  const removedShell = shells.delete(environmentId);
  const removedConfig = serverConfigs.delete(environmentId);
  if (removedShell || removedConfig) scheduleFlush();
}

/**
 * Drops the stored snapshot for good in this page, for example when the
 * server no longer accepts this browser's session.
 */
export function discardBootSnapshot(): void {
  discarded = true;
  bootSnapshot = null;
  loaded = true;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to clean up.
  }
}
