import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as UpdateWindow from "../updates/UpdateWindow.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "./Scheduler.ts";

it.effect.each(["on time", "after restart"])(
  "runs Scheduled Tasks and a persisted limit retry through the same scheduler %s",
  (scenario) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { seconds: 60 }));
      const thread: OrchestrationV2ThreadShell = {
        id: ThreadId.make("thread:limited"),
        projectId: ProjectId.make("project:test"),
        title: "Limited",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
        branch: null,
        worktreePath: null,
        lineage: {
          rootThreadId: ThreadId.make("thread:limited"),
          parentThreadId: null,
          relationshipToParent: null,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        latestRunId: RunId.make("run:limited"),
        latestRunCompletedAt: now,
        activeRunId: null,
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: resetAt,
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: now,
        hasActionableProposedPlan: false,
        itemCount: 1,
        visibleItemCount: 1,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        pinnedAt: null,
        deletedAt: null,
        limitRecovery: {
          runId: RunId.make("run:limited"),
          resetAt,
          autoResume: true,
          requestId: CommandId.make("recovery:choice"),
        },
      };
      if (scenario === "after restart") {
        yield* TestClock.adjust("65 seconds");
      }
      const current = yield* Ref.make(thread);
      const commands = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
      const receipts = yield* Queue.unbounded<"task" | "retry">();
      const layerDependencies = Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () =>
            Queue.offer(receipts, "task").pipe(
              Effect.andThen(Effect.die("fixture dispatch failure")),
            ),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch: (command) =>
            Ref.update(commands, (all) => [...all, command]).pipe(
              Effect.andThen(
                Ref.update(current, (shell) => ({ ...shell, status: "running" as const })),
              ),
              Effect.andThen(Queue.offer(receipts, "retry")),
              Effect.as({ sequence: 1, storedEvents: [] }),
            ),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getLimitRecoveryCandidates: () =>
            Ref.get(current).pipe(
              Effect.map((shell) => (shell.status === "failed" ? [shell] : [])),
            ),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );
      const layerWorkers = Layer.mergeAll(
        ScheduledTasks.layer,
        UsageLimitRecoveryWorker.layer,
      ).pipe(Layer.provide(layerDependencies), Layer.provide(Scheduler.layer));
      yield* Effect.gen(function* () {
        const tasks = yield* ScheduledTasks.ScheduledTaskService;
        const { task } = yield* tasks.upsert({
          title: "Scheduled work",
          prompt: "Run scheduled work",
          enabled: true,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: thread.projectId,
          workspaceStrategy: { type: "root" },
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE scheduled_tasks SET next_run_at = ${resetAt} WHERE task_id = ${task.id}`;
        if (scenario === "on time") {
          yield* TestClock.adjust("55 seconds");
          assert.deepEqual(yield* Ref.get(commands), []);
        }
        yield* TestClock.adjust("5 seconds");
        assert.deepEqual([yield* Queue.take(receipts), yield* Queue.take(receipts)].sort(), [
          "retry",
          "task",
        ]);
        const delivered = yield* Ref.get(commands);
        assert.equal(delivered.length, 1);
        expect(delivered[0]).toMatchObject({
          type: "message.dispatch",
          usageLimitContinuationOfRunId: thread.latestRunId,
          usageLimitRecoveryRequestId: thread.limitRecovery!.requestId,
          text: "Continue where you left off.",
        });
      }).pipe(Effect.provide(layerWorkers));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect.each([
  ["exact five-minute horizon", 15 * 60_000, 5 * 60_000, true, "succeeded", false],
  ["one millisecond beyond horizon", 15 * 60_000, 5 * 60_000 + 1, true, "succeeded", true],
  ["interval just under fifteen minutes", 15 * 60_000 - 1, 60_000, true, "succeeded", true],
  ["interval exactly fifteen minutes", 15 * 60_000, 60_000, true, "succeeded", false],
  ["disabled due task", 15 * 60_000, 60_000, false, "succeeded", true],
  ["disabled running task", 60_000, 60_000, false, "running", false],
  ["frequent running task", 60_000, 60_000, true, "running", false],
  ["accepted webhook waiting for dispatch", 0, 0, true, "never", false],
  ["paused webhook waiting for dispatch", 0, 0, false, "never", true],
] as const)("update window handles %s", ([, everyMs, dueIn, enabled, status, open]) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const sql = yield* SqlClient.SqlClient;
    const timestamp = DateTime.formatIso(now);
    yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
      task_id: "task:window",
      title: "Work",
      prompt: "Run",
      enabled: enabled ? 1 : 0,
      schedule_json: JSON.stringify(
        everyMs === 0 ? { type: "webhook", signature: null } : { type: "interval", everyMs },
      ),
      project_id: "project:test",
      thread_id: null,
      workspace_strategy_json: '{"type":"root"}',
      model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
      runtime_mode: "full-access",
      interaction_mode: "default",
      created_by: "user",
      creation_source: "web",
      created_at: timestamp,
      updated_at: timestamp,
      next_run_at:
        everyMs === 0 ? null : DateTime.formatIso(DateTime.add(now, { milliseconds: dueIn })),
      last_run_at: timestamp,
      last_run_status: status,
      last_run_error: null,
      run_count: 1,
    })}`;
    if (everyMs === 0)
      yield* sql`INSERT INTO scheduled_task_webhook_queue (delivery_id, task_id, task_created_at, prompt)
      VALUES ('pending', 'task:window', ${timestamp}, 'Handle body')`;
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRecoveryThreadIds: () => Effect.succeed([]),
        getLimitRecoveryCandidates: () => Effect.succeed([]),
      }),
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        hasPendingBackgroundWork: Effect.succeed(false),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        sinceLastClientInteraction: Effect.succeed(Duration.minutes(15)),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(CodexInstallation.CodexInstallation)({ managedDirectory: "/tmp/codex" }),
      Layer.mock(AntigravityInstallation.AntigravityInstallation)({
        managedDirectory: "/tmp/antigravity",
      }),
    );
    const result = yield* Effect.gen(function* () {
      const window = yield* UpdateWindow.UpdateWindow;
      return yield* window.runIfOpen(Effect.succeed("installed"));
    }).pipe(Effect.provide(UpdateWindow.layer.pipe(Layer.provide(dependencies))));
    assert.equal(Option.isSome(result), open);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
