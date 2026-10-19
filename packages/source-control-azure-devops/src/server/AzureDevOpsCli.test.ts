import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import { assert, it, afterEach, describe, expect, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { VcsProcessExitError, VcsProcessSpawnError } from "@t3tools/contracts";

import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";

const processOutput = (stdout: string): SourceControlHost.SourceControlProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const mockRun = vi.fn<SourceControlHost.SourceControlHost["Service"]["process"]["run"]>();

const layerSupport = Layer.mergeAll(
  TestSourceControlHost.layer({
    process: {
      run: (input) =>
        input.command === "git" ? Effect.succeed(processOutput("")) : mockRun(input),
    },
  }),
  NodeServices.layer,
);
const layer = Layer.mergeAll(AzureDevOpsCli.layer.pipe(Layer.provide(layerSupport)), layerSupport);

afterEach(() => {
  mockRun.mockReset();
});

const gitRepositoryBindings = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
] as const;

const checkoutFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-azure-cli-" });
  const cleanEnv = { ...process.env };
  for (const key of gitRepositoryBindings) delete cleanEnv[key];
  const calls: SourceControlHost.SourceControlProcessInput[] = [];
  const runGit = Effect.fnUntraced(function* (input: SourceControlHost.SourceControlProcessInput) {
    const result = yield* Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make("git", input.args, {
          cwd: input.spawnCwd ?? input.cwd,
          env: {
            ...process.env,
            ...input.env,
            GIT_CONFIG_GLOBAL: NodeOS.devNull,
            GIT_CONFIG_NOSYSTEM: "1",
          },
          extendEnv: false,
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          child.stdout.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          ),
          child.stderr.pipe(
            Stream.decodeText(),
            Stream.runFold(
              () => "",
              (a, b) => a + b,
            ),
          ),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { ...processOutput(stdout), stderr, exitCode };
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) => new VcsProcessSpawnError({ ...input, cause })),
    );
    if (result.exitCode !== 0 && !input.allowNonZeroExit) {
      return yield* new VcsProcessExitError({
        ...input,
        exitCode: result.exitCode,
        detail: result.stderr,
      });
    }
    return result;
  });
  const git = (...args: string[]) =>
    runGit({
      operation: "test",
      command: "git",
      cwd,
      args,
      env: {
        ...Object.fromEntries(gitRepositoryBindings.map((key) => [key, undefined])),
        ...cleanEnv,
      },
    });
  yield* git("init", "--quiet");
  const run: SourceControlHost.SourceControlHost["Service"]["process"]["run"] = Effect.fnUntraced(
    function* (input) {
      calls.push(input);
      if (input.command === "az") return processOutput("[]");
      assert.strictEqual(input.command, "git");
      return yield* runGit(input);
    },
  );
  const az = yield* AzureDevOpsCli.AzureDevOpsCli.pipe(
    Effect.provide(
      AzureDevOpsCli.layer.pipe(Layer.provide(TestSourceControlHost.layer({ process: { run } }))),
    ),
  );
  const execute = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    yield* az.execute({ cwd, args });
    const call = calls.at(-1);
    assert.isDefined(call);
    assert.strictEqual(call.command, "az");
    return call.args;
  });
  return { cwd, git, calls, execute, path };
});

