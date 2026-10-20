import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  WS_METHODS,
  type AuthSessionState,
  CommandId,
  MessageId,
  RuntimeRequestId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadHandoff,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import * as ThreadCommands from "./threadCommands.ts";
import { createThreadHandoffEnvironmentAtoms } from "./threadHandoff.ts";
import * as HandoffAction from "../../../../apps/web/src/components/threadHandoffAction.ts";
import { EnvironmentRpcRequestObserver, type EnvironmentRpcInput } from "../rpc/client.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const NOW = DateTime.makeUnsafe("2026-09-12T10:00:00.000Z");
const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");
const APPROVAL = {
  id: RuntimeRequestId.make("approval"),
  kind: "command" as const,
  createdAt: NOW,
};
const USER_INPUT = {
  id: RuntimeRequestId.make("input"),
  kind: "user_input" as const,
  createdAt: NOW,
};
const SNAPSHOT: OrchestrationV2ShellSnapshot = {
  snapshotSequence: 1,
  schemaVersion: 2,
  archivedThreads: [],
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Remote thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      deletedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
};

const makeHarness = Effect.fn("TestThreadCommands.makeHarness")(function* (
  replyImmediately = false,
) {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.gen(function* () {
              const reply = yield* Deferred.make<{ sequence: number }, Error>();
              yield* Queue.offer(requests, { command, reply });
              if (replyImmediately) yield* Deferred.succeed(reply, { sequence: 2 });
              return yield* Deferred.await(reply);
            }),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) => Atom.make(SNAPSHOT));
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  return { registry, commands, snapshotAtom, visibleAtom, requests };
});

