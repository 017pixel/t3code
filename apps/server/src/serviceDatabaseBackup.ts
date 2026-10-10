// @effect-diagnostics nodeBuiltinImport:off -- The standalone launcher uses Node built-ins only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/**
 * Hold the source read transaction until the stopped server's WAL is captured.
 * A WAL reader prevents checkpoint/reset from discarding frames newer than its
 * snapshot. Overlaying the final WAL on the online snapshot therefore reproduces
 * every commit through shutdown, including writes made during the long copy.
 * Copying just an online snapshot would lose those acknowledged writes on rollback.
 */
export async function prepareServiceDatabaseBackup(databasePath: string, stagingDir: string) {
  await NodeFSP.rm(stagingDir, { recursive: true, force: true });
  await NodeFSP.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  const source = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec("PRAGMA busy_timeout = 5000; BEGIN");
    source.prepare("SELECT name FROM sqlite_schema LIMIT 1").get();
    const mode = source.prepare("PRAGMA journal_mode").get();
    if (mode?.journal_mode !== "wal") {
      throw new Error("Online update backup requires a WAL database.");
    }
    const destination = NodePath.join(stagingDir, "database");
    await NodeSqlite.backup(source, destination, { rate: 256 });
    // SQLite backup produces a standalone database. Enable WAL before installing
    // the source WAL; never open the destination between copying WAL and restore.
    const snapshot = new NodeSqlite.DatabaseSync(destination);
    try {
      snapshot.exec("PRAGMA journal_mode = WAL");
    } finally {
      snapshot.close();
    }
    const file = await NodeFSP.open(destination, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    return {
      async finish() {
        try {
          await NodeFSP.copyFile(`${databasePath}-wal`, NodePath.join(stagingDir, "database-wal"));
          const wal = await NodeFSP.open(NodePath.join(stagingDir, "database-wal"), "r+");
          try {
            await wal.sync();
          } finally {
            await wal.close();
          }
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
        }
      },
      close() {
        source.close();
      },
    };
  } catch (cause) {
    source.close();
    await NodeFSP.rm(stagingDir, { recursive: true, force: true });
    throw cause;
  }
}
