// @effect-diagnostics nodeBuiltinImport:off
/**
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and buffer-level streaming is roughly an order of
 * magnitude cheaper than materialising each file.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

import type {
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * The guard hash fingerprints the bytes immediately before `resumeOffset`. A
 * resume only proceeds when those bytes still match: transcripts are
 * append-only by design, but a rotated or rewritten file silently mis-parsed
 * from the middle would corrupt usage totals.
 */
export interface TranscriptParsePosition {
  readonly resumeOffset: number;
  readonly guardLength: number;
  readonly guardHash: number;
  readonly state: unknown;
}

export interface TranscriptParseResult {
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer has not newline-terminated yet.
   * Kept out of `records` because `position` deliberately excludes that
   * segment: the next scan re-reads it once the writer finishes the line.
   */
  readonly tailRecords: readonly UsageRecord[];
  /** Includes tentative tail diagnostics; position.state only includes committed lines. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
  readonly resumed: boolean;
}

export const GUARD_LENGTH = 64;
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
const STAT_CONCURRENCY = 32;
const CARRIAGE_RETURN = 0x0d;

function selectUsageFields(fields: SelectedFields) {
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      if (typeof key !== "string" || !Object.hasOwn(selected, key)) return false;
      selected = selected[key]!;
    }
    return true;
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 * Results keep `readdir` order, which the aggregator's first-seen dedupe relies
 * on.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string },
): Promise<{ readonly files: readonly TranscriptFile[]; readonly failedPaths: number }> {
  const fileName = options?.fileName;
  const candidates: string[] = [];
  let failedPaths = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (fileName !== undefined ? entry.name === fileName : entry.name.endsWith(".jsonl")) {
        candidates.push(child);
      }
    }
  };
  await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        if (stats.mtimeMs >= sinceMs) {
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths };
}

export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/**
 * Set by the desktop app, from a value it persists, on its Windows server and
 * the WSL server it manages, so both can name one Windows directory alike
 * without merging separate machines that share a hostname and path.
 */
export const DESKTOP_HOST_SCOPE_ENV = "T3CODE_DESKTOP_HOST_SCOPE";

const MOUNT_FIELD_ESCAPE = /\\([0-7]{3})/g;
const WINDOWS_ROOT = /^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)\\?$/;

const unescapeMountField = (field: string) =>
  field.replace(MOUNT_FIELD_ESCAPE, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );

const normalizeWindowsPath = (path: string) =>
  (/^[a-z]:/.test(path) ? path[0]!.toUpperCase() + path.slice(1) : path).replace(/\\$/, "");

/**
 * The Windows directory behind the deepest mount holding `dir`, read from
 * `/proc/self/mountinfo` so a custom automount root resolves and an ext4
 * mount under `/mnt` never passes for a drive.
 */
