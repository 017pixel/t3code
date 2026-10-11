/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * Pending migrations load on demand through explicit module imports.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts.
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// The migrator only evaluates pending effects, so an up-to-date database never
// loads historical schemas or their data transforms.
const loadMigration = <A, E>(
  load: () => Promise<{ default: Effect.Effect<A, E, SqlClient.SqlClient> }>,
) =>
  Effect.promise(load).pipe(
    Effect.flatMap((module) => module.default),
    Effect.asVoid,
  );

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [
    1,
    "OrchestrationEvents",
    loadMigration(() => import("./Migrations/001_OrchestrationEvents.ts")),
  ],
  [
    2,
    "OrchestrationCommandReceipts",
    loadMigration(() => import("./Migrations/002_OrchestrationCommandReceipts.ts")),
  ],
  [
    3,
    "CheckpointDiffBlobs",
    loadMigration(() => import("./Migrations/003_CheckpointDiffBlobs.ts")),
  ],
  [
    4,
    "ProviderSessionRuntime",
    loadMigration(() => import("./Migrations/004_ProviderSessionRuntime.ts")),
  ],
  [5, "Projections", loadMigration(() => import("./Migrations/005_Projections.ts"))],
  [
    6,
    "ProjectionThreadSessionRuntimeModeColumns",
    loadMigration(() => import("./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts")),
  ],
  [
    7,
    "ProjectionThreadMessageAttachments",
    loadMigration(() => import("./Migrations/007_ProjectionThreadMessageAttachments.ts")),
  ],
  [
    8,
    "ProjectionThreadActivitySequence",
    loadMigration(() => import("./Migrations/008_ProjectionThreadActivitySequence.ts")),
  ],
  [
    9,
    "ProviderSessionRuntimeMode",
    loadMigration(() => import("./Migrations/009_ProviderSessionRuntimeMode.ts")),
  ],
  [
    10,
    "ProjectionThreadsRuntimeMode",
    loadMigration(() => import("./Migrations/010_ProjectionThreadsRuntimeMode.ts")),
  ],
  [
    11,
    "OrchestrationThreadCreatedRuntimeMode",
    loadMigration(() => import("./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts")),
  ],
  [
    12,
    "ProjectionThreadsInteractionMode",
    loadMigration(() => import("./Migrations/012_ProjectionThreadsInteractionMode.ts")),
  ],
  [
    13,
    "ProjectionThreadProposedPlans",
    loadMigration(() => import("./Migrations/013_ProjectionThreadProposedPlans.ts")),
  ],
  [
    14,
    "ProjectionThreadProposedPlanImplementation",
    loadMigration(() => import("./Migrations/014_ProjectionThreadProposedPlanImplementation.ts")),
  ],
  [
    15,
    "ProjectionTurnsSourceProposedPlan",
    loadMigration(() => import("./Migrations/015_ProjectionTurnsSourceProposedPlan.ts")),
  ],
  [
    16,
    "CanonicalizeModelSelections",
    loadMigration(() => import("./Migrations/016_CanonicalizeModelSelections.ts")),
  ],
  [
    17,
    "ProjectionThreadsArchivedAt",
    loadMigration(() => import("./Migrations/017_ProjectionThreadsArchivedAt.ts")),
  ],
  [
    18,
    "ProjectionThreadsArchivedAtIndex",
    loadMigration(() => import("./Migrations/018_ProjectionThreadsArchivedAtIndex.ts")),
  ],
  [
    19,
    "ProjectionSnapshotLookupIndexes",
    loadMigration(() => import("./Migrations/019_ProjectionSnapshotLookupIndexes.ts")),
  ],
  [
    20,
    "AuthAccessManagement",
    loadMigration(() => import("./Migrations/020_AuthAccessManagement.ts")),
  ],
  [
    21,
    "AuthSessionClientMetadata",
    loadMigration(() => import("./Migrations/021_AuthSessionClientMetadata.ts")),
  ],
  [
    22,
    "AuthSessionLastConnectedAt",
    loadMigration(() => import("./Migrations/022_AuthSessionLastConnectedAt.ts")),
  ],
  [
    23,
    "ProjectionThreadShellSummary",
    loadMigration(() => import("./Migrations/023_ProjectionThreadShellSummary.ts")),
  ],
  [
    24,
    "BackfillProjectionThreadShellSummary",
    loadMigration(() => import("./Migrations/024_BackfillProjectionThreadShellSummary.ts")),
  ],
  [
    25,
    "CleanupInvalidProjectionPendingApprovals",
    loadMigration(() => import("./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts")),
  ],
  [
    26,
    "CanonicalizeModelSelectionOptions",
    loadMigration(() => import("./Migrations/026_CanonicalizeModelSelectionOptions.ts")),
  ],
  [
    27,
    "ProviderSessionRuntimeInstanceId",
    loadMigration(() => import("./Migrations/027_ProviderSessionRuntimeInstanceId.ts")),
  ],
  [
    28,
    "ProjectionThreadSessionInstanceId",
    loadMigration(() => import("./Migrations/028_ProjectionThreadSessionInstanceId.ts")),
  ],
  [
    29,
    "ProjectionThreadDetailOrderingIndexes",
    loadMigration(() => import("./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts")),
  ],
  [
    30,
    "ProjectionThreadShellArchiveIndexes",
    loadMigration(() => import("./Migrations/030_ProjectionThreadShellArchiveIndexes.ts")),
  ],
  [
    31,
    "AuthAuthorizationScopes",
    loadMigration(() => import("./Migrations/031_AuthAuthorizationScopes.ts")),
  ],
  [
    32,
    "AuthPairingProofKeyThumbprint",
    loadMigration(() => import("./Migrations/032_AuthPairingProofKeyThumbprint.ts")),
  ],
  [
    33,
    "ProjectionThreadsSettled",
    loadMigration(() => import("./Migrations/033_ProjectionThreadsSettled.ts")),
  ],
  [
    34,
    "ProjectionThreadsSnoozed",
    loadMigration(() => import("./Migrations/034_ProjectionThreadsSnoozed.ts")),
  ],
  [
    35,
    "ProjectionThreadTitleRegeneration",
    loadMigration(() => import("./Migrations/035_ProjectionThreadTitleRegeneration.ts")),
  ],
  [
    36,
    "ProjectionThreadsPinned",
    loadMigration(() => import("./Migrations/036_ProjectionThreadsPinned.ts")),
  ],
  [
    37,
    "ProjectionTurnsKeysetIndex",
    loadMigration(() => import("./Migrations/037_ProjectionTurnsKeysetIndex.ts")),
  ],
  [
    38,
    "ProjectionThreadsPinOrderKey",
    loadMigration(() => import("./Migrations/038_ProjectionThreadsPinOrderKey.ts")),
  ],
  [
    39,
    "ProjectionProjectsDefaultThreadEnvMode",
    loadMigration(() => import("./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts")),
  ],
  [
    40,
    "ProjectionProjectFaviconPath",
    loadMigration(() => import("./Migrations/040_ProjectionProjectFaviconPath.ts")),
  ],
  [
    41,
    "AuthSessionClientConnection",
    loadMigration(() => import("./Migrations/041_AuthSessionClientConnection.ts")),
  ],
  [
    42,
    "ProjectionThreadLinkedPullRequest",
    loadMigration(() => import("./Migrations/042_ProjectionThreadLinkedPullRequest.ts")),
  ],
  [
    43,
    "ProjectionThreadsUnsettledAt",
    loadMigration(() => import("./Migrations/043_ProjectionThreadsUnsettledAt.ts")),
  ],
  [
    44,
    "ClearAutomaticProjectModelDefaults",
    loadMigration(() => import("./Migrations/044_ClearAutomaticProjectModelDefaults.ts")),
  ],
  [
    45,
    "ProjectionProjectsAutoPull",
    loadMigration(() => import("./Migrations/045_ProjectionProjectsAutoPull.ts")),
  ],
  [
    46,
    "RepairAutomaticSettlementTimestamps",
    loadMigration(() => import("./Migrations/046_RepairAutomaticSettlementTimestamps.ts")),
  ],
  [
    47,
    "ProjectionProjectIcon",
    loadMigration(() => import("./Migrations/047_ProjectionProjectIcon.ts")),
  ],
  [
    48,
    "ProjectionThreadBranchPullRequest",
    loadMigration(() => import("./Migrations/048_ProjectionThreadBranchPullRequest.ts")),
  ],
  [
    49,
    "ProjectionThreadsActiveOrderKey",
    loadMigration(() => import("./Migrations/049_ProjectionThreadsActiveOrderKey.ts")),
  ],
  [
    50,
    "ProjectionThreadPullRequests",
    loadMigration(() => import("./Migrations/050_ProjectionThreadPullRequests.ts")),
  ],
  [
    51,
    "ProjectionThreadMessageContext",
    loadMigration(() => import("./Migrations/051_ProjectionThreadMessageContext.ts")),
  ],
  [
    52,
    "ProjectionThreadTitleState",
    loadMigration(() => import("./Migrations/052_ProjectionThreadTitleState.ts")),
  ],
  [
    53,
    "PullRequestFilesViewed",
    loadMigration(() => import("./Migrations/053_PullRequestFilesViewed.ts")),
  ],
  [
    54,
    "ProjectionThreadsAutoSettleDisabledAt",
    loadMigration(() => import("./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts")),
  ],
  // Released as 53 and 54 in V2 previews; reconcileV2PreviewMigration preserves their ledger.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", loadMigration(() => import("./Migrations/055_OrchestrationV2.ts"))],
  [
    56,
    "RemoveRedundantProjectionIndexes",
    loadMigration(() => import("./Migrations/056_RemoveRedundantProjectionIndexes.ts")),
  ],
  [
    57,
    "ScheduledTaskWebhooks",
    loadMigration(() => import("./Migrations/057_ScheduledTaskWebhooks.ts")),
  ],
  [
    58,
    "WebhookRelayDeliveries",
    loadMigration(() => import("./Migrations/058_WebhookRelayDeliveries.ts")),
  ],
  [59, "McpAppModelContext", loadMigration(() => import("./Migrations/059_McpAppModelContext.ts"))],
  [
    60,
    "ThreadSnapshotWindowIndexes",
    loadMigration(() => import("./Migrations/060_ThreadSnapshotWindowIndexes.ts")),
  ],
  [
    61,
    "PullRequestReviewGuides",
    loadMigration(() => import("./Migrations/061_PullRequestReviewGuides.ts")),
  ],
  // Preview and stacked builds that already recorded a different 62 skip this one (runMigrations
  // warns). They only lose the sweep index: no query names it with INDEXED BY.
  [
    62,
    "ProjectionThreadSweepIndexes",
    loadMigration(() => import("./Migrations/062_ProjectionThreadSweepIndexes.ts")),
  ],
  [
    63,
    "ProjectionThreadReadPayload",
    loadMigration(() => import("./Migrations/063_ProjectionThreadReadPayload.ts")),
  ],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);
