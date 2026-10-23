import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
} from "./orchestrationCache.ts";
import {
  COMPACT_THREAD_CACHE_SCHEMA_VERSION,
  decodeStoredThreadSnapshot,
  encodeStoredThreadSnapshot,
} from "./threadCacheEncoding.ts";
import { v2Now, v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";

const encodeLegacy = Schema.encodeSync(Schema.fromJsonString(StoredOrchestrationThreadSnapshot));
const decodeLegacy = Schema.decodeUnknownSync(
  Schema.fromJsonString(StoredOrchestrationThreadSnapshot),
);

function fixture() {
  const item = {
    id: TurnItemId.make("local-cache-item"),
    threadId: v2ThreadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 12,
    status: "completed" as const,
    title: null,
    startedAt: v2Now,
    completedAt: v2Now,
    updatedAt: v2Now,
    type: "system_notice" as const,
    message: "Keep the complete notice.",
  };
  const hidden = { ...item, id: TurnItemId.make("hidden-cache-item"), ordinal: 13 };
  const inherited = {
    ...item,
    id: TurnItemId.make("parent-cache-item"),
    threadId: ThreadId.make("parent-thread"),
  };
  return {
    schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
    environmentId: EnvironmentId.make("cache-environment"),
    threadId: v2ThreadId,
    snapshot: {
      snapshotSequence: 42,
      historyCursor: "older-activity",
      hasMoreHistory: true,
      latestLocalTurnOrdinal: hidden.ordinal,
      projection: {
        ...v2Projection,
        turnItems: [item, hidden],
        visibleTurnItems: [
          {
            position: 0,
            visibility: "inherited" as const,
            sourceThreadId: inherited.threadId,
            sourceItemId: inherited.id,
            item: inherited,
          },
          {
            position: 1,
            visibility: "local" as const,
            sourceThreadId: v2ThreadId,
            sourceItemId: item.id,
            item,
          },
        ],
      },
    },
  };
}

describe("compact thread cache encoding", () => {
  it.effect(
    "restores local identity, order, hidden items, inherited rows, dates, and paging metadata",
    () =>
      Effect.gen(function* () {
        const stored = fixture();
        const raw = yield* encodeStoredThreadSnapshot(stored);
        const encoded = JSON.parse(raw);
        expect(encoded.schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
        expect(encoded.snapshot.turnItemsOmitLocalVisible).toBe(true);
        expect(
          encoded.snapshot.projection.turnItems.map((item: { id: string }) => item.id),
        ).toEqual(["hidden-cache-item"]);
        const decoded = yield* decodeStoredThreadSnapshot(raw);
        expect(decoded.snapshot).toEqual(stored.snapshot);
        expect(decoded.snapshot).not.toHaveProperty("turnItemsOmitLocalVisible");
        expect(decoded.snapshot.projection.turnItems[0]).toBe(
          decoded.snapshot.projection.visibleTurnItems[1]!.item,
        );
        expect(yield* encodeStoredThreadSnapshot(decoded)).toBe(raw);
        expect(() => decodeLegacy(raw)).toThrow();
        expect(stored.snapshot.projection.turnItems).toHaveLength(2);
      }),
  );

  it.effect("reads V4 without restoring an unmarked full projection, then saves as V5", () =>
    Effect.gen(function* () {
      const stored = fixture();
      const decoded = yield* decodeStoredThreadSnapshot(encodeLegacy(stored));
      expect(decoded).toEqual(stored);
      // V4 JSON lost object sharing. Compaction must conservatively keep those entries.
      const migrated = yield* encodeStoredThreadSnapshot(decoded);
      expect(JSON.parse(migrated).schemaVersion).toBe(COMPACT_THREAD_CACHE_SCHEMA_VERSION);
      expect(JSON.parse(migrated).snapshot).not.toHaveProperty("turnItemsOmitLocalVisible");
      expect((yield* decodeStoredThreadSnapshot(migrated)).snapshot).toEqual(stored.snapshot);
    }),
  );

  it.effect.each(["different-value", "different-object", "interleaved-hidden", "empty"] as const)(
    "keeps the full projection when omission is unsafe or unnecessary: %s",
    (scenario) =>
      Effect.gen(function* () {
        const stored = fixture();
        const projection = stored.snapshot.projection;
        const local = projection.turnItems[0]!;
        if (scenario === "different-value") {
          projection.turnItems[0] = { ...local, message: "A different version of the same item." };
        } else if (scenario === "different-object") {
          projection.turnItems[0] = { ...local };
        } else if (scenario === "interleaved-hidden") {
          projection.turnItems.reverse();
        } else {
          projection.turnItems = [];
          projection.visibleTurnItems = [];
        }
        const raw = yield* encodeStoredThreadSnapshot(stored);
        expect(JSON.parse(raw).snapshot).not.toHaveProperty("turnItemsOmitLocalVisible");
        expect((yield* decodeStoredThreadSnapshot(raw)).snapshot).toEqual(stored.snapshot);
      }),
  );

  it.effect("restores multiple locals around inherited and same-thread synthetic rows", () =>
    Effect.gen(function* () {
      const stored = fixture();
      const projection = stored.snapshot.projection;
      const localRow = projection.visibleTurnItems[1]!;
      const second = { ...localRow.item, id: TurnItemId.make("second-local"), ordinal: 14 };
      const snapshot = {
        ...stored.snapshot,
        projection: {
          ...projection,
          turnItems: [localRow.item, second, projection.turnItems[1]!],
          visibleTurnItems: [
            { ...localRow, position: 0 },
            { ...projection.visibleTurnItems[0]!, position: 1 },
            {
              ...localRow,
              position: 2,
              visibility: "synthetic" as const,
              sourceItemId: second.id,
              item: second,
            },
          ],
        },
      };
      const decoded = yield* decodeStoredThreadSnapshot(
        yield* encodeStoredThreadSnapshot({ ...stored, snapshot }),
      );
      expect(decoded.snapshot).toEqual(snapshot);
      expect(decoded.snapshot.projection.turnItems[1]).toBe(
        decoded.snapshot.projection.visibleTurnItems[2]!.item,
      );
    }),
  );

  it.effect("rejects invalid markers, invalid items, obsolete V3, and future versions", () =>
    Effect.gen(function* () {
      const raw = yield* encodeStoredThreadSnapshot(fixture());
      for (const invalid of [
        raw.replace('"turnItemsOmitLocalVisible":true', '"turnItemsOmitLocalVisible":false'),
        raw.replace('"position":1', '"position":-1'),
        raw.replace('"schemaVersion":5', '"schemaVersion":3'),
        raw.replace('"schemaVersion":5', '"schemaVersion":6'),
      ]) {
        expect(Result.isFailure(yield* Effect.result(decodeStoredThreadSnapshot(invalid)))).toBe(
          true,
        );
      }
    }),
  );
});