function windowsMountFor(
  mountInfo: string,
  dir: string,
): { readonly mountPoint: string; readonly windowsRoot: string } | undefined {
  let deepest: { mountPoint: string; windowsRoot: string | undefined } | undefined;
  for (const line of mountInfo.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-", 6);
    if (separator === -1) continue;
    const mountPoint = unescapeMountField(fields[4] ?? "");
    const contains =
      mountPoint === "/" ||
      dir === mountPoint ||
      dir.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`);
    if (!contains || (deepest !== undefined && deepest.mountPoint.length > mountPoint.length)) {
      continue;
    }
    // WSL2 mounts drives over 9p with `aname=drvfs;path=C:\`; WSL1 as `drvfs`.
    const options = (fields[separator + 3] ?? "").split(/[,;]/);
    const source = options.includes("aname=drvfs")
      ? options.find((option) => option.startsWith("path="))?.slice("path=".length)
      : fields[separator + 1] === "drvfs"
        ? unescapeMountField(fields[separator + 2] ?? "")
        : undefined;
    const root = unescapeMountField(fields[3] ?? "/")
      .split("/")
      .filter(Boolean);
    deepest = {
      mountPoint,
      windowsRoot:
        source !== undefined && WINDOWS_ROOT.test(source)
          ? [normalizeWindowsPath(source), ...root].join("\\")
          : undefined,
    };
  }
  return deepest?.windowsRoot === undefined
    ? undefined
    : { mountPoint: deepest.mountPoint, windowsRoot: deepest.windowsRoot };
}

/**
 * drvfs keeps the casing a path was typed with, while Windows reports the
 * on-disk names. Read those names rather than folding case, which would join
 * distinct entries of a case-sensitive directory.
 */
async function onDiskNames(
  mountPoint: string,
  parts: readonly string[],
): Promise<string[] | undefined> {
  const names: string[] = [];
  let current = mountPoint;
  for (const part of parts) {
    let entries: string[];
    try {
      entries = await NodeFSP.readdir(current);
    } catch {
      return undefined;
    }
    const folded = part.toUpperCase();
    const [name, ...others] = entries.includes(part)
      ? [part]
      : entries.filter((entry) => entry.toUpperCase() === folded);
    if (name === undefined || others.length > 0) return undefined;
    names.push(name);
    current = NodePath.posix.join(current, name);
  }
  return names;
}

export function physicalSourceIdOf(scope: string, windowsPath: string): string {
  return NodeCrypto.createHash("sha256")
    .update(`${scope}\0${windowsPath}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Identifies a Windows directory the same way from the Windows server and from
 * a WSL server reading it through drvfs. Directories that are not Windows
 * backed, and servers the desktop app did not start, get none.
 */
export async function readPhysicalSourceId(
  dir: string,
  scope: string | undefined,
  platform: NodeJS.Platform,
  mountInfoPath = "/proc/self/mountinfo",
): Promise<string | undefined> {
  if (scope === undefined || scope.length === 0) return undefined;
  try {
    if (platform === "win32") {
      // The native realpath reports on-disk casing; the JS one keeps the input's.
      return physicalSourceIdOf(scope, normalizeWindowsPath(await NodeFSP.realpath(dir)));
    }
    if (platform !== "linux") return undefined;
    const mount = windowsMountFor(await NodeFSP.readFile(mountInfoPath, "utf8"), dir);
    if (mount === undefined) return undefined;
    const names = await onDiskNames(
      mount.mountPoint,
      dir.slice(mount.mountPoint.length).split("/").filter(Boolean),
    );
    return names === undefined
      ? undefined
      : physicalSourceIdOf(scope, [mount.windowsRoot, ...names].join("\\"));
  } catch {
    return undefined;
  }
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

/**
 * Several would be one pass over the line each, so they are matched together as
 * one alternation over the line's latin1 view instead: latin1 maps every byte
 * to one character without validating it, so an ASCII marker matches exactly
 * where its bytes do.
 */
export function transcriptLineGate(markers: readonly [string, ...string[]]) {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line: Buffer) => line.includes(marker);
  }
  const pattern = new RegExp(
    markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  return (line: Buffer) => pattern.test(line.toString("latin1"));
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 */
export async function readTranscriptRecords<State>(
  filePath: string,
  format: TranscriptUsageFormat<State>,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number },
): Promise<TranscriptParseResult | null> {
  const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    const codec = format.state;
    const decodeState = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
    const encodeState = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
    let state = codec === undefined ? (undefined as State) : codec.initial();
    let resumed = false;
    let start = 0;
    const savedState =
      resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
        ? Option.none()
        : decodeState(resumeFrom.state);
    if (
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (codec === undefined || Option.isSome(savedState)) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (Option.isSome(savedState)) state = savedState.value;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    const mightCarryUsage = transcriptLineGate(format.usageMarkers);
    const parseLine = (lineBuffer: Buffer, lineState: State, out: UsageRecord[]): void => {
      if (!mightCarryUsage(lineBuffer)) return;
      for (const record of format.parseLine(toLineString(lineBuffer), lineState)) out.push(record);
    };

    const records: UsageRecord[] = [];
    let resumeOffset = start;
    let scanOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let streaming: ReturnType<typeof createTranscriptJsonReader> | undefined;
    let decoder: NodeStringDecoder.StringDecoder | undefined;
    const selectPath = selectUsageFields(format.selectFields);

    const append = (segment: Buffer) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0) pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        // Usage has no import-history budget: retain all selected usage fields,
        // regardless of the size of the surrounding unselected tool content.
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity });
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (const pending of pendingChunks) streaming.write(decoder.write(pending));
        pendingChunks = [];
        pendingBytes = 0;
      }
      streaming.write(decoder!.write(segment));
    };
    const finish = (lineState: State, out: UsageRecord[]) => {
      if (streaming) {
        streaming.write(decoder!.end());
        const projected = streaming.finish();
        for (const record of format.parseProjected(projected, lineState)) out.push(record);
      } else if (pendingBytes > 0) {
        const line =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(line, lineState, out);
      }
      pendingChunks = [];
      pendingBytes = 0;
      streaming = undefined;
      decoder = undefined;
    };
    const stream = handle.createReadStream({
      start,
      autoClose: false,
      highWaterMark: 256 * 1024,
    }) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          append(chunk.subarray(lineStart));
          break;
        }
        if (!streaming && pendingBytes === 0) {
          parseLine(chunk.subarray(lineStart, newlineIndex), state, records);
        } else {
          append(chunk.subarray(lineStart, newlineIndex));
          finish(state, records);
        }
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }

    // The unfinished tail parses against a copy, so the saved state stays at
    // `resumeOffset` and the next scan replays the tail from it.
    const encodedState = encodeState === undefined ? null : encodeState(state);
    const tailRecords: UsageRecord[] = [];
    const tailState =
      decodeState === undefined ? state : Option.getOrThrow(decodeState(encodedState));
    finish(tailState, tailRecords);

    const guardLength = Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      records,
      tailRecords,
      malformedRecords: format.readMalformedRecords?.(tailState) ?? 0,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        state: encodedState,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
