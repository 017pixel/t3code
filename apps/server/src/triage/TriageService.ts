import {
  type AuthClientPresentationMetadata,
  ServerPrepareTriageError,
  type ServerPrepareTriageInput,
  type ServerPrepareTriageResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { buildTriageAppPrompt, type TriageSourceClone } from "./triagePrompt.ts";
import { triageSourceCacheDir, writeTriageSession } from "./triageSession.ts";

const T3CODE_REPOSITORY_URL = "https://github.com/pingdotgg/t3code";

// No tty: a credential prompt would hang forever, so git must fail instead.
const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } satisfies NodeJS.ProcessEnv;

/** Starts in-app triage sessions: the same files `t3 triage` writes, plus a source clone. */
export class TriageService extends Context.Service<
  TriageService,
  {
    readonly prepare: (
      input: ServerPrepareTriageInput,
    ) => Effect.Effect<ServerPrepareTriageResult, ServerPrepareTriageError>;
  }
>()("t3/triage/TriageService") {}

const describeClient = (client: AuthClientPresentationMetadata) =>
  [
    client.label ?? "an unknown client",
    client.appVersion === undefined ? undefined : `version ${client.appVersion}`,
    client.os === undefined ? undefined : `on ${client.os}`,
    client.browser === undefined ? undefined : `in ${client.browser}`,
    client.webDeployment === "hosted" ? "(app.t3.codes)" : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");

/** Picks the release tag for `version`, or `main` when the build has no tag. */
export const pickSourceRef = (lsRemoteOutput: string, version: string) => {
  const commits = new Map(
    lsRemoteOutput
      .split("\n")
      .map((line) => line.trim().split("\t"))
      .filter((fields): fields is [string, string] => fields.length === 2)
      .map(([commit, ref]) => [ref, commit]),
  );
  const tag = `v${version}`;
  // Annotated tags list the tag object first and the commit as `^{}`.
  const tagCommit = commits.get(`refs/tags/${tag}^{}`) ?? commits.get(`refs/tags/${tag}`);
  if (tagCommit !== undefined) return { ref: tag, commit: tagCommit };
  const mainCommit = commits.get("refs/heads/main");
  return mainCommit === undefined ? undefined : { ref: "main", commit: mainCommit };
};

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourceDir = triageSourceCacheDir(config.baseDir, path);
  const serverVersion = packageJson.version;

  const runGit = (operation: string, cwd: string, args: ReadonlyArray<string>, timeoutMs: number) =>
    git.execute({ operation: `TriageService.${operation}`, cwd, args, timeoutMs, env: GIT_ENV });

  // The playbook's own layout: one folder per commit under the source cache, so
  // the agent finds and reuses this clone instead of making another.
  const cloneSource = Effect.fn("TriageService.cloneSource")(function* () {
    yield* fs.makeDirectory(sourceDir, { recursive: true });
    const listed = yield* runGit(
      "resolveSourceRef",
      sourceDir,
      ["ls-remote", T3CODE_REPOSITORY_URL, `refs/tags/v${serverVersion}`, "refs/heads/main"],
      30_000,
    );
    const source = pickSourceRef(listed.stdout, serverVersion);
    if (source === undefined) {
      return {
        _tag: "failed",
        serverVersion,
        reason: "the repository listed neither the release tag nor main.",
      } satisfies TriageSourceClone;
    }
    const existing = path.join(sourceDir, source.commit);
    if (yield* fs.exists(existing)) {
      return { _tag: "cloned", directory: existing, serverVersion, ...source } as const;
    }

    const staging = yield* fs.makeTempDirectory({ directory: sourceDir, prefix: ".clone-" });
    return yield* Effect.gen(function* () {
      yield* runGit(
        "cloneSource",
        sourceDir,
        [
          "clone",
          "--depth",
          "1",
          "--filter=blob:none",
          "--branch",
          source.ref,
          "--",
          T3CODE_REPOSITORY_URL,
          staging,
        ],
        120_000,
      );
      // main can move between ls-remote and clone, so name the folder by what landed.
      const commit = (yield* runGit("readSourceCommit", staging, ["rev-parse", "HEAD"], 10_000))
        .stdout.trim();
      const directory = path.join(sourceDir, commit);
      yield* fs.rename(staging, directory).pipe(
        // A concurrent session cloned the same commit first; keep theirs.
        Effect.catch((error) =>
          fs
            .exists(directory)
            .pipe(Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(error)))),
        ),
      );
      return { _tag: "cloned", directory, serverVersion, ref: source.ref, commit } as const;
    }).pipe(
      // Gone after a successful rename; otherwise a failed or losing clone.
      Effect.ensuring(fs.remove(staging, { recursive: true }).pipe(Effect.ignore)),
    );
  });

  const prepare: TriageService["Service"]["prepare"] = Effect.fn("TriageService.prepare")(
    function* (input) {
      const sourceClone = yield* cloneSource().pipe(
        Effect.catch((error) =>
          Effect.succeed<TriageSourceClone>({
            _tag: "failed",
            serverVersion,
            reason: error.message,
          }),
        ),
      );
      const session = yield* writeTriageSession({
        baseDir: config.baseDir,
        paths: config,
        entry: { kind: "app", client: describeClient(input.client) },
        server: `running (pid ${String(process.pid)}, version ${serverVersion}); this session runs inside it`,
        sourceClone,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.mapError((cause) => new ServerPrepareTriageError({ cause })),
      );
      return { prompt: buildTriageAppPrompt(session.promptFilePath) };
    },
  );

  return TriageService.of({ prepare });
});

export const layer = Layer.effect(TriageService, make);
