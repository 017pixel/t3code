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

const Migration0001 = loadMigration(() => import("./Migrations/001_OrchestrationEvents.ts"));
const Migration0002 = loadMigration(
  () => import("./Migrations/002_OrchestrationCommandReceipts.ts"),
);
const Migration0003 = loadMigration(() => import("./Migrations/003_CheckpointDiffBlobs.ts"));
const Migration0004 = loadMigration(() => import("./Migrations/004_ProviderSessionRuntime.ts"));
const Migration0005 = loadMigration(() => import("./Migrations/005_Projections.ts"));
const Migration0006 = loadMigration(
  () => import("./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts"),
);
const Migration0007 = loadMigration(
  () => import("./Migrations/007_ProjectionThreadMessageAttachments.ts"),
);
const Migration0008 = loadMigration(
  () => import("./Migrations/008_ProjectionThreadActivitySequence.ts"),
);
const Migration0009 = loadMigration(() => import("./Migrations/009_ProviderSessionRuntimeMode.ts"));
const Migration0010 = loadMigration(
  () => import("./Migrations/010_ProjectionThreadsRuntimeMode.ts"),
);
const Migration0011 = loadMigration(
  () => import("./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts"),
);
const Migration0012 = loadMigration(
  () => import("./Migrations/012_ProjectionThreadsInteractionMode.ts"),
);
const Migration0013 = loadMigration(
  () => import("./Migrations/013_ProjectionThreadProposedPlans.ts"),
);
const Migration0014 = loadMigration(
  () => import("./Migrations/014_ProjectionThreadProposedPlanImplementation.ts"),
);
const Migration0015 = loadMigration(
  () => import("./Migrations/015_ProjectionTurnsSourceProposedPlan.ts"),
);
const Migration0016 = loadMigration(
  () => import("./Migrations/016_CanonicalizeModelSelections.ts"),
);
const Migration0017 = loadMigration(
  () => import("./Migrations/017_ProjectionThreadsArchivedAt.ts"),
);
const Migration0018 = loadMigration(
  () => import("./Migrations/018_ProjectionThreadsArchivedAtIndex.ts"),
);
const Migration0019 = loadMigration(
  () => import("./Migrations/019_ProjectionSnapshotLookupIndexes.ts"),
);
const Migration0020 = loadMigration(() => import("./Migrations/020_AuthAccessManagement.ts"));
const Migration0021 = loadMigration(() => import("./Migrations/021_AuthSessionClientMetadata.ts"));
const Migration0022 = loadMigration(() => import("./Migrations/022_AuthSessionLastConnectedAt.ts"));
const Migration0023 = loadMigration(
  () => import("./Migrations/023_ProjectionThreadShellSummary.ts"),
);
const Migration0024 = loadMigration(
  () => import("./Migrations/024_BackfillProjectionThreadShellSummary.ts"),
);
const Migration0025 = loadMigration(
  () => import("./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts"),
);
const Migration0026 = loadMigration(
  () => import("./Migrations/026_CanonicalizeModelSelectionOptions.ts"),
);
const Migration0027 = loadMigration(
  () => import("./Migrations/027_ProviderSessionRuntimeInstanceId.ts"),
);
const Migration0028 = loadMigration(
  () => import("./Migrations/028_ProjectionThreadSessionInstanceId.ts"),
);
const Migration0029 = loadMigration(
  () => import("./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts"),
);
const Migration0030 = loadMigration(
  () => import("./Migrations/030_ProjectionThreadShellArchiveIndexes.ts"),
);
const Migration0031 = loadMigration(() => import("./Migrations/031_AuthAuthorizationScopes.ts"));
const Migration0032 = loadMigration(
  () => import("./Migrations/032_AuthPairingProofKeyThumbprint.ts"),
);
const Migration0033 = loadMigration(() => import("./Migrations/033_ProjectionThreadsSettled.ts"));
const Migration0034 = loadMigration(() => import("./Migrations/034_ProjectionThreadsSnoozed.ts"));
const Migration0035 = loadMigration(
  () => import("./Migrations/035_ProjectionThreadTitleRegeneration.ts"),
);
const Migration0036 = loadMigration(() => import("./Migrations/036_ProjectionThreadsPinned.ts"));
const Migration0037 = loadMigration(() => import("./Migrations/037_ProjectionTurnsKeysetIndex.ts"));
const Migration0038 = loadMigration(
  () => import("./Migrations/038_ProjectionThreadsPinOrderKey.ts"),
);
const Migration0039 = loadMigration(
  () => import("./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts"),
);
const Migration0040 = loadMigration(
  () => import("./Migrations/040_ProjectionProjectFaviconPath.ts"),
);
const Migration0041 = loadMigration(
  () => import("./Migrations/041_AuthSessionClientConnection.ts"),
);
const Migration0042 = loadMigration(
  () => import("./Migrations/042_ProjectionThreadLinkedPullRequest.ts"),
);
const Migration0043 = loadMigration(
  () => import("./Migrations/043_ProjectionThreadsUnsettledAt.ts"),
);
const Migration0044 = loadMigration(
  () => import("./Migrations/044_ClearAutomaticProjectModelDefaults.ts"),
);
const Migration0045 = loadMigration(() => import("./Migrations/045_ProjectionProjectsAutoPull.ts"));
const Migration0046 = loadMigration(
  () => import("./Migrations/046_RepairAutomaticSettlementTimestamps.ts"),
);
const Migration0047 = loadMigration(() => import("./Migrations/047_ProjectionProjectIcon.ts"));
const Migration0048 = loadMigration(
  () => import("./Migrations/048_ProjectionThreadBranchPullRequest.ts"),
);
const Migration0049 = loadMigration(
  () => import("./Migrations/049_ProjectionThreadsActiveOrderKey.ts"),
);
const Migration0050 = loadMigration(
  () => import("./Migrations/050_ProjectionThreadPullRequests.ts"),
);
const Migration0051 = loadMigration(
  () => import("./Migrations/051_ProjectionThreadMessageContext.ts"),
);
const Migration0052 = loadMigration(() => import("./Migrations/052_ProjectionThreadTitleState.ts"));
const Migration0053 = loadMigration(() => import("./Migrations/053_PullRequestFilesViewed.ts"));
const Migration0054 = loadMigration(
  () => import("./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts"),
);
const Migration0055 = loadMigration(() => import("./Migrations/055_OrchestrationV2.ts"));
const Migration0056 = loadMigration(
  () => import("./Migrations/056_RemoveRedundantProjectionIndexes.ts"),
);
const Migration0057 = loadMigration(() => import("./Migrations/057_ScheduledTaskWebhooks.ts"));
const Migration0058 = loadMigration(() => import("./Migrations/058_WebhookRelayDeliveries.ts"));
const Migration0059 = loadMigration(() => import("./Migrations/059_McpAppModelContext.ts"));
const Migration0060 = loadMigration(
  () => import("./Migrations/060_ThreadSnapshotWindowIndexes.ts"),
);
const Migration0061 = loadMigration(() => import("./Migrations/061_PullRequestReviewGuides.ts"));
const Migration0062 = loadMigration(
  () => import("./Migrations/062_ProjectionThreadSweepIndexes.ts"),
);
// 063's ledger step rebuilds rows; its default export repairs only missing projections.
// Destructure the named import so knip can track it.
const migrateThreadReadProjection = Effect.promise(async () => {
  const { migrateThreadReadProjection } =
    await import("./Migrations/063_ProjectionThreadReadPayload.ts");
  return migrateThreadReadProjection;
}).pipe(Effect.flatten, Effect.asVoid);

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
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Released as 53 and 54 in V2 previews; reconcileV2PreviewMigration preserves their ledger.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", Migration0055],
  [56, "RemoveRedundantProjectionIndexes", Migration0056],
  [57, "ScheduledTaskWebhooks", Migration0057],
  [58, "WebhookRelayDeliveries", Migration0058],
  [59, "McpAppModelContext", Migration0059],
  [60, "ThreadSnapshotWindowIndexes", Migration0060],
  [61, "PullRequestReviewGuides", Migration0061],
  // Preview and stacked builds that already recorded a different 62 skip this one (runMigrations
  // warns). They only lose the sweep index: no query names it with INDEXED BY.
  [62, "ProjectionThreadSweepIndexes", Migration0062],
  [63, "ProjectionThreadReadPayload", migrateThreadReadProjection],
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