describe("remote thread lifecycle commands", () => {
  const actions = [
    ["settle", {}, { settledOverride: "settled", pinnedAt: null, snoozedUntil: null }],
    ["unsettle", { reason: "user" }, { settledOverride: "active", settledAt: null }],
    ["snooze", { snoozedUntil: "2099-01-01T00:00:00.000Z" }, { snoozedUntil: FUTURE }],
    ["unsnooze", { reason: "user" }, { snoozedUntil: null, snoozedAt: null }],
    ["pin", { orderKey: "a" }, { pinnedAt: expect.any(Object), pinOrderKey: "a" }],
    ["unpin", {}, { pinnedAt: null, pinOrderKey: null }],
    ["setAutoSettle", { enabled: false }, { autoSettleDisabledAt: expect.any(Object) }],
    ["reorderPin", { orderKey: "b" }, { pinOrderKey: "b" }],
    ["reorderActive", { orderKey: "b" }, { activeOrderKey: "b" }],
  ] as const;

  it.effect.each(actions)(
    "shows %s before a delayed remote reply and rolls back a rejection",
    ([action, input, expected]) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const source = h.snapshotAtom(ENVIRONMENT_ID);
        const initial = {
          ...SNAPSHOT,
          threads: [
            {
              ...SNAPSHOT.threads[0]!,
              ...(action === "unsettle" || action === "pin"
                ? { settledOverride: "settled" as const, settledAt: NOW }
                : {}),
              ...(action === "unsnooze" || action === "settle" || action === "pin"
                ? { snoozedUntil: FUTURE, snoozedAt: NOW }
                : {}),
              ...(action === "unpin" || action === "settle"
                ? { pinnedAt: NOW, pinOrderKey: "a" }
                : {}),
            },
          ],
        };
        h.registry.set(source, initial);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            commandId: CommandId.make(action),
            reason: "user",
            enabled: false,
            orderKey: "a",
            snoozedUntil: "2099-01-01T00:00:00.000Z",
            ...input,
          },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(expected);
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(source)).toBe(initial);
        yield* Deferred.fail(request.reply, new Error("Remote rejected the action"));
        expect((yield* Effect.promise(() => result))._tag).toBe("Failure");
        expect(h.registry.get(h.visibleAtom)).toBe(initial);
      }),
  );

  it.effect("restamps snoozedAt when re-snoozing to the same wake time", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const earlierSnoozedAt = DateTime.makeUnsafe("2000-01-01T00:00:00.000Z");
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, snoozedUntil: FUTURE, snoozedAt: earlierSnoozedAt }],
      });
      const result = h.commands.snooze.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: DateTime.formatIso(FUTURE) },
      });
      const snoozedAt = h.registry.get(h.visibleAtom)?.threads[0]?.snoozedAt;
      expect(DateTime.toEpochMillis(snoozedAt!)).toBeGreaterThan(
        DateTime.toEpochMillis(earlierSnoozedAt),
      );
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
    }),
  );

  it.effect("keeps the preview after acknowledgement until the matching shell update arrives", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      yield* Deferred.succeed(request.reply, { sequence: 3 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      const changed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, title: "Renamed remotely" }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), changed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({
        title: "Renamed remotely",
        settledOverride: "settled",
      });
      const confirmed = {
        ...changed,
        snapshotSequence: 3,
        threads: [
          {
            ...changed.threads[0]!,
            settledOverride: "settled" as const,
            settledAt: DateTime.makeUnsafe("2026-09-12T12:00:00.000Z"),
          },
        ],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), { ...SNAPSHOT, snapshotSequence: 4 });
      expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBeNull();
    }),
  );

  it.effect(
    "shows a queued reverse action immediately and preserves it if the earlier action fails",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const settle = h.commands.settle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID },
        });
        const first = yield* Queue.take(h.requests);
        const unsettle = h.commands.unsettle.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, reason: "user" },
        });
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        yield* Deferred.fail(first.reply, new Error("Settle rejected"));
        yield* Effect.promise(() => settle);
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.settledOverride).toBe("active");
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.unsettle");
        const confirmed = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "active" as const }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
        yield* Deferred.succeed(second.reply, { sequence: 2 });
        yield* Effect.promise(() => unsettle);
        expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
      }),
  );

  it.effect("isolates environments and does not restore a remotely removed thread", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const otherEnvironment = EnvironmentId.make("other-remote");
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.commands.snapshotAtom(otherEnvironment))).toBe(SNAPSHOT);
      const removed = { ...SNAPSHOT, snapshotSequence: 2, threads: [] };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), removed);
      expect(h.registry.get(h.visibleAtom)?.threads).toEqual([]);
      yield* Deferred.fail(request.reply, new Error("Thread removed"));
      yield* Effect.promise(() => result);
      expect(h.registry.get(h.visibleAtom)).toBe(removed);
    }),
  );

  it.effect("keeps pending approvals visible while a lifecycle request is pending", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const blocked = {
        ...SNAPSHOT,
        threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), blocked);
      const result = h.commands.settle.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID },
      });
      const request = yield* Queue.take(h.requests);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(blocked.threads[0]);
      yield* Deferred.fail(request.reply, new Error("Approval pending"));
      yield* Effect.promise(() => result);
    }),
  );

  const undoableActions = ["settle", "snooze"] as const;

  it.effect.each(undoableActions)("restores a confirmed %s when a queued undo fails", (action) =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const parked =
        action === "settle" ? { settledOverride: "settled" as const } : { snoozedUntil: FUTURE };
      const awake = action === "settle" ? { settledOverride: "active" } : { snoozedUntil: null };
      const result = h.commands[action].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
      });
      const first = yield* Queue.take(h.requests);
      const undo = h.commands[action === "settle" ? "unsettle" : "unsnooze"].run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, reason: "user" },
      });
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      yield* Deferred.succeed(first.reply, { sequence: 2 });
      expect((yield* Effect.promise(() => result))._tag).toBe("Success");
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const confirmed = {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, ...parked }],
      };
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), confirmed);
      expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(awake);
      const second = yield* Queue.take(h.requests);
      expect(second.command.type).toBe(action === "settle" ? "thread.unsettle" : "thread.unsnooze");
      yield* Deferred.fail(second.reply, new Error("Undo rejected"));
      expect((yield* Effect.promise(() => undo))._tag).toBe("Failure");
      expect(h.registry.get(h.visibleAtom)).toBe(confirmed);
    }),
  );

  it.effect.each(undoableActions)(
    "preserves a newer approval when the %s reply arrives after the shell",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        const newer = {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: APPROVAL }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), newer);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(newer.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)).toBe(newer);
      }),
  );

  it.effect.each(undoableActions)(
    "shows an accepted %s while the shell still has an old input request",
    (action) =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const stale = {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, pendingRuntimeRequest: USER_INPUT }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), stale);
        const result = h.commands[action].run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
        });
        const request = yield* Queue.take(h.requests);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toBe(stale.threads[0]);
        yield* Deferred.succeed(request.reply, { sequence: 2 });
        expect((yield* Effect.promise(() => result))._tag).toBe("Success");
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject(
          action === "settle" ? { settledOverride: "settled" } : { snoozedUntil: FUTURE },
        );
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.pendingRuntimeRequest).toBeNull();
        expect(h.registry.get(h.snapshotAtom(ENVIRONMENT_ID))).toBe(stale);
      }),
  );
});

