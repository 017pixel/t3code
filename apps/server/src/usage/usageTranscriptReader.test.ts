// @effect-diagnostics nodeBuiltinImport:off - resume coverage writes, appends
// to, and truncates real transcript files byte-exactly, mirroring the reader's
// own deliberate node:fs usage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, assert, beforeEach, describe, it } from "@effect/vitest";
import { type EnvironmentId, USAGE_CONTRACT_VERSION, UsageSummary } from "@t3tools/contracts";
import type { TranscriptUsageFormat } from "@t3tools/provider-core/server/usage";
import { mergeUsage } from "@t3tools/shared/usageMerge";
import * as Schema from "effect/Schema";

import { TEST_FORMATS } from "./usageTestFormats.ts";
import {
  physicalSourceIdOf,
  readPhysicalSourceId,
  readTranscriptRecords,
  transcriptLineGate,
} from "./usageTranscriptReader.ts";

let dir: string;

beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-reader-test-"));
});

afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});

function claudeLine(id: number, outputTokens: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-01T10:00:00Z",
    requestId: `req_${id}`,
    sessionId: "session-1",
    message: {
      id: `msg_${id}`,
      model: "claude-fable-5",
      usage: { input_tokens: 10, output_tokens: outputTokens },
    },
  })}\n`;
}

function codexMetaLine(): string {
  return `${JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T10:00:00Z",
    payload: { type: "session_meta", id: "codex-session-1" },
  })}\n`;
}

function codexModelLine(model: string): string {
  return `${JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "turn_context", model },
  })}\n`;
}

function codexTierLine(serviceTier: string): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: "2026-08-01T10:00:01Z",
    payload: { type: "thread_settings_applied", thread_settings: { service_tier: serviceTier } },
  })}\n`;
}

function codexUsageLine(outputTokens: number, secondsOffset: number): string {
  return `${JSON.stringify({
    type: "event_msg",
    timestamp: `2026-08-01T10:00:${String(secondsOffset).padStart(2, "0")}Z`,
    payload: {
      type: "token_count",
      info: { last_token_usage: { input_tokens: 100, output_tokens: outputTokens } },
    },
  })}\n`;
}

