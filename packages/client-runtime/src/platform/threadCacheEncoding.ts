import {
  boundedSnapshotProjection,
  omitLocalVisibleTurnItems,
} from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { StoredOrchestrationThreadSnapshot } from "./orchestrationCache.ts";

// Keep the full V4 envelope for web/desktop and for reading existing mobile caches.
// Older clients must discard V5 rather than use a projection with missing items.
export const COMPACT_THREAD_CACHE_SCHEMA_VERSION = 5 as const;

const StoredCompactThreadSnapshot = StoredOrchestrationThreadSnapshot.mapFields((fields) => ({
  ...fields,
  schemaVersion: Schema.Literal(COMPACT_THREAD_CACHE_SCHEMA_VERSION),
  snapshot: fields.snapshot.mapFields((snapshotFields) => ({
    ...snapshotFields,
    turnItemsOmitLocalVisible: Schema.optionalKey(Schema.Literal(true)),
  })),
}));

const encodeCompact = Schema.encodeEffect(Schema.fromJsonString(StoredCompactThreadSnapshot));
const decodeCompatible = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([StoredCompactThreadSnapshot, StoredOrchestrationThreadSnapshot]),
  ),
);

export const encodeStoredThreadSnapshot = Effect.fn("ThreadCache.encode")(function* (
  stored: Pick<
    typeof StoredOrchestrationThreadSnapshot.Type,
    "environmentId" | "threadId" | "snapshot"
  >,
) {
  const { snapshot } = stored;
  const compact = omitLocalVisibleTurnItems(snapshot.projection);
  return yield* encodeCompact({
    ...stored,
    schemaVersion: COMPACT_THREAD_CACHE_SCHEMA_VERSION,
    snapshot: compact
      ? { ...snapshot, projection: compact, turnItemsOmitLocalVisible: true }
      : snapshot,
  });
});

export const decodeStoredThreadSnapshot = Effect.fn("ThreadCache.decode")(function* (raw: string) {
  const stored = yield* decodeCompatible(raw);
  if (stored.schemaVersion !== COMPACT_THREAD_CACHE_SCHEMA_VERSION) return stored;
  const { turnItemsOmitLocalVisible, ...snapshot } = stored.snapshot;
  return {
    ...stored,
    snapshot: {
      ...snapshot,
      projection: boundedSnapshotProjection({ ...snapshot, turnItemsOmitLocalVisible }),
    },
  };
});