const handoffTarget = {
  handoffId: "move-one",
  environmentId: EnvironmentId.make("destination"),
  projectId: ProjectId.make("destination-project"),
  label: "Destination",
};
const handoffStates: ReadonlyArray<{
  label: string;
  handoff: OrchestrationV2ThreadHandoff | null;
  sendable: boolean;
}> = [
  { label: "no move", handoff: null, sendable: true },
  {
    label: "pending",
    handoff: { ...handoffTarget, state: "pending", requestCommandId: CommandId.make("request") },
    sendable: true,
  },
  { label: "departing", handoff: { ...handoffTarget, state: "departing" }, sendable: false },
  {
    label: "departed",
    handoff: { ...handoffTarget, state: "departed", threadId: ThreadId.make("destination-thread") },
    sendable: false,
  },
  {
    label: "failed",
    handoff: { ...handoffTarget, state: "failed", lastError: "Destination disconnected" },
    sendable: true,
  },
];

describe("thread move commands", () => {
  it("offers Move only for a connected, supported, stopped source without local work", () => {
    const source = SNAPSHOT.threads[0]!;
    const context = { connected: true, supported: true, hasLocalWork: false };
    const canStart = (thread: OrchestrationV2ThreadShell | null, overrides = {}) =>
      ThreadCommands.canStartThreadHandoff({ ...context, ...overrides, thread });

    expect(canStart(source)).toBe(true);
    expect(canStart(null)).toBe(false);
    expect(canStart(source, { connected: false })).toBe(false);
    expect(canStart(source, { supported: false })).toBe(false);
    expect(canStart(source, { hasLocalWork: true })).toBe(false);
    expect(canStart({ ...source, archivedAt: NOW })).toBe(false);
    for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
      expect(canStart({ ...source, status, activeRunId: null }), status).toBe(false);
    }
    for (const creationSource of ["provider", "mcp"] as const) {
      expect(
        canStart({
          ...source,
          creationSource,
          createdBy: "agent",
          lineage: {
            ...source.lineage,
            parentThreadId: ThreadId.make("parent"),
            relationshipToParent: "subagent",
          },
        }),
        creationSource,
      ).toBe(false);
    }
    for (const { label, handoff } of handoffStates) {
      expect(canStart({ ...source, handoff }), label).toBe(
        handoff === null || handoff.state === "failed",
      );
    }
  });

  it.effect.each(handoffStates)(
    "rechecks the source before dispatching a turn ($label)",
    ({ handoff, sendable }) =>
      Effect.gen(function* () {
        const h = yield* makeHarness(true);
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          threads: [{ ...SNAPSHOT.threads[0]!, handoff }],
        });
        const result = yield* Effect.promise(() =>
          h.commands.startTurn.run(h.registry, {
            environmentId: ENVIRONMENT_ID,
            input: {
              threadId: THREAD_ID,
              commandId: CommandId.make("send"),
              dispatchMode: "start",
              runtimeMode: "full-access",
              interactionMode: "default",
              message: {
                messageId: MessageId.make("message"),
                role: "user",
                text: "Keep working here",
                attachments: [],
              },
            },
          }),
        );
        expect(yield* Queue.size(h.requests)).toBe(sendable ? 1 : 0);
        expect(result._tag).toBe(sendable ? "Success" : "Failure");
        expect(h.registry.get(h.visibleAtom)?.threads[0]?.handoff).toEqual(handoff);
      }),
  );
});