describe("readTranscriptRecords resume", () => {
  it.each([
    { mode: "buffered", streamingThresholdBytes: Infinity },
    { mode: "streaming", streamingThresholdBytes: 0 },
  ])("counts malformed tails once across $mode reads and resume", async (options) => {
    const format: TranscriptUsageFormat<{ errors: number }> = {
      ...TEST_FORMATS.claude,
      selectFields: { ...TEST_FORMATS.claude.selectFields, usage: true },
      state: {
        initial: () => ({ errors: 0 }),
        schema: Schema.Struct({ errors: Schema.Number }),
      },
      parseLine(line, state) {
        return this.parseProjected(JSON.parse(line), state);
      },
      parseProjected(value, state) {
        if (
          typeof value === "object" &&
          value !== null &&
          "usage" in value &&
          value.usage === "malformed"
        ) {
          state.errors += 1;
          return [];
        }
        return TEST_FORMATS.claude.parseProjected(value, undefined);
      },
      readMalformedRecords: (state: { errors: number }) => state.errors,
    };
    const path = NodePath.join(dir, "diagnostics.jsonl");
    const malformed = JSON.stringify({ usage: "malformed" });
    // Completed lines enter the projected parser only when they cross a stream chunk.
    const committed = `${JSON.stringify({ usage: "malformed", padding: "x".repeat(256 * 1024) })}\n${claudeLine(1, 5)}`;
    await NodeFSP.writeFile(path, committed + malformed);

    const first = await readTranscriptRecords(path, format, undefined, options);
    assert.isNotNull(first);
    assert.deepStrictEqual(
      first.records.map((record) => record.totals.outputTokens),
      [5],
    );
    assert.deepStrictEqual(first.tailRecords, []);
    assert.strictEqual(first.position.resumeOffset, Buffer.byteLength(committed));
    assert.deepStrictEqual(first.position.state, { errors: 1 });
    assert.strictEqual(first.malformedRecords, 2);

    const savedPosition = JSON.parse(JSON.stringify(first.position));
    await NodeFSP.appendFile(path, `\n${claudeLine(2, 7)}${malformed}\n`);
    const resumed = await readTranscriptRecords(path, format, savedPosition, options);
    assert.isNotNull(resumed);
    assert.isTrue(resumed.resumed);
    assert.deepStrictEqual(
      resumed.records.map((record) => record.totals.outputTokens),
      [7],
    );
    assert.deepStrictEqual(resumed.position.state, { errors: 3 });
    assert.strictEqual(resumed.malformedRecords, 3);

    const full = await readTranscriptRecords(path, format, undefined, options);
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...resumed.records], full.records);
    assert.deepStrictEqual(resumed.tailRecords, full.tailRecords);
    assert.deepStrictEqual(resumed.position, full.position);
    assert.strictEqual(resumed.malformedRecords, full.malformedRecords);
  });

  it("parses only appended lines when resuming a grown file", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 2);
    assert.isFalse(first.resumed);
    assert.strictEqual(first.malformedRecords, 0);

    await NodeFSP.appendFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.totals.outputTokens, 11);

    const full = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(full);
    assert.deepStrictEqual([...first.records, ...second.records], [...full.records]);
  });

  it("carries the Codex reducer state across the resume boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexTierLine("ultrafast"),
    );
    const first = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 0);

    await NodeFSP.appendFile(path, codexUsageLine(9, 5));
    const second = await readTranscriptRecords(path, TEST_FORMATS.codex, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.strictEqual(second.records.length, 1);
    assert.strictEqual(second.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(second.records[0]?.speed, "ultrafast");
    assert.strictEqual(second.records[0]?.sessionId, "codex-session-1");
  });

  it("suppresses a Codex duplicate usage event that straddles the boundary", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    await NodeFSP.writeFile(
      path,
      codexMetaLine() + codexModelLine("gpt-5.2-codex") + codexUsageLine(9, 5),
    );
    const first = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);

    // Codex re-emits an unchanged token_count on stream boundaries; the copy
    // lands after the resume point and must still be dropped.
    await NodeFSP.appendFile(path, codexUsageLine(9, 5) + codexUsageLine(21, 8));
    const second = await readTranscriptRecords(path, TEST_FORMATS.codex, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [21],
    );
  });

  it("defers an unterminated trailing line to tailRecords, then consumes it once terminated", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    const unterminated = claudeLine(2, 7).trimEnd();
    await NodeFSP.writeFile(path, claudeLine(1, 5) + unterminated);
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);
    assert.strictEqual(first.records.length, 1);
    assert.strictEqual(first.tailRecords.length, 1);
    assert.strictEqual(first.tailRecords[0]?.totals.outputTokens, 7);

    await NodeFSP.appendFile(path, `\n${claudeLine(3, 11)}`);
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isTrue(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [7, 11],
    );
    assert.strictEqual(second.tailRecords.length, 0);
  });

  it("re-parses from the start when the guard bytes no longer match", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5));
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);

    await NodeFSP.writeFile(path, claudeLine(4, 13) + claudeLine(5, 17));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [13, 17],
    );
  });

  it("re-parses from the start when the file shrank below the resume point", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    await NodeFSP.writeFile(path, claudeLine(1, 5) + claudeLine(2, 7));
    const first = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(first);

    await NodeFSP.writeFile(path, claudeLine(3, 11));
    const second = await readTranscriptRecords(path, TEST_FORMATS.claude, first.position);
    assert.isNotNull(second);
    assert.isFalse(second.resumed);
    assert.deepStrictEqual(
      second.records.map((record) => record.totals.outputTokens),
      [11],
    );
  });

  it("parses a line larger than one stream chunk", async () => {
    const path = NodePath.join(dir, "claude.jsonl");
    const bigLine = `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-01T10:00:00Z",
      requestId: "req_big",
      sessionId: "session-1",
      padding: "x".repeat(512 * 1024),
      message: {
        id: "msg_big",
        model: "claude-fable-5",
        usage: { input_tokens: 10, output_tokens: 42 },
      },
    })}\n`;
    await NodeFSP.writeFile(path, bigLine + claudeLine(2, 7));

    const parsed = await readTranscriptRecords(path, TEST_FORMATS.claude);
    assert.isNotNull(parsed);
    assert.deepStrictEqual(
      parsed.records.map((record) => record.totals.outputTokens),
      [42, 7],
    );
  });

  it("keeps a CRLF Codex reducer line whose marker straddles a stream chunk", async () => {
    const path = NodePath.join(dir, "rollout.jsonl");
    const crlf = (line: string) => line.replace("\n", "\r\n");
    const modelLine = crlf(codexModelLine("gpt-5.2-codex"));
    const head = crlf(codexMetaLine());
    const fillerBytes =
      256 * 1024 - Buffer.byteLength(head) - modelLine.indexOf("turn_context") - 4;
    const fillerEnvelope = crlf(`${JSON.stringify({ type: "response_item", output: "" })}\n`);
    const padding = "é".repeat((fillerBytes - Buffer.byteLength(fillerEnvelope)) / 2);
    const filler = crlf(`${JSON.stringify({ type: "response_item", output: padding })}\n`);
    const content = head + filler + modelLine + crlf(codexUsageLine(40, 2));
    await NodeFSP.writeFile(path, content);

    const result = await readTranscriptRecords(path, TEST_FORMATS.codex);
    assert.isNotNull(result);
    assert.strictEqual(result.records.length, 1);
    assert.strictEqual(result.records[0]?.model, "gpt-5.2-codex");
    assert.strictEqual(result.records[0]?.sessionId, "codex-session-1");
    assert.strictEqual(result.position.resumeOffset, Buffer.byteLength(content));
  });
});