const manifestKey = migrationManifest.map(([id, name]) => `${id}_${name}`).join(",");

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const sql = yield* SqlClient.SqlClient;
  if (toMigrationInclusive === undefined) {
    const cacheTables = yield* sql`SELECT name FROM sqlite_master WHERE name = 't3_schema_cache'`;
    if (cacheTables.length > 0) {
      const version = yield* sql<{ schema_version: number }>`PRAGMA schema_version`;
      // The cache also requires what 063's startup step keeps outside the migrator. Running
      // that step here would take a write lock on every start, so check for its objects.
      const cached = yield* sql<{
        manifest: string;
        schema_version: number;
        read_projection_objects: number;
      }>`
        SELECT manifest, schema_version, (
          SELECT COUNT(*) FROM sqlite_master
          WHERE name IN (
              'orchestration_v2_projection_thread_reads_stale_on_insert',
              'orchestration_v2_projection_thread_reads_stale_on_update'
            )
            OR (name = 'orchestration_v2_projection_thread_reads' AND sql LIKE '%source_stale%')
        ) AS read_projection_objects
        FROM t3_schema_cache WHERE id = 1
      `;
      if (
        cached[0]?.manifest === manifestKey &&
        cached[0]?.schema_version === version[0]?.schema_version &&
        cached[0]?.read_projection_objects === 3
      ) {
        yield* Effect.logDebug("Database schema is current");
        return [];
      }
    }
  }
  const previewMigrations =
    toMigrationInclusive === undefined || toMigrationInclusive >= 55
      ? yield* reconcileV2PreviewMigration()
      : [];
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  // The migrator never runs an id at or below the latest recorded one, so a migration this
  // build adds below another build's highest id never runs here.
  const latestRecorded = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedKeys = new Set(recorded.map((row) => `${row.migration_id}_${row.name}`));
  const skipped = migrationEntries.flatMap(([id, name]) =>
    id <= latestRecorded && !recordedKeys.has(`${id}_${name}`) ? [`${id}_${name}`] : [],
  );
  if (skipped.length > 0) {
    yield* Effect.logWarning(
      "Migrations of this build never ran on this database: the migrator skips ids at or below its latest recorded migration.",
    ).pipe(Effect.annotateLogs({ skipped }));
  }
  // ProjectionStore reads this table, so it must exist even when its migration was skipped.
  if (toMigrationInclusive === undefined || toMigrationInclusive >= 63) {
    yield* loadMigration(() => import("./Migrations/063_ProjectionThreadReadPayload.ts"));
  }
  if (toMigrationInclusive === undefined && divergent.length === 0 && skipped.length === 0) {
    // Other builds can share this database. Schema changes miss this cache; ledger
    // writes invalidate it even when they do not change SQLite's schema version.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        // Revalidate under the write transaction before caching a shared database.
        const history = yield* sql<{ migration_id: number; name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
        `;
        if (
          history.length !== migrationManifest.length ||
          history.some(
            (row, index) =>
              row.migration_id !== migrationManifest[index]?.[0] ||
              row.name !== migrationManifest[index]?.[1],
          )
        )
          return;
        yield* loadMigration(() => import("./Migrations/063_ProjectionThreadReadPayload.ts"));
        yield* sql`CREATE TABLE IF NOT EXISTS t3_schema_cache (
        id INTEGER PRIMARY KEY CHECK (id = 1), manifest TEXT NOT NULL, schema_version INTEGER NOT NULL
      )`;
        for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
          yield* sql.unsafe(`CREATE TRIGGER IF NOT EXISTS t3_schema_cache_${operation.toLowerCase()}
          AFTER ${operation} ON effect_sql_migrations BEGIN DELETE FROM t3_schema_cache; END`);
        }
        const version = yield* sql<{ schema_version: number }>`PRAGMA schema_version`;
        yield* sql`INSERT OR REPLACE INTO t3_schema_cache (id, manifest, schema_version)
        VALUES (1, ${manifestKey}, ${version[0]!.schema_version})`;
      }),
    );
  }
  return executedMigrations;
});