const makeHandoffHarness = Effect.fn("TestThreadCommands.makeHandoffHarness")(function* () {
  const gates = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const sent: Array<{ method: string; input: unknown }> = [];
  const record = (method: string, input: unknown) =>
    Effect.sync(() => {
      sent.push({ method, input });
    });
  const supervisor = {
    target: { environmentId: ENVIRONMENT_ID },
    session: yield* SubscriptionRef.make(
      Option.some({
        client: {
          [WS_METHODS.threadHandoffStart]: (
            input: EnvironmentRpcInput<typeof WS_METHODS.threadHandoffStart>,
          ) =>
            record(WS_METHODS.threadHandoffStart, input).pipe(
              Effect.as({ ...handoffTarget, state: "departing" as const }),
            ),
          [WS_METHODS.threadHandoffCancel]: (
            input: EnvironmentRpcInput<typeof WS_METHODS.threadHandoffCancel>,
          ) => record(WS_METHODS.threadHandoffCancel, input).pipe(Effect.as({})),
        },
      } as unknown as RpcSession),
    ),
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(EnvironmentRpcRequestObserver, {
        observe: () =>
          Effect.gen(function* () {
            const release = yield* Deferred.make<void>();
            yield* Queue.offer(gates, release);
            yield* Deferred.await(release);
            return Effect.void;
          }),
      }),
    ),
  );
  const thread = Atom.make<OrchestrationV2ThreadShell | null>(SNAPSHOT.threads[0]!);
  const localWork = Atom.make(false);
  const commands = createThreadHandoffEnvironmentAtoms(runtime, {
    threadAtom: () => thread,
    connectedAtom: () => Atom.make(true),
    supportedAtom: () => Atom.make(true),
    hasLocalWorkAtom: () => localWork,
  });
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const session = sessions(ENVIRONMENT_ID);
  registry.mount(session);
  const grant: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: [AuthOrchestrationOperateScope],
    permissions: [AuthOrchestrationOperateScope],
  };
  registry.set(session, AsyncResult.success(grant));
  return { registry, commands, thread, localWork, gates, sent, session, grant };
});

