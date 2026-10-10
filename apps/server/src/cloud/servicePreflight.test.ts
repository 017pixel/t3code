// @effect-diagnostics nodeBuiltinImport:off -- Preflight is a standalone Node launcher path; this test checks its readonly ledger.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { migrationManifest } from "../persistence/Migrations.ts";
import { expect, it } from "@effect/vitest";

import { runServicePreflight } from "./servicePreflight.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

it.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason:
      "This release requires a newer T3 Code service launcher. Update it on the server machine.",
  });
});

it("accepts the current launcher protocol", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    needsDatabaseBackup: true,
  });
});

it("skips backup only when the target migration ledger is complete without mutating it", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-preflight-"));
  const databasePath = NodePath.join(directory, "state.sqlite");
  const database = new NodeSqlite.DatabaseSync(databasePath);
  try {
    database.exec(
      "CREATE TABLE effect_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT)",
    );
    const insert = database.prepare("INSERT INTO effect_sql_migrations VALUES (?, ?)");
    for (const [id, name] of migrationManifest) insert.run(id, name);
    const preflight = () =>
      runServicePreflight({
        databasePath,
        launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
        version: "1.2.3",
      });
    expect(preflight()).toMatchObject({ status: "ready", needsDatabaseBackup: false });
    const latest = migrationManifest.at(-1)!;
    database.prepare("DELETE FROM effect_sql_migrations WHERE migration_id=?").run(latest[0]);
    const missing = database
      .prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id")
      .all();
    expect(preflight()).toMatchObject({ status: "ready", needsDatabaseBackup: true });
    expect(
      database.prepare("SELECT * FROM effect_sql_migrations ORDER BY migration_id").all(),
    ).toEqual(missing);
  } finally {
    database.close();
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});
