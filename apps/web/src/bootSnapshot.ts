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
// localStorage allows 5 MB per origin. Safari and Firefox count it as UTF-16,
// about 2.5M characters; Chromium and Electron allow 10 MB and store ASCII at
// a byte per character. Drafts keep image attachments there too, so the
// snapshot only takes room the rest of the app leaves free.
const ORIGIN_CHARACTER_BUDGET =
  typeof navigator !== "undefined" && /\bChrom(?:e|ium)\//.test(navigator.userAgent)
    ? 4_500_000
    : 2_000_000;
const RESERVED_FOR_OTHER_KEYS = 500_000;
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
 * JSON with DateTime and Duration support. Values the reader could not
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

function hasSingleKey(value: object): boolean {
  let count = 0;
  for (const _key in value) if (++count > 1) return false;
  return count === 1;
}

/**
 * Rebuilds DateTime and Duration values in place. A walk over the parsed
 * tree is several times faster than a JSON.parse reviver, which is called
 * for every primitive too.
 */
function revive(value: object): unknown {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const item: unknown = value[index];
      if (item !== null && typeof item === "object") value[index] = revive(item);
    }
    return value;
  }
  const record = value as Record<string, unknown>;
  const millis = record[DATE_MARKER];
  if (typeof millis === "number" && hasSingleKey(record)) return DateTime.makeUnsafe(millis);
  const duration = record[DURATION_MARKER];
  if (duration !== undefined && hasSingleKey(record)) return decodeDuration(duration) ?? value;
  for (const key in record) {
    const item = record[key];
    if (item !== null && typeof item === "object") record[key] = revive(item);
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
  const plain: unknown = JSON.parse(raw);
  const parsed = plain !== null && typeof plain === "object" ? revive(plain) : plain;
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

function loadStoredBootSnapshot(): BootSnapshot | null {
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

/**
 * Whether this page paints from the snapshot: a reload, which renders long
 * before the session and the cache could answer, or a desktop window, whose
 * backend may still be starting. A new browser tab loads the app graph for
 * long enough that the cache and the session are ready when it renders, so it
 * starts as it always has.
 */
function bootPaintApplies(): boolean {
  if (typeof window === "undefined") return false;
  if (window.desktopBridge !== undefined) return true;
  try {
    const navigation = performance.getEntriesByType("navigation")[0] as
      | PerformanceNavigationTiming
      | undefined;
    return navigation?.type === "reload";
  } catch {
    return false;
  }
}

let paintChecked = false;
let paintApplies = false;

/**
 * The snapshot this page paints its first screen from, read once. Null when
 * this boot does not paint from a snapshot, there is none, it came from
 * another build, or it was discarded.
 */
export function readBootSnapshot(): BootSnapshot | null {
  if (!paintChecked) {
    paintChecked = true;
    paintApplies = bootPaintApplies();
  }
  return paintApplies ? loadStoredBootSnapshot() : null;
}

/** The same-build cache can skip schema decoding on new tabs too, without enabling early paint. */
export function readBootCacheSnapshot(): BootSnapshot | null {
  return loadStoredBootSnapshot();
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
// Environments cleared during this page, which seeding must not bring back.
const forgotten = new Set<EnvironmentId>();

// Runs at the first write, in an idle moment, so reading the stored document
// never lands on the startup path.
function seedFromBootSnapshot() {
  if (seeded) return;
  seeded = true;
  const initial = loadStoredBootSnapshot();
  if (initial === null) return;
  catalog ??= initial.catalog;
  for (const [environmentId, snapshot] of initial.shells) {
    if (!shells.has(environmentId) && !forgotten.has(environmentId)) {
      shells.set(environmentId, snapshot);
    }
  }
  for (const [environmentId, config] of initial.serverConfigs) {
    if (!serverConfigs.has(environmentId) && !forgotten.has(environmentId)) {
      serverConfigs.set(environmentId, config);
    }
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

const OVER_BUDGET = Symbol("over budget");

/**
 * Live updates replace a few rows and reuse the rest, so each project and
 * thread row is encoded once and cached by identity. A shell longer than
 * `budget` characters returns OVER_BUDGET as soon as its rows pass it, so a
 * large environment neither builds nor encodes a document it cannot store.
 */
function encodeShell(
  snapshot: OrchestrationV2ShellSnapshot,
  budget: number,
): string | null | typeof OVER_BUDGET {
  const cached = encoded.get(snapshot);
  if (cached !== undefined) return cached !== null && cached.length > budget ? OVER_BUDGET : cached;
  const fields: string[] = [];
  let length = 2;
  let json: string | null = null;
  try {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const rows: string[] = [];
        length += key.length + 5;
        for (const row of value as ReadonlyArray<object>) {
          const encodedRow = encode(row);
          if (encodedRow === null) throw new UnsupportedBootValue(`row in ${key}`);
          length += encodedRow.length + 1;
          if (length > budget) return OVER_BUDGET;
          rows.push(encodedRow);
        }
        fields.push(`${JSON.stringify(key)}:[${rows.join(",")}]`);
      } else {
        const field = `${JSON.stringify(key)}:${JSON.stringify(value, replacer)}`;
        length += field.length + 1;
        if (length > budget) return OVER_BUDGET;
        fields.push(field);
      }
    }
    json = `{${fields.join(",")}}`;
  } catch {
    json = null;
  }
  encoded.set(snapshot, json);
  return json;
}

/** Characters every other localStorage key of this origin holds. */
function otherKeysLength(store: Storage): number {
  let total = 0;
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key === null || key === STORAGE_KEY) continue;
    total += key.length + (store.getItem(key)?.length ?? 0);
  }
  return total;
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
  let limit = ORIGIN_CHARACTER_BUDGET - RESERVED_FOR_OTHER_KEYS;
  try {
    limit -= otherKeysLength(store);
  } catch {
    limit = 0;
  }
  let budget = limit;
  const parts: string[] = [];
  for (const [environmentId, snapshot] of shells) {
    if (!known.has(environmentId)) continue;
    const json = encodeShell(snapshot, budget);
    if (json === OVER_BUDGET) {
      removeStoredBootSnapshot(store);
      return;
    }
    if (json === null) continue;
    parts.push(`${JSON.stringify(environmentId)}:${json}`);
    budget -= json.length;
  }
  const configParts: string[] = [];
  for (const [environmentId, config] of serverConfigs) {
    if (!known.has(environmentId)) continue;
    const json = encode(config);
    if (json !== null) configParts.push(`${JSON.stringify(environmentId)}:${json}`);
  }
  const serialized =
    `{"format":${FORMAT},"build":${JSON.stringify(BUILD_ID)},"savedAt":${Date.now()},` +
    `"catalog":${JSON.stringify(catalog)},"shells":{${parts.join(",")}},` +
    `"serverConfigs":{${configParts.join(",")}}}`;
  if (parts.length === 0 || serialized.length > limit) {
    removeStoredBootSnapshot(store);
    return;
  }
  try {
    store.setItem(STORAGE_KEY, serialized);
  } catch {
    // Quota or a disabled store: an older document must not outlive this one.
    removeStoredBootSnapshot(store);
  }
}

function removeStoredBootSnapshot(store: Storage) {
  try {
    store.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to clean up.
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
  // Shell saves are already throttled to one per 10 s; this only batches the
  // shell, config and catalog that change together, then waits for an idle
  // moment so the write never lands in the middle of startup work.
  if (flushTimer === null) {
    flushTimer = setTimeout(() => {
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(flush, { timeout: 5_000 });
      } else {
        flush();
      }
    }, 1_500);
  }
}

/** Called after the environment shell cache saved this snapshot. */
export function recordBootShell(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
): void {
  if (shells.get(environmentId) === snapshot) return;
  forgotten.delete(environmentId);
  shells.set(environmentId, snapshot);
  scheduleFlush();
}

/** Called after the server configuration cache saved this config. */
export function recordBootServerConfig(environmentId: EnvironmentId, config: ServerConfig): void {
  if (serverConfigs.get(environmentId) === config) return;
  forgotten.delete(environmentId);
  serverConfigs.set(environmentId, config);
  scheduleFlush();
}

/** The live connection catalog, so the next boot knows which environments to show. */
export function recordBootCatalog(entries: ReadonlyArray<BootCatalogEntry>): void {
  catalog = entries;
  scheduleFlush();
}

/** Called when an environment's cache is cleared. */
export function forgetBootEnvironment(environmentId: EnvironmentId): void {
  forgotten.add(environmentId);
  shells.delete(environmentId);
  serverConfigs.delete(environmentId);
  scheduleFlush();
}

/**
 * Drops the stored snapshot for good in this page, for example when the
 * server no longer accepts this browser's session.
 */
export function discardBootSnapshot(): void {
  discarded = true;
  bootSnapshot = null;
  loaded = true;
  paintChecked = true;
  paintApplies = false;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing else to clean up.
  }
}