describe("handoff dispatch boundaries", () => {
  it.effect("moves full-access linked threads but fences origins without recorded access", () =>
    Effect.gen(function* () {
      const h = yield* makeHandoffHarness();
      const ref = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
      const input = { threadId: THREAD_ID, environmentId: handoffTarget.environmentId };
      const linkOrigin = { sessionId: "linked-session", label: "Linked source" };
      yield* Queue.take(h.gates).pipe(
        Effect.flatMap((gate) => Deferred.succeed(gate, undefined)),
        Effect.forever,
        Effect.forkChild,
      );

      h.registry.set(h.thread, {
        ...SNAPSHOT.threads[0]!,
        linkOrigin: { ...linkOrigin, access: "full-access" },
      });
      expect(h.registry.get(h.commands.availableAtom(ref))).toBe(true);
      const accepted = yield* Effect.promise(() =>
        h.commands.start.run(h.registry, { environmentId: ENVIRONMENT_ID, input }),
      );
      expect(accepted._tag).toBe("Success");
      expect(h.sent).toEqual([{ method: WS_METHODS.threadHandoffStart, input }]);

      h.registry.set(h.thread, { ...SNAPSHOT.threads[0]!, linkOrigin });
      const available = h.registry.get(h.commands.availableAtom(ref));
      const denied = yield* Effect.promise(() =>
        h.commands.start.run(h.registry, { environmentId: ENVIRONMENT_ID, input }),
      );
      expect({ available, result: denied._tag, sent: h.sent }).toEqual({
        available: false,
        result: "Failure",
        sent: [{ method: WS_METHODS.threadHandoffStart, input }],
      });
    }),
  );

  it.effect(
    "revalidates local work and the source shell after preparation, then sends only current wire input",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHandoffHarness();
        const ref = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
        const input = {
          threadId: THREAD_ID,
          environmentId: handoffTarget.environmentId,
          projectId: handoffTarget.projectId,
          isCurrent: () => true,
        };
        expect(h.registry.get(h.commands.availableAtom(ref))).toBe(true);
        const queued = h.commands.start.run(h.registry, { environmentId: ENVIRONMENT_ID, input });
        const queueGate = yield* Queue.take(h.gates);
        h.registry.set(h.localWork, true);
        expect(h.registry.get(h.commands.availableAtom(ref))).toBe(false);
        yield* Deferred.succeed(queueGate, undefined);
        expect((yield* Effect.promise(() => queued))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);

        h.registry.set(h.localWork, false);
        const running = h.commands.start.run(h.registry, { environmentId: ENVIRONMENT_ID, input });
        const runGate = yield* Queue.take(h.gates);
        h.registry.set(h.thread, { ...SNAPSHOT.threads[0]!, status: "running" });
        yield* Deferred.succeed(runGate, undefined);
        expect((yield* Effect.promise(() => running))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);

        h.registry.set(h.thread, SNAPSHOT.threads[0]!);
        const valid = h.commands.start.run(h.registry, { environmentId: ENVIRONMENT_ID, input });
        yield* Deferred.succeed(yield* Queue.take(h.gates), undefined);
        expect((yield* Effect.promise(() => valid))._tag).toBe("Success");
        expect(h.sent).toEqual([
          {
            method: WS_METHODS.threadHandoffStart,
            input: {
              threadId: THREAD_ID,
              environmentId: handoffTarget.environmentId,
              projectId: handoffTarget.projectId,
            },
          },
        ]);
      }),
  );

  it.effect(
    "does not let pending cancellation, retry or abandonment cross a replacement handoff",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHandoffHarness();
        const pending = {
          ...handoffTarget,
          state: "pending" as const,
          requestCommandId: CommandId.make("move-request"),
        };
        h.registry.set(h.thread, { ...SNAPSHOT.threads[0]!, handoff: pending });
        const cancelled = h.commands.cancel.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, handoffId: pending.handoffId, isCurrent: () => true },
        });
        const cancelGate = yield* Queue.take(h.gates);
        const departing = {
          ...handoffTarget,
          handoffId: "replacement",
          state: "departing" as const,
        };
        h.registry.set(h.thread, { ...SNAPSHOT.threads[0]!, handoff: departing });
        yield* Deferred.succeed(cancelGate, undefined);
        expect((yield* Effect.promise(() => cancelled))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);

        const retry = h.commands.start.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            environmentId: departing.environmentId,
            handoffId: departing.handoffId,
            isCurrent: () => true,
          },
        });
        const retryGate = yield* Queue.take(h.gates);
        const next = { ...departing, handoffId: "newest" };
        h.registry.set(h.thread, { ...SNAPSHOT.threads[0]!, handoff: next });
        yield* Deferred.succeed(retryGate, undefined);
        expect((yield* Effect.promise(() => retry))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);

        let current = true;
        const abandonInput = {
          threadId: THREAD_ID,
          handoffId: next.handoffId,
          abandon: true,
          isCurrent: () => current,
        };
        const stale = h.commands.cancel.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: abandonInput,
        });
        const abandonGate = yield* Queue.take(h.gates);
        current = false;
        yield* Deferred.succeed(abandonGate, undefined);
        expect((yield* Effect.promise(() => stale))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);

        current = true;
        const accepted = h.commands.cancel.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: abandonInput,
        });
        yield* Deferred.succeed(yield* Queue.take(h.gates), undefined);
        expect((yield* Effect.promise(() => accepted))._tag).toBe("Success");
        expect(h.sent).toEqual([
          {
            method: WS_METHODS.threadHandoffCancel,
            input: { threadId: THREAD_ID, handoffId: next.handoffId, abandon: true },
          },
        ]);
      }),
  );

  it.effect(
    "rejects an old selection after source to draft to the same source, while a fresh selection can move",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHandoffHarness();
        const ref = { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID };
        HandoffAction.configureThreadHandoffActions((source) =>
          h.registry.get(h.commands.availableAtom(source)),
        );
        HandoffAction.threadHandoffRequest.setState({ request: null });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            HandoffAction.threadHandoffRequest.setState({ request: null });
            HandoffAction.configureThreadHandoffActions(() => false);
          }),
        );
        HandoffAction.updateThreadHandoffSelection("/remote/thread");
        const oldMenu = HandoffAction.threadHandoffAction(ref);
        oldMenu.run();
        const oldRequest = HandoffAction.threadHandoffRequest.getState().request!;
        const stale = h.commands.start.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            environmentId: handoffTarget.environmentId,
            isCurrent: () => HandoffAction.isCurrentThreadHandoffRequest(oldRequest),
          },
        });
        const gate = yield* Queue.take(h.gates);
        HandoffAction.updateThreadHandoffSelection("/remote/draft");
        HandoffAction.updateThreadHandoffSelection("/remote/thread");
        yield* Deferred.succeed(gate, undefined);
        expect((yield* Effect.promise(() => stale))._tag).toBe("Failure");
        expect(h.sent).toEqual([]);
        HandoffAction.threadHandoffRequest.setState({ request: null });
        oldMenu.run();
        expect(HandoffAction.threadHandoffRequest.getState().request).toBeNull();

        HandoffAction.threadHandoffAction(ref).run();
        const fresh = HandoffAction.threadHandoffRequest.getState().request!;
        expect(fresh.ref).toEqual(ref);
        const accepted = h.commands.start.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: {
            threadId: THREAD_ID,
            environmentId: handoffTarget.environmentId,
            isCurrent: () => HandoffAction.isCurrentThreadHandoffRequest(fresh),
          },
        });
        yield* Deferred.succeed(yield* Queue.take(h.gates), undefined);
        expect((yield* Effect.promise(() => accepted))._tag).toBe("Success");
        expect(h.sent).toEqual([
          {
            method: WS_METHODS.threadHandoffStart,
            input: { threadId: THREAD_ID, environmentId: handoffTarget.environmentId },
          },
        ]);
      }),
  );

  it.effect("honors permission revocation while an authorized start awaits dispatch", () =>
    Effect.gen(function* () {
      const h = yield* makeHandoffHarness();
      const result = h.commands.start.run(h.registry, {
        environmentId: ENVIRONMENT_ID,
        input: { threadId: THREAD_ID, environmentId: handoffTarget.environmentId },
      });
      const gate = yield* Queue.take(h.gates);
      h.registry.set(h.session, AsyncResult.success({ ...h.grant, scopes: [], permissions: [] }));
      expect(h.registry.get(h.commands.start.permissionAtom(ENVIRONMENT_ID))).toBe(false);
      yield* Deferred.succeed(gate, undefined);
      const denied = yield* Effect.promise(() => result);
      expect(h.sent).toEqual([]);
      expect(denied._tag).toBe("Failure");
      if (denied._tag === "Failure")
        expect(Cause.squash(denied.cause)).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
    }),
  );
});
