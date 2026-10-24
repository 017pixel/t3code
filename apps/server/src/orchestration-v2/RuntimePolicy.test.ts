import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const projectId = ProjectId.make("project:runtime-policy");
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.5",
} satisfies ModelSelection;

function makeThread(input: {
  readonly now: DateTime.Utc;
  readonly worktreePath: string | null;
  readonly runtimeMode?: RuntimeMode;
}): OrchestrationV2AppThread {
  const threadId = ThreadId.make("thread:runtime-policy");
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Runtime policy",
    providerInstanceId,
    modelSelection,
    runtimeMode: input.runtimeMode ?? "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const grokInstanceId = ProviderInstanceId.make("grok");
const supportedRuntimeModesByInstance = new Map<ProviderInstanceId, ReadonlyArray<RuntimeMode>>([
  [grokInstanceId, ["approval-required", "auto", "full-access"]],
]);
const providerInstanceFor = (instanceId: ProviderInstanceId) =>
  ({
    snapshot: {
      getSnapshot: Effect.succeed({
        supportedRuntimeModes: supportedRuntimeModesByInstance.get(instanceId),
      } as ServerProvider),
    },
  }) as ProviderInstance;

const layerWithProjectRoot = (workspaceRoot: string) =>
  RuntimePolicy.layerFromProjectStore.pipe(
    Layer.provide(
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (instanceId) => Effect.succeed(providerInstanceFor(instanceId)),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectStore.ProjectStoreV2)({
        get: () =>
          Effect.succeed(
            Option.some({
              projectId,
              title: "Project",
              workspaceRoot,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-21T00:00:00.000Z",
              updatedAt: "2026-06-21T00:00:00.000Z",
              deletedAt: null,
            }),
          ),
      }),
    ),
  );

const layerTest = layerWithProjectRoot("/project-root");

it.layer(layerTest)("RuntimePolicyV2", (it) => {
  it.effect("runs a mode the provider does not offer in Supervised", () =>
    Effect.gen(function* () {
      const policy = yield* RuntimePolicy.RuntimePolicyV2;
      const now = yield* DateTime.now;
      const modeFor = (instanceId: ProviderInstanceId, runtimeMode: RuntimeMode) =>
        policy
          .resolve({
            thread: makeThread({ now, worktreePath: null, runtimeMode }),
            modelSelection: { instanceId, model: "test-model" },
          })
          .pipe(Effect.map((resolved) => resolved.runtimeMode));

      assert.equal(yield* modeFor(grokInstanceId, "auto-accept-edits"), "approval-required");
      assert.equal(yield* modeFor(grokInstanceId, "auto"), "auto");
      assert.equal(yield* modeFor(grokInstanceId, "full-access"), "full-access");
      assert.equal(yield* modeFor(providerInstanceId, "auto-accept-edits"), "auto-accept-edits");
    }),
  );
});

// A project rooted in a repository subdirectory, with a thread in a worktree of that repository.
function makeSubdirectoryProjectRepo() {
  const base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "runtime-policy-subdir-")),
  );
  const repoRoot = NodePath.join(base, "repo");
  const worktreePath = NodePath.join(base, "worktree");
  NodeFS.mkdirSync(NodePath.join(repoRoot, "ios"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repoRoot, "ios", "README.md"), "ios\n");
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", ["-C", repoRoot, ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init");
  git("worktree", "add", "-q", "-b", "t3-subdir", worktreePath);
  return { projectRoot: NodePath.join(repoRoot, "ios"), worktreePath };
}

const subdirectoryRepo = makeSubdirectoryProjectRepo();

it.layer(layerWithProjectRoot(subdirectoryRepo.projectRoot))(
  "RuntimePolicyV2 for a project in a repository subdirectory",
  (it) => {
    it.effect("starts worktree threads in the same subdirectory of the worktree", () =>
      Effect.gen(function* () {
        const policy = yield* RuntimePolicy.RuntimePolicyV2;
        const now = yield* DateTime.now;
        const resolved = yield* policy.resolve({
          thread: makeThread({ now, worktreePath: subdirectoryRepo.worktreePath }),
          modelSelection,
        });

        assert.equal(resolved.cwd, NodePath.join(subdirectoryRepo.worktreePath, "ios"));
      }),
    );
  },
);