describe("transcriptLineGate", () => {
  const gates = {
    one: transcriptLineGate(['"usage"']),
    several: transcriptLineGate(['"token_count"', '"session_meta"', '"a.b(c)"']),
  };
  const markers = { one: ['"usage"'], several: ['"token_count"', '"session_meta"', '"a.b(c)"'] };

  it("matches markers beside multi-byte and malformed UTF-8", () => {
    const invalid = Buffer.from([0xff, 0xc3]);
    for (const kind of ["one", "several"] as const) {
      for (const marker of markers[kind]) {
        assert.isTrue(gates[kind](Buffer.from(`{"text":"日本語 é",${marker}:1}`)));
        assert.isTrue(gates[kind](Buffer.concat([invalid, Buffer.from(marker), invalid])));
        assert.isFalse(gates[kind](Buffer.from(`{"text":"日本語 é ${marker.slice(1, -1)}"}`)));
      }
    }
  });
});

describe("readPhysicalSourceId", () => {
  const scope = "0123456789abcdef0123456789abcdef";
  const windowsPath = "C:\\Users\\User\\.claude\\projects";

  // One NTFS directory the Windows server reads natively and the WSL server
  // through drvfs. The temp dir stands in for the drive's mount point.
  async function drvfsFixture(extraMounts = "") {
    const mountPoint = NodePath.join(dir, "drive c");
    await NodeFSP.mkdir(NodePath.join(mountPoint, "Users", "User", ".claude", "projects"), {
      recursive: true,
    });
    const escaped = mountPoint.replaceAll(" ", "\\040");
    const mountInfoPath = NodePath.join(dir, "mountinfo");
    await NodeFSP.writeFile(
      mountInfoPath,
      [
        "24 1 8:32 / / rw,relatime shared:1 - ext4 /dev/sdc rw,discard",
        `81 24 0:61 / ${escaped} rw,noatime shared:2 - 9p C:\\134 rw,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd`,
        extraMounts,
      ].join("\n"),
    );
    return { mountPoint, mountInfoPath };
  }

  function summaryFor(resolvedHomePath: string, volumeId: string, physicalSourceId?: string) {
    return Schema.decodeUnknownSync(UsageSummary)({
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: "2026-10-22T02:00:00.000Z",
      timeZone: "UTC",
      sinceDay: "2026-10-21",
      untilDay: "2026-10-21",
      sources: [
        {
          fingerprint: {
            hostId: "MainPC",
            provider: "claude",
            resolvedHomePath,
            volumeId,
            ...(physicalSourceId === undefined ? {} : { physicalSourceId }),
          },
          status: "ok",
          scannedFiles: 1,
          skippedFiles: 0,
          malformedRecords: 0,
          distinctSessions: 142,
          message: null,
        },
      ],
      buckets: [],
      pricing: { status: "unavailable", source: "fixture", fetchedAt: null, knownModels: 0 },
      scanDurationMs: 0,
    });
  }

  it("names a drvfs directory as the Windows server names it, whatever its typed case", async () => {
    const { mountPoint, mountInfoPath } = await drvfsFixture();
    const wslId = await readPhysicalSourceId(
      `${mountPoint}/users/user/.claude/projects`,
      scope,
      "linux",
      mountInfoPath,
    );
    assert.strictEqual(wslId, physicalSourceIdOf(scope, windowsPath));

    const merged = mergeUsage(
      [
        {
          environmentId: "windows" as EnvironmentId,
          label: "Windows",
          summary: summaryFor(
            windowsPath,
            "1280555009:3659174697951285",
            physicalSourceIdOf(scope, windowsPath),
          ),
        },
        {
          environmentId: "wsl" as EnvironmentId,
          label: "WSL",
          summary: summaryFor(
            `${mountPoint}/users/user/.claude/projects`,
            "112:3659174697951287",
            wslId,
          ),
        },
      ],
      USAGE_CONTRACT_VERSION,
    );
    assert.strictEqual(merged.sessions, 142);
  });

  it("gives no identity to native or shadowing Linux mounts, or without a desktop scope", async () => {
    const { mountPoint, mountInfoPath } = await drvfsFixture(
      `90 81 8:48 / ${mountPoint.replaceAll(" ", "\\040")}/Users rw,relatime - ext4 /dev/sdd rw`,
    );
    const projects = `${mountPoint}/Users/User/.claude/projects`;
    assert.isUndefined(await readPhysicalSourceId(projects, scope, "linux", mountInfoPath));
    assert.isUndefined(await readPhysicalSourceId(dir, scope, "linux", mountInfoPath));
    assert.isUndefined(await readPhysicalSourceId(projects, undefined, "linux", mountInfoPath));
    assert.notStrictEqual(
      physicalSourceIdOf("fedcba9876543210fedcba9876543210", windowsPath),
      physicalSourceIdOf(scope, windowsPath),
    );
  });
});
