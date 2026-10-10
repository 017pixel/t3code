import packageJson from "../../package.json" with { type: "json" };
import * as NodeSqlite from "node:sqlite";
import { migrationManifest } from "../persistence/Migrations.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
      readonly needsDatabaseBackup?: boolean;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  /** Older servers always pass this flag when invoking a staged preflight. */
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      reason:
        "This release requires a newer T3 Code service launcher. Update it on the server machine.",
    };
  }

  let needsDatabaseBackup = true;
  try {
    const database = new NodeSqlite.DatabaseSync(input.databasePath, { readOnly: true });
    try {
      const rows = database.prepare("SELECT migration_id, name FROM effect_sql_migrations").all();
      const recorded = new Map(rows.map((row) => [row.migration_id, row.name]));
      needsDatabaseBackup = migrationManifest.some(([id, name]) => recorded.get(id) !== name);
    } finally {
      database.close();
    }
  } catch {
    // Missing/unreadable ledgers must take the conservative backup path.
  }
  return {
    status: "ready",
    version,
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    needsDatabaseBackup,
  };
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      ...(typeof record.needsDatabaseBackup === "boolean"
        ? { needsDatabaseBackup: record.needsDatabaseBackup }
        : {}),
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
