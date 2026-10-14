import type { EnvironmentId, OrchestrationV2ShellSnapshot, ServerConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";

// Mirrors the IndexedDB cache for first paint. Build-scoped because reads skip schema decoding.
const STORAGE_KEY = "t3code:boot-snapshot:v1";
const FORMAT = 1;
// Leave room for drafts' image data URLs, including on browsers that count storage as UTF-16.
const ORIGIN_CHARACTER_BUDGET =
  typeof navigator !== "undefined" && /\bChrom(?:e|ium)\//.test(navigator.userAgent)
    ? 4_500_000
    : 1_000_000;
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

// Reject values that cannot round-trip, rather than silently losing their types.
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

// Walking objects avoids JSON.parse reviver calls for every primitive.
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

// New tabs reach the session/cache before rendering; snapshots only help reloads and desktop.
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

export function readBootSnapshot(): BootSnapshot | null {
  if (!paintChecked) {
    paintChecked = true;
    paintApplies = bootPaintApplies();
  }
  return paintApplies ? loadStoredBootSnapshot() : null;
}

let catalog: ReadonlyArray<BootCatalogEntry> | null = null;
const shells = new Map<EnvironmentId, OrchestrationV2ShellSnapshot>();
const serverConfigs = new Map<EnvironmentId, ServerConfig>();
const encoded = new WeakMap<object, string | null>();
let seeded = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// What this page last stored, after savedAt, so an unchanged document is not rewritten.
let storedBody: string | null = null;
let listening = false;
let discarded = false;

// Environments cleared during this page, which seeding must not bring back.
const forgotten = new Set<EnvironmentId>();

// Seed at the first idle write to keep the localStorage read off the startup path.
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

// Cache unchanged rows by identity so live updates only encode the rows they replaced.
function encodeShell(snapshot: OrchestrationV2ShellSnapshot): string | null {
  const cached = encoded.get(snapshot);
  if (cached !== undefined) return cached;
  const fields: string[] = [];
  let json: string | null = null;
  try {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        const rows: string[] = [];
        for (const row of value as ReadonlyArray<object>) {
          const encodedRow = encode(row);
          if (encodedRow === null) throw new UnsupportedBootValue(`row in ${key}`);
          rows.push(encodedRow);
        }
        fields.push(`${JSON.stringify(key)}:[${rows.join(",")}]`);
      } else {
        fields.push(`${JSON.stringify(key)}:${JSON.stringify(value, replacer)}`);
      }
    }
    json = `{${fields.join(",")}}`;
  } catch {
    json = null;
  }
  encoded.set(snapshot, json);
  return json;
}

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
  const parts: string[] = [];
  for (const [environmentId, snapshot] of shells) {
    if (!known.has(environmentId)) continue;
    const json = encodeShell(snapshot);
    if (json !== null) parts.push(`${JSON.stringify(environmentId)}:${json}`);
  }
  const configParts: string[] = [];
  for (const [environmentId, config] of serverConfigs) {
    if (!known.has(environmentId)) continue;
    const json = encode(config);
    if (json !== null) configParts.push(`${JSON.stringify(environmentId)}:${json}`);
  }
  const head = `{"format":${FORMAT},"build":${JSON.stringify(BUILD_ID)},"savedAt":${Date.now()},`;
  const body =
    `"catalog":${JSON.stringify(catalog)},"shells":{${parts.join(",")}},` +
    `"serverConfigs":{${configParts.join(",")}}}`;
  try {
    if (
      parts.length === 0 ||
      otherKeysLength(store) + RESERVED_FOR_OTHER_KEYS + head.length + body.length >
        ORIGIN_CHARACTER_BUDGET
    ) {
      storedBody = null;
      store.removeItem(STORAGE_KEY);
      return;
    }
    if (body === storedBody) return;
    store.setItem(STORAGE_KEY, head + body);
    storedBody = body;
  } catch {
    // Quota or a disabled store: an older document must not outlive this one.
    storedBody = null;
    try {
      store.removeItem(STORAGE_KEY);
    } catch {}
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
  // Batch the already-throttled cache saves, then wait for idle time to avoid startup work.
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

export function recordBootShell(
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshot,
): void {
  if (shells.get(environmentId) === snapshot) return;
  forgotten.delete(environmentId);
  shells.set(environmentId, snapshot);
  scheduleFlush();
}

export function recordBootServerConfig(environmentId: EnvironmentId, config: ServerConfig): void {
  if (serverConfigs.get(environmentId) === config) return;
  forgotten.delete(environmentId);
  serverConfigs.set(environmentId, config);
  scheduleFlush();
}

export function recordBootCatalog(entries: ReadonlyArray<BootCatalogEntry>): void {
  catalog = entries;
  scheduleFlush();
}

export function forgetBootEnvironment(environmentId: EnvironmentId): void {
  forgotten.add(environmentId);
  shells.delete(environmentId);
  serverConfigs.delete(environmentId);
  // Re-pairing must not reuse the old environment's boot data.
  if (
    bootSnapshot !== null &&
    (bootSnapshot.shells.has(environmentId) || bootSnapshot.serverConfigs.has(environmentId))
  ) {
    const bootShells = new Map(bootSnapshot.shells);
    const bootServerConfigs = new Map(bootSnapshot.serverConfigs);
    bootShells.delete(environmentId);
    bootServerConfigs.delete(environmentId);
    bootSnapshot = { ...bootSnapshot, shells: bootShells, serverConfigs: bootServerConfigs };
  }
  scheduleFlush();
}

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
  } catch {}
}