describe("AzureDevOpsCli.layer", () => {
  it.effect("scopes repository and PR commands without adding unsupported arguments", () =>
    Effect.gen(function* () {
      const { git, execute } = yield* checkoutFixture;
      yield* git("remote", "add", "origin", "https://dev.azure.com/acme/Project/_git/Repo");
      for (const [command, scope] of [
        [
          ["repos", "show"],
          ["--project", "Project", "--repository", "Repo"],
        ],
        [
          ["repos", "create", "--name", "New"],
          ["--project", "Project"],
        ],
        [
          ["repos", "pr", "list", "-o", "json"],
          ["--project", "Project", "--repository", "Repo"],
        ],
        [
          ["repos", "pr", "create", "--title", "Change"],
          ["--project", "Project", "--repository", "Repo"],
        ],
        [["repos", "pr", "show", "--id", "42"], []],
        [["repos", "pr", "update", "--id", "42"], []],
        [["repos", "pr", "checkout", "--id", "42"], []],
        [["devops", "invoke", "--area", "git"], []],
      ] as const) {
        const actual = yield* execute([...command, "--detect", "true"]);
        const expected = [
          ...command,
          "--detect",
          "false",
          "--organization",
          "https://dev.azure.com/acme",
          ...scope,
        ];
        expect(actual).toEqual(expect.arrayContaining(expected));
        expect(actual).toHaveLength(expected.length);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("uses modern and legacy HTTPS and SSH checkout URLs in the CLI executor", () =>
    Effect.gen(function* () {
      const { git, execute } = yield* checkoutFixture;
      yield* git("remote", "add", "origin", "https://dev.azure.com/placeholder/Project/_git/Repo");
      for (const [remote, organization] of [
        ["https://dev.azure.com/acme/My%20Project/_git/My%20Repo", "https://dev.azure.com/acme"],
        [
          "https://user@dev.azure.com/acme/My%20Project/_git/My%20Repo",
          "https://dev.azure.com/acme",
        ],
        [
          "https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/My%20Repo",
          "https://acme.visualstudio.com",
        ],
        [
          "https://acme.visualstudio.com/My%20Project/_git/My%20Repo",
          "https://acme.visualstudio.com",
        ],
        ["git@ssh.dev.azure.com:v3/acme/My%20Project/My%20Repo", "https://dev.azure.com/acme"],
        [
          "ssh://git@ssh.dev.azure.com:22/v3/acme/My%20Project/My%20Repo",
          "https://dev.azure.com/acme",
        ],
        [
          "git@vs-ssh.visualstudio.com:v3/acme/My%20Project/My%20Repo",
          "https://acme.visualstudio.com",
        ],
      ] as const) {
        yield* git("remote", "set-url", "origin", remote);
        const args = yield* execute(["repos", "show", "--detect", "true"]);
        expect(args).toEqual(
          expect.arrayContaining([
            "--detect",
            "false",
            "--organization",
            organization,
            "--project",
            "My Project",
            "--repository",
            "My Repo",
          ]),
        );
        expect(args).not.toContain("true");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps scope aligned with primary remote order and explicit checkout selection", () =>
    Effect.gen(function* () {
      const { git, execute } = yield* checkoutFixture;
      for (const name of ["zebra", "alpha", "origin", "upstream"]) {
        yield* git(
          "remote",
          "add",
          name,
          `https://dev.azure.com/${name}/${name}-project/_git/${name}-repo`,
        );
      }
      const checkout = yield* execute([
        "repos",
        "pr",
        "checkout",
        "--id",
        "42",
        "--remote-name",
        "origin",
        "--detect",
        "true",
      ]);
      expect(checkout).toEqual(
        expect.arrayContaining(["--organization", "https://dev.azure.com/origin"]),
      );
      expect(checkout).not.toContain("--project");
      expect(checkout).not.toContain("--repository");
      for (const name of ["upstream", "origin", "alpha"]) {
        const args = yield* execute(["repos", "show", "--detect", "true"]);
        expect(args).toEqual(
          expect.arrayContaining([
            "--organization",
            `https://dev.azure.com/${name}`,
            "--project",
            `${name}-project`,
            "--repository",
            `${name}-repo`,
          ]),
        );
        yield* git("remote", "remove", name);
      }
      yield* git(
        "remote",
        "set-url",
        "--push",
        "zebra",
        "https://dev.azure.com/push/Wrong/_git/Wrong",
      );
      for (const [remote, prefix] of [
        ["ado:Project/_git/Repo", "ado:"],
        ["https://dev.azure.com/raw/Project/_git/Repo", "https://dev.azure.com/raw/"],
      ] as const) {
        yield* git("remote", "set-url", "zebra", remote);
        yield* git("config", "url.https://dev.azure.com/effective/.insteadOf", prefix);
        const args = yield* execute(["repos", "show", "--detect", "true"]);
        expect(args).toEqual([
          "repos",
          "show",
          "--detect",
          "false",
          "--organization",
          "https://dev.azure.com/effective",
          "--project",
          "Project",
          "--repository",
          "Repo",
        ]);
        yield* git("config", "--unset", "url.https://dev.azure.com/effective/.insteadOf");
      }
      const restored = yield* execute(["repos", "show", "--detect", "true"]);
      expect(restored).toContain("https://dev.azure.com/raw");
      expect(restored).not.toContain("https://dev.azure.com/effective");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("preserves explicit project and repository flags while supplying organization", () =>
    Effect.gen(function* () {
      const { git, execute } = yield* checkoutFixture;
      yield* git("remote", "add", "origin", "https://dev.azure.com/acme/Detected/_git/Detected");
      for (const selection of [
        ["--project", "Chosen Project", "--repository", "Chosen Repo"],
        ["-p", "Chosen Project", "-r", "Chosen Repo"],
      ]) {
        const args = yield* execute(["repos", "pr", "create", ...selection, "--detect", "true"]);
        const expected = [
          "repos",
          "pr",
          "create",
          ...selection,
          "--detect",
          "false",
          "--organization",
          "https://dev.azure.com/acme",
        ];
        expect(args).toEqual(expect.arrayContaining(expected));
        expect(args).toHaveLength(expected.length);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips discovery without detect true or with an explicit organization", () =>
    Effect.gen(function* () {
      const { execute, calls } = yield* checkoutFixture;
      for (const args of [
        ["account", "show"],
        ["repos", "show"],
        ["repos", "show", "--detect", "false"],
        ["repos", "show", "--detect", "true", "--organization", "https://dev.azure.com/explicit"],
        ["repos", "show", "--detect", "true", "--org", "https://dev.azure.com/explicit"],
      ]) {
        expect(yield* execute(args)).toEqual(args);
      }
      expect(calls).toHaveLength(5);
      expect(calls.every((call) => call.command === "az")).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves detection to az when Git or the selected remote cannot supply scope", () =>
    Effect.gen(function* () {
      const { git, execute, cwd, path } = yield* checkoutFixture;
      const fs = yield* FileSystem.FileSystem;
      const args = ["repos", "show", "--detect", "true"];
      expect(yield* execute(args)).toEqual(args);
      yield* git("remote", "add", "origin", "https://dev.azure.com/acme/Project/_git/Repo");
      const missing = [...args, "--remote-name", "missing"];
      expect(yield* execute(missing)).toEqual(missing);
      yield* git("remote", "add", "upstream", "https://github.com/acme/repo");
      expect(yield* execute(args)).toEqual(args);
      yield* git("remote", "remove", "upstream");
      for (const url of [
        "https://github.com/acme/repo",
        "https://dev.azure.com/acme",
        "https://dev.azure.com/acme/%XX/_git/Repo",
        "git@ssh.dev.azure.com:v4/acme/Project/Repo",
        "git@vs-ssh.visualstudio.com:v3/acme.invalid/Project/Repo",
      ]) {
        yield* git("remote", "set-url", "origin", url);
        expect(yield* execute(args)).toEqual(args);
      }
      yield* fs.remove(path.join(cwd, ".git"), { recursive: true });
      expect(yield* execute(args)).toEqual(args);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "discovers the requested checkout despite inherited bindings to another Git repository",
    () =>
      Effect.gen(function* () {
        const target = yield* checkoutFixture;
        const unrelated = yield* checkoutFixture;
        yield* target.git(
          "remote",
          "add",
          "origin",
          "https://dev.azure.com/target/Project/_git/Repo",
        );
        yield* unrelated.git(
          "remote",
          "add",
          "origin",
          "https://dev.azure.com/unrelated/Other/_git/Wrong",
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const gitDir = unrelated.path.join(unrelated.cwd, ".git");
        for (const [key, value] of Object.entries({
          GIT_DIR: gitDir,
          GIT_WORK_TREE: unrelated.cwd,
          GIT_COMMON_DIR: gitDir,
          GIT_INDEX_FILE: unrelated.path.join(gitDir, "index"),
          GIT_OBJECT_DIRECTORY: unrelated.path.join(gitDir, "objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: unrelated.path.join(gitDir, "objects"),
        }))
          vi.stubEnv(key, value);
        const args = yield* target.execute(["repos", "pr", "list", "--detect", "true"]);
        expect(args).toEqual(
          expect.arrayContaining([
            "--detect",
            "false",
            "--organization",
            "https://dev.azure.com/target",
            "--project",
            "Project",
            "--repository",
            "Repo",
          ]),
        );
        expect(args).not.toContain("https://dev.azure.com/unrelated");
        const discovery = target.calls.filter((call) => call.command === "git");
        expect(discovery.length).toBeGreaterThan(0);
        for (const call of discovery) {
          const env = { ...process.env, ...call.env };
          for (const key of gitRepositoryBindings) expect(env[key]).toBeUndefined();
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("parses pull request view output", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 42,
              title: "Add Azure provider",
              sourceRefName: "refs/heads/feature/source-control",
              targetRefName: "refs/heads/main",
              status: "active",
              creationDate: "2026-01-02T00:00:00.000Z",
              closedDate: null,
              _links: {
                web: {
                  href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
                },
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "#42",
      });

      assert.strictEqual(result.number, 42);
      assert.strictEqual(result.title, "Add Azure provider");
      assert.strictEqual(result.url, "https://dev.azure.com/acme/project/_git/repo/pullrequest/42");
      assert.strictEqual(result.baseRefName, "main");
      assert.strictEqual(result.headRefName, "feature/source-control");
      assert.strictEqual(result.state, "open");
      assert.deepStrictEqual(result.updatedAt._tag, Option.some(1)._tag);
      assert.deepStrictEqual(mockRun.mock.calls.at(-1)?.[0], {
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "show",
          "--detect",
          "true",
          "--id",
          "42",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
      assert.strictEqual(result.isCrossRepository, false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("marks a pull request from a fork as cross-repository", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 43,
              title: "From a fork",
              sourceRefName: "refs/heads/main",
              targetRefName: "refs/heads/main",
              status: "active",
              forkSource: { name: "refs/heads/main", repository: { name: "repo-fork" } },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({ cwd: "/repo", reference: "43" });

      assert.strictEqual(result.isCrossRepository, true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("builds a web URL when Azure returns only the pull request REST URL", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              pullRequestId: 863,
              title: "Fix Azure link",
              url: "https://dev.azure.com/saplyai/a8fe4088-ad76-4eda-aaaa-e3329713a097/_apis/git/repositories/16108a25-93a3-4eff-b77d-85e894ee0fe4/pullRequests/863",
              repository: {
                name: "CV-engine",
                project: {
                  name: "CV-engine",
                },
              },
              sourceRefName: "refs/heads/feature/azure-pr-link",
              targetRefName: "refs/heads/main",
              status: "active",
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getPullRequest({
        cwd: "/repo",
        reference: "863",
      });

      assert.strictEqual(
        result.url,
        "https://dev.azure.com/saplyai/CV-engine/_git/CV-engine/pullrequest/863",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists pull requests with Azure status and source branch arguments", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify([
              {
                pullRequestId: 7,
                title: "Merged work",
                sourceRefName: "refs/heads/feature/merged",
                targetRefName: "refs/heads/main",
                status: "completed",
                closedDate: "2026-01-03T00:00:00.000Z",
                _links: {
                  web: {
                    href: "https://dev.azure.com/acme/project/_git/repo/pullrequest/7",
                  },
                },
              },
            ]),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.listPullRequests({
        cwd: "/repo",
        headSelector: "origin:feature/merged",
        state: "merged",
        limit: 10,
      });

      assert.strictEqual(result[0]?.state, "merged");
      assert.strictEqual(result[0]?.mergedAt, "2026-01-03T00:00:00.000Z");
      assert.strictEqual(result[0]?.closedAt, null);
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "list",
          "--detect",
          "true",
          "--source-branch",
          "feature/merged",
          "--status",
          "completed",
          "--top",
          "10",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reads repository clone URLs", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "repo",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates repositories through Azure Repos", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            JSON.stringify({
              name: "repo",
              webUrl: "https://dev.azure.com/acme/project/_git/repo",
              remoteUrl: "https://dev.azure.com/acme/project/_git/repo",
              sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
              project: {
                name: "project",
              },
            }),
          ),
        ),
      );

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const result = yield* az.createRepository({
        cwd: "/repo",
        repository: "project/repo",
        visibility: "private",
      });

      assert.deepStrictEqual(result, {
        nameWithOwner: "project/repo",
        url: "https://dev.azure.com/acme/project/_git/repo",
        sshUrl: "git@ssh.dev.azure.com:v3/acme/project/repo",
      });
      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "create",
          "--detect",
          "true",
          "--name",
          "repo",
          "--project",
          "project",
          "--only-show-errors",
          "--output",
          "json",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("creates pull requests using the body file as the Azure description", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const bodyFile = `/tmp/t3code-azure-devops-cli-.md`;
      yield* fileSystem.writeFileString(bodyFile, "Generated body");
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("{}")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.createPullRequest({
        cwd: "/repo",
        baseBranch: "main",
        headSelector: "feature/provider",
        title: "Provider PR",
        bodyFile,
      });

      expect(mockRun).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "az",
          cwd: "/repo",
          args: expect.arrayContaining(["--description", `@${bodyFile}`]),
        }),
      );
      expect(mockRun.mock.calls[0]?.[0].args).not.toContain("--output");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not force JSON output on checkout side-effect commands", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.checkoutPullRequest({
        cwd: "/repo",
        reference: "42",
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: [
          "repos",
          "pr",
          "checkout",
          "--only-show-errors",
          "--detect",
          "true",
          "--id",
          "42",
          "--remote-name",
          "origin",
        ],
        cwd: "/repo",
        timeoutMs: 30_000,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("forwards explicit output limits to the process boundary", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      yield* az.execute({
        cwd: "/repo",
        args: ["repos", "pr", "list"],
        maxOutputBytes: 16 * 1024 * 1024,
      });

      expect(mockRun).toHaveBeenCalledWith({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        args: ["repos", "pr", "list"],
        cwd: "/repo",
        timeoutMs: 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves VCS causes without copying upstream details into messages", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az repos list --organization sensitive-upstream-detail",
        cwd: "/repo",
        exitCode: 1,
        detail: "sensitive-upstream-detail",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.operation, "execute");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.argumentCount, 2);
      assert.strictEqual(error.detail, "Azure DevOps CLI command failed.");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message.includes("sensitive-upstream-detail"), false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("does not report a missing working directory as a missing Azure CLI", () =>
    Effect.gen(function* () {
      const cwd = "/missing/repo";
      const platformCause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        syscall: "chdir",
        pathOrDescriptor: cwd,
      });
      const cause = new VcsProcessSpawnError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd,
        argumentCount: 2,
        cause: platformCause,
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd, args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCommandFailedError);
      assert.strictEqual(error.cwd, cwd);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps invalid pull request output diagnostics structured", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("not-json")));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.getPullRequest({ cwd: "/repo", reference: "42" }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsPullRequestDecodeError);
      assert.strictEqual(error.operation, "getPullRequest");
      assert.strictEqual(error.command, "az");
      assert.strictEqual(error.cwd, "/repo");
      assert.strictEqual(error.outputLength, 8);
      assert.strictEqual(error.detail, "Azure DevOps CLI returned invalid pull request JSON.");
      assert.exists(error.cause);
      assert.strictEqual(
        error.message,
        "Azure DevOps CLI failed in getPullRequest: Azure DevOps CLI returned invalid pull request JSON.",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("preserves rate-limit failures as a distinct error", () =>
    Effect.gen(function* () {
      const cause = new VcsProcessExitError({
        operation: "AzureDevOpsCli.execute",
        command: "az",
        cwd: "/repo",
        argumentCount: 2,
        exitCode: 1,
        detail: "API rate limit exceeded.",
        failureKind: "rate-limited",
      });
      mockRun.mockReturnValueOnce(Effect.fail(cause));

      const az = yield* AzureDevOpsCli.AzureDevOpsCli;
      const error = yield* az.execute({ cwd: "/repo", args: ["repos", "list"] }).pipe(Effect.flip);

      assert.instanceOf(error, AzureDevOpsCli.AzureDevOpsCliRateLimitError);
      assert.strictEqual(error.cause, cause);
    }).pipe(Effect.provide(layer)),
  );
});
