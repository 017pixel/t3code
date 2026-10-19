// @effect-diagnostics nodeBuiltinImport:off -- Real WAL preservation uses only disposable test homes.
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { CodexSettings } from "@t3tools/contracts";
import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomePathConflictError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
const decodeCodexSettingsValue = Schema.decodeSync(CodexSettings);

const decodeCodexSettings = (input: {
  readonly enabled?: boolean;
  readonly homePath?: string;
  readonly shadowHomePath?: string;
  readonly customModels?: readonly string[];
  readonly binaryPath?: string;
}): CodexSettings => decodeCodexSettingsValue(input);

const makeTempDir = Effect.fn("CodexHomeLayout.test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

const writeTextFile = Effect.fn("CodexHomeLayout.test.writeTextFile")(function* (
  filePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
  yield* fileSystem.writeFileString(filePath, contents);
});

it.layer(NodeServices.layer)("CodexHomeLayout", (it) => {
  describe("resolveCodexHomeLayout", () => {
    it.effect("uses direct CODEX_HOME when no shadow home is configured", () =>
      Effect.gen(function* () {
        const homePath = yield* makeTempDir("t3code-codex-home-");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath,
          }),
        );

        expect(layout).toMatchObject({
          mode: "direct",
          sharedHomePath: homePath,
          effectiveHomePath: homePath,
          continuationKey: `codex:home:${homePath}`,
        });
      }),
    );

    it.effect("uses the shared home for continuation and the shadow home for runtime", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        expect(layout).toMatchObject({
          mode: "authOverlay",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
          continuationKey: `codex:home:${sharedHome}`,
        });
      }),
    );
  });

  describe("materializeCodexShadowHome", () => {
    it.effect.each([false, true])(
      "leaves SQLite families unlinked and preserves real shadow files (existing: %s)",
      (existing) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("codex-sqlite-shared-");
          const shadowHome = yield* makeTempDir("codex-sqlite-shadow-");
          const names = [
            "state_5.sqlite",
            "future_42.SQLITE-WAL",
            "logs.sqlite-shm",
            "other.sqlite-journal",
          ];
          for (const name of names) {
            yield* fs.writeFileString(path.join(sharedHome, name), `shared:${name}`);
            if (existing) yield* fs.writeFileString(path.join(shadowHome, name), `private:${name}`);
          }
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);
          for (const name of names) {
            expect(yield* fs.readFileString(path.join(sharedHome, name))).toBe(`shared:${name}`);
            expect(yield* fs.exists(path.join(shadowHome, name))).toBe(existing);
            if (existing)
              expect(yield* fs.readFileString(path.join(shadowHome, name))).toBe(`private:${name}`);
          }
        }),
      { skip: !symlinksSupported },
    );

    it.effect.each([
      "state_5.sqlite",
      "future.SQLITE-WAL",
      "orphan.sqlite-SHM",
      "future.sqlite-journal",
    ])(
      "refuses legacy %s links before preparation, even dangling, without changing files",
      (name) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("codex-sqlite-shared-");
          const shadowHome = yield* makeTempDir("codex-sqlite-shadow-");
          const target = path.join(sharedHome, name);
          const linkPath = path.join(shadowHome, name);
          yield* fs.symlink(target, linkPath);
          yield* fs.writeFileString(path.join(shadowHome, "private.sqlite-wal"), "uncheckpointed");
          yield* fs.writeFileString(path.join(sharedHome, "config.toml"), "shared config");
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          for (const attempt of [1, 2]) {
            const result = yield* materializeCodexShadowHome(layout).pipe(Effect.result);
            expect(result, `attempt ${attempt}`).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "CodexShadowHomeSqliteRecoveryRequiredError", linkPath },
            });
            if (result._tag === "Failure") {
              expect(result.failure.message).toContain("Stop all Codex processes");
              expect(result.failure.message).not.toContain(sharedHome);
            }
            expect(yield* fs.readLink(linkPath)).toBe(target);
            expect(yield* fs.exists(target)).toBe(false);
            expect(yield* fs.readFileString(path.join(shadowHome, "private.sqlite-wal"))).toBe(
              "uncheckpointed",
            );
            expect((yield* fs.readDirectory(shadowHome)).sort()).toEqual(
              [name, "private.sqlite-wal"].sort(),
            );
            expect(yield* fs.readDirectory(sharedHome)).toEqual(["config.toml"]);
          }
        }),
      { skip: !symlinksSupported },
    );

    it.effect.skipIf(!symlinksSupported)(
      "preserves live WAL commits and shadow sidecars until manual recovery",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("codex-sqlite-shared-");
          const shadowHome = yield* makeTempDir("codex-sqlite-shadow-");
          const database = path.join(sharedHome, "state_5.sqlite");
          const link = path.join(shadowHome, "state_5.sqlite");
          yield* fs.writeFileString(database, "");
          yield* fs.symlink(database, link);
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );
          yield* Effect.gen(function* () {
            const writer = yield* Effect.acquireRelease(
              Effect.sync(() => new NodeSqlite.DatabaseSync(database)),
              (db) => Effect.sync(() => db.close()),
            );
            expect(yield* materializeCodexShadowHome(layout).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "CodexShadowHomeSqliteRecoveryRequiredError" },
            });
            writer.exec(
              "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE writes (value TEXT); INSERT INTO writes VALUES ('legacy');",
            );
            const wal = path.join(sharedHome, "state_5.sqlite-wal");
            const before = yield* fs.readFile(wal);
            const shadowWal = path.join(shadowHome, "state_5.sqlite-wal");
            yield* fs.writeFile(shadowWal, before);
            const databaseBefore = yield* fs.readFile(database);
            expect(before.length).toBeGreaterThan(0);
            expect(yield* materializeCodexShadowHome(layout).pipe(Effect.result)).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "CodexShadowHomeSqliteRecoveryRequiredError" },
            });
            expect(yield* fs.readFile(wal)).toEqual(before);
            expect(yield* fs.readFile(shadowWal)).toEqual(before);
            expect(yield* fs.readFile(database)).toEqual(databaseBefore);
            expect(yield* fs.readLink(link)).toBe(database);
            expect(writer.prepare("SELECT value FROM writes").all()).toEqual([{ value: "legacy" }]);
          }).pipe(Effect.scoped);
          // Only the operator unlinks the legacy database after the writer closes and checkpoints.
          yield* fs.remove(link);
          yield* materializeCodexShadowHome(layout);
          const reopened = yield* Effect.acquireRelease(
            Effect.sync(() => new NodeSqlite.DatabaseSync(database)),
            (db) => Effect.sync(() => db.close()),
          );
          expect(reopened.prepare("SELECT value FROM writes").all()).toEqual([{ value: "legacy" }]);
          expect(yield* fs.exists(link)).toBe(false);
        }),
    );
    it.effect.skipIf(!symlinksSupported)(
      "keeps Finder metadata local across repeated shadow home setup",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowHome = yield* makeTempDir("t3code-codex-shadow-");
          const sharedMetadata = path.join(sharedHome, ".DS_Store");
          const shadowMetadata = path.join(shadowHome, ".DS_Store");

          yield* writeTextFile(sharedMetadata, "shared Finder metadata");
          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({ homePath: sharedHome, shadowHomePath: shadowHome }),
          );

          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          yield* fileSystem.remove(shadowMetadata);
          yield* materializeCodexShadowHome(layout);
          expect(yield* fileSystem.exists(shadowMetadata)).toBe(false);

          yield* writeTextFile(shadowMetadata, "shadow Finder metadata");
          yield* materializeCodexShadowHome(layout);
          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readFileString(sharedMetadata)).toBe("shared Finder metadata");
          expect(yield* fileSystem.readFileString(shadowMetadata)).toBe("shadow Finder metadata");
          expect(yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"))).toBe(
            '{"shadow":true}\n',
          );
          expect(yield* fileSystem.readLink(path.join(shadowHome, "sessions"))).toBe(
            path.join(sharedHome, "sessions"),
          );
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "materializes a shadow home with shared state links and private auth",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "sessions"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(
            path.join(sharedHome, "models_cache.json"),
            '{"models":["shared"]}\n',
          );
          yield* writeTextFile(path.join(sharedHome, "auth.json"), '{"shared":true}\n');
          yield* fileSystem.makeDirectory(shadowHome, { recursive: true });
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.symlink(
            path.join(sharedHome, "models_cache.json"),
            path.join(shadowHome, "models_cache.json"),
          );

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const sessionsTarget = yield* fileSystem.readLink(path.join(shadowHome, "sessions"));
          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const mcpOauthLocksTarget = yield* fileSystem.readLink(
            path.join(shadowHome, "mcp-oauth-locks"),
          );
          const modelsCacheExists = yield* fileSystem.exists(
            path.join(shadowHome, "models_cache.json"),
          );
          const authLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "auth.json"))
            .pipe(Effect.result);
          const authContents = yield* fileSystem.readFileString(path.join(shadowHome, "auth.json"));

          expect(sessionsTarget).toBe(path.join(sharedHome, "sessions"));
          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(mcpOauthLocksTarget).toBe(path.join(sharedHome, "mcp-oauth-locks"));
          expect(modelsCacheExists).toBe(false);
          expect(authLinkResult._tag).toBe("Failure");
          expect(authContents).toContain("shadow");
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces a Codex-created local sqlite maintenance lock with the shared lock",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLock = path.join(sharedHome, ".sqlite-maintenance.lock");
          const shadowLock = path.join(shadowHome, ".sqlite-maintenance.lock");

          yield* writeTextFile(sharedLock, "");
          yield* writeTextFile(shadowLock, "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          expect(yield* fileSystem.readLink(shadowLock)).toBe(sharedLock);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "replaces Codex-created local MCP OAuth locks with the shared lock directory",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          const sharedLocks = path.join(sharedHome, "mcp-oauth-locks");
          const shadowLocks = path.join(shadowHome, "mcp-oauth-locks");

          yield* writeTextFile(path.join(sharedLocks, "file-store.lock"), "");
          yield* writeTextFile(path.join(shadowLocks, "file-store.lock"), "");

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const locksTarget = yield* fileSystem.readLink(shadowLocks);
          const sharedLockExists = yield* fileSystem.exists(
            path.join(sharedLocks, "file-store.lock"),
          );

          expect(locksTarget).toBe(sharedLocks);
          expect(sharedLockExists).toBe(true);
        }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "accepts Codex-created shadow-local runtime directories",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");

          yield* fileSystem.makeDirectory(path.join(sharedHome, "log"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "memories"));
          yield* fileSystem.makeDirectory(path.join(sharedHome, "tmp"));
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "auth.json"), '{"shadow":true}\n');
          yield* fileSystem.makeDirectory(path.join(shadowHome, "log"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "memories"), { recursive: true });
          yield* fileSystem.makeDirectory(path.join(shadowHome, "tmp"), { recursive: true });

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          yield* materializeCodexShadowHome(layout);

          const configTarget = yield* fileSystem.readLink(path.join(shadowHome, "config.toml"));
          const logLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "log"))
            .pipe(Effect.result);
          const memoriesLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "memories"))
            .pipe(Effect.result);
          const tmpLinkResult = yield* fileSystem
            .readLink(path.join(shadowHome, "tmp"))
            .pipe(Effect.result);

          expect(configTarget).toBe(path.join(sharedHome, "config.toml"));
          expect(logLinkResult._tag).toBe("Failure");
          expect(memoriesLinkResult._tag).toBe("Failure");
          expect(tmpLinkResult._tag).toBe("Failure");
        }),
    );

    it.effect("rejects shadow homes that point at the shared home", () =>
      Effect.gen(function* () {
        const sharedHome = yield* makeTempDir("t3code-codex-shared-");
        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: sharedHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error).toBeInstanceOf(CodexShadowHomePathConflictError);
        expect(error).toMatchObject({
          sharedHomePath: sharedHome,
          effectiveHomePath: sharedHome,
        });
        expect(error.message).toBe(
          `Codex shadow home path '${sharedHome}' must be different from the shared home path '${sharedHome}'.`,
        );
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects shared entries that already exist in the shadow home as real files",
      () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const sharedHome = yield* makeTempDir("t3code-codex-shared-");
          const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
          const shadowHome = path.join(shadowRoot, "shadow");
          yield* writeTextFile(path.join(sharedHome, "config.toml"), 'model = "gpt-5-codex"\n');
          yield* writeTextFile(path.join(shadowHome, "config.toml"), 'model = "local"\n');

          const layout = yield* resolveCodexHomeLayout(
            decodeCodexSettings({
              homePath: sharedHome,
              shadowHomePath: shadowHome,
            }),
          );

          const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

          expect(error).toBeInstanceOf(CodexShadowHomeEntryConflictError);
          expect(error).toMatchObject({
            sharedHomePath: sharedHome,
            effectiveHomePath: shadowHome,
            entryName: "config.toml",
            linkPath: path.join(shadowHome, "config.toml"),
            targetPath: path.join(sharedHome, "config.toml"),
          });
          expect(error.message).toBe(
            `Cannot create Codex shadow home entry 'config.toml' because '${path.join(shadowHome, "config.toml")}' already exists and is not a symlink.`,
          );
        }),
    );

    it.effect("preserves filesystem operation, paths, and cause", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const sharedRoot = yield* makeTempDir("t3code-codex-shared-root-");
        const sharedHome = path.join(sharedRoot, "shared-home");
        const shadowRoot = yield* makeTempDir("t3code-codex-shadow-root-");
        const shadowHome = path.join(shadowRoot, "shadow");
        yield* writeTextFile(sharedHome, "not a directory\n");

        const layout = yield* resolveCodexHomeLayout(
          decodeCodexSettings({
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          }),
        );

        const error = yield* materializeCodexShadowHome(layout).pipe(Effect.flip);

        expect(error._tag).toBe("CodexShadowHomeFileSystemError");
        if (error._tag !== "CodexShadowHomeFileSystemError") {
          return expect.fail("Expected CodexShadowHomeFileSystemError");
        }
        expect(error).toMatchObject({
          operation: "makeDirectory",
          sharedHomePath: sharedHome,
          effectiveHomePath: shadowHome,
        });
        expect(error.path.startsWith(sharedHome)).toBe(true);
        expect(error.cause).toBeInstanceOf(PlatformError.PlatformError);
        expect(error.message).toBe(
          `Codex shadow home filesystem operation 'makeDirectory' failed for '${error.path}'.`,
        );
      }),
    );
  });
});
