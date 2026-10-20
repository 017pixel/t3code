import {
  CommandId,
  ExecutionEnvironmentDescriptor,
  type EnvironmentId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadHandoff,
  OrchestratorMcpThreadImportInput,
  type OrchestratorMcpImportedMessage,
  type ProjectId,
  type ThreadId,
  ThreadHandoffError,
  ThreadHandoffId,
  linkOriginIsFenced,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { forkParked } from "../../serverActivation.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as PeerForwarding from "../PeerForwarding.ts";
import * as PeerLinks from "../PeerLinks.ts";
import * as HandoffGit from "./HandoffGit.ts";

const DEFAULT_CONTINUATION =
  "This thread was moved here with its conversation and working changes. Continue where it left off.";
const Recovery = Schema.Struct({
  input: OrchestratorMcpThreadImportInput,
  bundlePath: Schema.NullOr(Schema.String),
  uncertain: Schema.Boolean,
});
const decodeRecovery = Schema.decodeUnknownEffect(Schema.fromJsonString(Recovery));
const encodeRecovery = Schema.encodeEffect(Schema.fromJsonString(Recovery));
const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);
type Handoff = OrchestrationV2ThreadHandoff;
type Start = {
  readonly threadId?: ThreadId | undefined;
  readonly callerThreadId?: ThreadId | undefined;
  readonly environmentId: EnvironmentId;
  readonly handoffId?: string | undefined;
  readonly projectId?: ProjectId | undefined;
  readonly continuationPrompt?: string | undefined;
};
export class ThreadHandoff extends Context.Service<
  ThreadHandoff,
  {
    readonly options: (threadId: ThreadId) => Effect.Effect<
      ReadonlyArray<{
        readonly environmentId: EnvironmentId;
        readonly label: string;
        readonly projectId: ProjectId | null;
        readonly reason: string | null;
      }>,
      ThreadHandoffError
    >;
    readonly start: (input: Start) => Effect.Effect<Handoff, ThreadHandoffError>;
    readonly cancel: (input: {
      readonly threadId: ThreadId;
      readonly handoffId: string;
      readonly abandon?: boolean | undefined;
    }) => Effect.Effect<void, ThreadHandoffError>;
    readonly settle: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start_: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/peer/handoff/ThreadHandoff") {}

const isHandoffId = Schema.is(ThreadHandoffId);
const refused = (message: string) => new ThreadHandoffError({ reason: "refused", message });
const failed = (cause: unknown) =>
  new ThreadHandoffError({
    reason: "failed",
    message: "The move could not finish. Retry it when the linked environment is available.",
    cause,
  });
const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const events = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const forwarding = yield* PeerForwarding.PeerForwarding;
  const links = yield* PeerLinks.PeerLinks;
  const git = yield* HandoffGit.HandoffGit;
  const http = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const processes = yield* VcsProcess.VcsProcess;
  const hereId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const locks = yield* KeyedLock.make<ThreadId>();
  const artifactDir = (handoffId: string) => path.join(config.stateDir, "handoffs", handoffId);
  const scopeFor = (thread: OrchestrationV2AppThread): McpInvocationContext.McpInvocationScope => ({
    environmentId: hereId,
    requestNamespace: `handoff:${thread.id}`,
    thread: undefined,
    // The server owns idle/recovery work; it is not a live provider impersonation.
    client: {
      sessionId: thread.linkOrigin?.sessionId ?? `handoff:${thread.id}`,
      label: thread.linkOrigin?.label ?? "Thread handoff",
      linked: thread.linkOrigin !== undefined,
      access: thread.linkOrigin?.access ?? thread.runtimeMode,
      narrowedTo: { runtimeMode: thread.runtimeMode, interactionMode: thread.interactionMode },
    },
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  });
  const records = (threadId: ThreadId) =>
    threads.getThreadRecords(threadId, ["runs"]).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadHandoffError({
            reason: "not_found",
            message: "The thread was not found.",
            cause,
          }),
      ),
    );
  const setHandoff = (
    threadId: ThreadId,
    current: Handoff | null | undefined,
    next: Handoff | null,
    step: string,
    callerThreadId?: ThreadId,
  ) =>
    threads
      .dispatch({
        type: "thread.handoff.update",
        commandId: CommandId.make(
          `handoff:${threadId}:${next?.handoffId ?? current?.handoffId}:${step}`,
        ),
        threadId,
        expected: current == null ? null : { state: current.state, handoffId: current.handoffId },
        handoff: next,
        ...(callerThreadId === undefined ? {} : { callerThreadId }),
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause) =>
            new ThreadHandoffError({
              reason: "refused",
              message:
                "The thread changed while requesting the move. Read its current state and try again.",
              cause,
            }),
        ),
      );
  const assertDestination = (environmentId: EnvironmentId) =>
    Effect.gen(function* () {
      const resolved = yield* links.resolve(environmentId).pipe(Effect.mapError(failed));
      if (resolved.link.access === "read-only")
        return yield* refused("The destination link is read-only.");
      const response = yield* http
        .execute(HttpClientRequest.get(`${resolved.url}/.well-known/t3/environment`))
        .pipe(Effect.mapError(failed));
      if (response.status !== 200)
        return yield* refused("The destination could not confirm handoff support.");
      const descriptor = yield* response.json.pipe(
        Effect.flatMap(decodeDescriptor),
        Effect.mapError(failed),
      );
      if (
        descriptor.environmentId !== environmentId ||
        resolved.link.environmentId !== environmentId
      )
        return yield* refused("The destination identity does not match this link. Link it again.");
      if (
        descriptor.capabilities.threadImport !== true ||
        descriptor.capabilities.threadHandoff !== true ||
        descriptor.capabilities.mcpModeLimitHeader !== true ||
        descriptor.capabilities.linkFence !== true
      )
        return yield* refused("Update the destination server to support thread handoff.");
      return resolved;
    });
  const remoteProject = (
    thread: OrchestrationV2AppThread,
    environmentId: EnvironmentId,
    requested?: ProjectId,
  ) =>
    Effect.gen(function* () {
      yield* assertDestination(environmentId);
      const scope = scopeFor(thread);
      if (requested !== undefined) {
        const project = yield* forwarding
          .call(scope, ProjectToolkit.tools.t3_project_read, environmentId, {
            projectId: requested,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ThreadHandoffError({ reason: "refused", message: cause.message, cause }),
            ),
          );
        if (project.id !== requested || project.deletedAt !== null)
          return yield* refused("Choose an existing destination project.");
        return project.id;
      }
      const local = yield* projects.getById(thread.projectId).pipe(Effect.mapError(failed));
      const identity = Option.isNone(local)
        ? null
        : yield* identities.resolve(local.value.workspaceRoot);
      if (identity === null)
        return yield* refused(
          "Choose the destination project; this repository has no canonical remote.",
        );
      const listed = yield* forwarding
        .call(scope, ProjectToolkit.tools.t3_project_list, environmentId, {
          limit: 100,
          resolveRepositoryIdentity: true,
        })
        .pipe(Effect.mapError(failed));
      const matches = listed.projects.filter(
        (project) => project.repositoryIdentity?.canonicalKey === identity.canonicalKey,
      );
      if (matches.length !== 1 || listed.nextCursor !== null)
        return yield* refused("Choose the destination project for this repository.");
      return matches[0]!.id;
    });
  const conversation = (thread: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      const tail: OrchestratorMcpImportedMessage[] = [];
      let remaining = 2_000_000;
      let segment = thread;
      let throughRunId: NonNullable<
        ProjectionStore.ProjectionRecordFilter["messageTail"]
      >["throughRunId"];
      const seen = new Set<ThreadId>();
      while (!seen.has(segment.id) && tail.length < 2_000 && remaining > 0) {
        seen.add(segment.id);
        let before: NonNullable<ProjectionStore.ProjectionRecordFilter["messageTail"]>["before"];
        while (tail.length < 2_000 && remaining > 0) {
          // A page bounds decoding independently of the total retained conversation budget.
          const page = yield* threads
            .getThreadRecords(segment.id, ["messages"], {
              messageRoles: ["user", "assistant"],
              messageTail: {
                limit: 10,
                maxTextLength: 200_000,
                ...(before === undefined ? {} : { before }),
                ...(throughRunId === undefined ? {} : { throughRunId }),
              },
            })
            .pipe(Effect.mapError(failed));
          if (page.messages.length === 0) break;
          for (const message of page.messages.toReversed()) {
            if (tail.length === 2_000 || remaining === 0) break;
            if (
              message.streaming ||
              message.notification !== undefined ||
              message.delegatedCompletion !== undefined ||
              message.text.trim() === ""
            )
              continue;
            const text = message.text.slice(0, Math.min(200_000, remaining));
            if (text.trim() === "") continue;
            tail.push({
              role: message.role === "user" ? "user" : "assistant",
              text,
              createdAt: DateTime.formatIso(message.createdAt),
            });
            remaining -= text.length;
          }
          const oldest = page.messages[0]!;
          before = { createdAt: oldest.createdAt, messageId: oldest.id };
        }
        const fork = segment.forkedFrom;
        if (
          fork?.type !== "run" ||
          seen.has(fork.threadId) ||
          tail.length === 2_000 ||
          remaining === 0
        )
          break;
        const source = yield* threads
          .getThreadRecords(fork.threadId, ["runs"], { runIds: [fork.runId] })
          .pipe(Effect.mapError(failed));
        // Native visible history inherits by run ordinal, including each ancestor's own inherited prefix.
        if (source.runs.length === 0) break;
        segment = source.thread;
        throughRunId = fork.runId;
      }
      return tail.toReversed();
    });
  const gitRead = (cwd: string, args: ReadonlyArray<string>) =>
    processes
      .run({
        operation: "ThreadHandoff.validateWorkspace",
        command: "git",
        cwd,
        args,
        maxOutputBytes: 2_000_000,
        outputMode: "error",
        env: {
          GIT_DIR: undefined,
          GIT_WORK_TREE: undefined,
          GIT_COMMON_DIR: undefined,
          GIT_INDEX_FILE: undefined,
        },
      })
      .pipe(
        Effect.map((result) => result.stdout.trim()),
        Effect.mapError(failed),
      );
  const prepare = (
    thread: OrchestrationV2AppThread,
    handoff: Extract<Handoff, { state: "departing" }>,
  ) =>
    Effect.gen(function* () {
      const directory = artifactDir(handoff.handoffId);
      const manifest = path.join(directory, "request.json");
      if (yield* fs.exists(manifest).pipe(Effect.mapError(failed)))
        return yield* fs
          .readFileString(manifest)
          .pipe(Effect.flatMap(decodeRecovery), Effect.mapError(failed));
      const project = yield* projects.getById(thread.projectId).pipe(Effect.mapError(failed));
      if (Option.isNone(project)) return yield* refused("The source project was not found.");
      const cwd = thread.worktreePath ?? project.value.workspaceRoot;
      const repository = yield* processes
        .run({
          operation: "ThreadHandoff.inspectWorkspace",
          command: "git",
          cwd,
          args: ["rev-parse", "--is-inside-work-tree"],
          allowNonZeroExit: true,
          env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
        })
        .pipe(Effect.mapError(failed));
      if (repository.exitCode === 0) {
        // Nested checkouts and dirty submodules contain work a superproject snapshot cannot carry.
        const nested = yield* gitRead(cwd, ["ls-files", "-z", "--others", "--exclude-standard"]);
        if (nested.split("\0").some((entry) => entry.endsWith("/")))
          return yield* refused(
            "Move or commit nested Git checkouts before handing off this thread.",
          );
        const submodules = yield* gitRead(cwd, [
          "diff",
          "HEAD",
          "--ignore-submodules=none",
          "--raw",
          "--",
        ]);
        if (submodules.split("\n").some((entry) => /^:[0-7]{6} 160000 |^:160000 /.test(entry)))
          return yield* refused(
            "Commit or discard submodule changes before handing off this thread.",
          );
      }
      yield* fs.makeDirectory(directory, { recursive: true }).pipe(Effect.mapError(failed));
      const packed = yield* git.pack({ cwd, handoffId: handoff.handoffId, outDir: directory }).pipe(
        Effect.catchTags({ HandoffNotARepositoryError: () => Effect.succeed(null) }),
        Effect.mapError(
          (cause) => new ThreadHandoffError({ reason: "refused", message: cause.message, cause }),
        ),
      );
      const identity = yield* identities.resolve(cwd, { refresh: true });
      const sourceRoot =
        packed === null ? cwd : yield* gitRead(cwd, ["rev-parse", "--show-toplevel"]);
      const input: OrchestratorMcpThreadImportInput = {
        source: { environmentId: hereId, threadId: thread.id, handoffId: handoff.handoffId },
        projectId: handoff.projectId,
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        messages: yield* conversation(thread),
        continuationPrompt: handoff.continuationPrompt?.trim() || DEFAULT_CONTINUATION,
        ...(packed === null
          ? {}
          : {
              bundle: {
                attachmentId: "pending",
                branch: packed.branch,
                tip: packed.tip,
                snapshot: packed.snapshot,
                repository: { canonicalKey: identity?.canonicalKey ?? null, sourceRoot },
              },
            }),
      };
      const recovery = { input, bundlePath: packed?.bundlePath ?? null, uncertain: false };
      const encoded = yield* encodeRecovery(recovery).pipe(Effect.mapError(failed));
      yield* fs
        .writeFileString(`${manifest}.tmp`, encoded)
        .pipe(Effect.andThen(fs.rename(`${manifest}.tmp`, manifest)), Effect.mapError(failed));
      return recovery;
    });
  const upload = (thread: OrchestrationV2AppThread, handoff: Handoff, bundlePath: string) =>
    Effect.gen(function* () {
      const bytes = yield* fs.readFile(bundlePath).pipe(Effect.mapError(failed));
      const prepared = yield* forwarding
        .call(
          scopeFor(thread),
          AttachmentToolkit.tools.t3_attachment_prepare_upload,
          handoff.environmentId,
          {
            upload: {
              type: "file",
              name: `${handoff.handoffId}.bundle`,
              mimeType: "application/x-git-bundle",
              sizeBytes: bytes.byteLength,
            },
          },
        )
        .pipe(Effect.mapError(failed));
      const resolved = yield* links.resolve(handoff.environmentId).pipe(Effect.mapError(failed));
      const uploadUrl = new URL(prepared.relativeUrl, resolved.url);
      if (
        uploadUrl.origin !== new URL(resolved.url).origin ||
        !prepared.relativeUrl.startsWith("/")
      )
        return yield* refused("The destination returned an invalid upload location.");
      const response = yield* http
        .execute(
          HttpClientRequest.post(uploadUrl.href).pipe(
            HttpClientRequest.setBody(HttpBody.uint8Array(bytes, "application/x-git-bundle")),
          ),
        )
        .pipe(Effect.mapError(failed));
      yield* response.text.pipe(Effect.ignore);
      if (response.status !== 204)
        return yield* refused("The destination refused the bundle upload.");
      return prepared.attachmentId;
    });
  const depart = (thread: OrchestrationV2AppThread) =>
    Effect.gen(function* () {
      const threadId = thread.id;
      const handoff = thread.handoff;
      if (handoff?.state !== "departing") return handoff;
      let uncertain = true;
      let sent = false;
      let notAccepted = false;
      const manifestExists = yield* fs
        .exists(path.join(artifactDir(handoff.handoffId), "request.json"))
        .pipe(Effect.mapError(failed));
      uncertain = manifestExists;
      const outcome = yield* Effect.gen(function* () {
        const recovery = yield* prepare(thread, handoff);
        uncertain = recovery.uncertain;
        yield* assertDestination(handoff.environmentId);
        const input =
          recovery.bundlePath === null
            ? recovery.input
            : {
                ...recovery.input,
                bundle: {
                  ...recovery.input.bundle!,
                  attachmentId: yield* upload(thread, handoff, recovery.bundlePath),
                },
              };
        // Persist uncertainty before the remote call: a process exit can lose a committed reply too.
        const manifest = path.join(artifactDir(handoff.handoffId), "request.json");
        yield* encodeRecovery({ ...recovery, uncertain: true }).pipe(
          Effect.flatMap((encoded) => fs.writeFileString(`${manifest}.tmp`, encoded)),
          Effect.andThen(fs.rename(`${manifest}.tmp`, manifest)),
          Effect.mapError(failed),
        );
        sent = true;
        const result = yield* forwarding
          .call(
            scopeFor(thread),
            ProjectToolkit.tools.t3_thread_import,
            handoff.environmentId,
            input,
          )
          .pipe(
            Effect.mapError((cause) => {
              const proof = cause.handoffNotAccepted;
              notAccepted =
                proof !== undefined &&
                proof.source.environmentId === recovery.input.source.environmentId &&
                proof.source.threadId === recovery.input.source.threadId &&
                proof.source.handoffId === handoff.handoffId &&
                proof.projectId === handoff.projectId;
              return new ThreadHandoffError({ reason: "failed", message: cause.message, cause });
            }),
          );
        return result;
      }).pipe(Effect.result);
      if (outcome._tag === "Failure") {
        if (notAccepted || (!sent && !uncertain)) {
          yield* setHandoff(
            threadId,
            handoff,
            { ...handoff, state: "failed", lastError: outcome.failure.message },
            "failed",
          );
          yield* fs
            .remove(artifactDir(handoff.handoffId), { recursive: true, force: true })
            .pipe(Effect.ignore);
        }
        return yield* Effect.fail(outcome.failure);
      }
      const departed: Handoff = {
        state: "departed",
        handoffId: handoff.handoffId,
        environmentId: handoff.environmentId,
        label: handoff.label,
        projectId: handoff.projectId,
        threadId: outcome.success.threadId,
      };
      yield* setHandoff(threadId, handoff, departed, "departed");
      yield* fs
        .remove(artifactDir(handoff.handoffId), { recursive: true, force: true })
        .pipe(Effect.ignore);
      return departed;
    });
  const start: ThreadHandoff["Service"]["start"] = (input) =>
    Effect.gen(function* () {
      const threadId = input.threadId ?? input.callerThreadId;
      if (threadId === undefined)
        return yield* refused("Pass threadId for a client outside a T3 thread.");
      return yield* locks.withLock(
        threadId,
        Effect.gen(function* () {
          const current = yield* records(threadId);
          const thread = current.thread;
          if (input.handoffId !== undefined) {
            const handoff = thread.handoff;
            if (
              !isHandoffId(input.handoffId) ||
              handoff?.handoffId !== input.handoffId ||
              handoff.environmentId !== input.environmentId ||
              (input.projectId !== undefined && input.projectId !== handoff.projectId) ||
              input.continuationPrompt !== undefined ||
              (handoff.state !== "departing" && handoff.state !== "departed")
            )
              return yield* refused(
                "That move is no longer current, or its saved destination was changed.",
              );
            if (handoff.state === "departed") return handoff;
            if (
              !(yield* fs
                .exists(path.join(artifactDir(handoff.handoffId), "request.json"))
                .pipe(Effect.mapError(failed)))
            )
              return yield* refused(
                "The saved move is unavailable. Continue here to release this thread.",
              );
            return (yield* depart(thread)) ?? handoff;
          }
          if (
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            thread.lineage.relationshipToParent === "subagent"
          )
            return yield* refused("Only an unarchived, top-level thread can move.");
          if (thread.linkOrigin !== undefined && linkOriginIsFenced(thread.linkOrigin))
            return yield* refused("This linked thread cannot use this environment's links.");
          if (thread.handoff != null && thread.handoff.state !== "failed")
            return yield* refused(`This thread's move is already ${thread.handoff.state}.`);
          const live = current.runs.some((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
          const busy = live || current.runs.some((run) => run.status === "queued");
          if (busy && !(live && input.callerThreadId === threadId))
            return yield* refused(
              "Wait for all running and queued work before moving this thread.",
            );
          const projectId = yield* remoteProject(thread, input.environmentId, input.projectId);
          const resolved = yield* links.resolve(input.environmentId).pipe(Effect.mapError(failed));
          const handoffId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
          const base = {
            handoffId,
            environmentId: input.environmentId,
            label: resolved.link.label,
            projectId,
            ...(input.continuationPrompt === undefined
              ? {}
              : { continuationPrompt: input.continuationPrompt }),
          };
          const next: Handoff = busy
            ? {
                ...base,
                state: "pending",
                requestCommandId: CommandId.make(`handoff:${threadId}:${handoffId}:request`),
              }
            : { ...base, state: "departing" };
          yield* setHandoff(threadId, thread.handoff, next, "request", input.callerThreadId);
          if (next.state === "pending") return next;
          return (yield* depart({ ...thread, handoff: next })) ?? next;
        }),
      );
    });
  const cancel: ThreadHandoff["Service"]["cancel"] = (input) =>
    locks.withLock(
      input.threadId,
      Effect.gen(function* () {
        const { thread } = yield* records(input.threadId);
        const handoff = thread.handoff;
        if (handoff?.handoffId !== input.handoffId)
          return yield* refused("That move is no longer current.");
        if (handoff.state === "pending") {
          yield* setHandoff(input.threadId, handoff, null, "cancel");
          return;
        }
        if (handoff.state !== "departing" || input.abandon !== true)
          return yield* refused("Confirm continuing here to abandon this uncertain move.");
        yield* setHandoff(
          input.threadId,
          handoff,
          {
            ...handoff,
            state: "failed",
            lastError: "Move abandoned. The destination may already have a copy.",
          },
          "abandon",
        );
        yield* fs
          .remove(artifactDir(handoff.handoffId), { recursive: true, force: true })
          .pipe(Effect.ignore);
      }),
    );
  const settle: ThreadHandoff["Service"]["settle"] = (threadId) =>
    locks
      .withLock(
        threadId,
        Effect.gen(function* () {
          const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(failed));
          if (shell?.handoff?.state !== "pending" && shell?.handoff?.state !== "departing") return;
          const current = yield* records(threadId);
          const handoff = current.thread.handoff;
          if (handoff?.state === "pending") {
            if (current.thread.archivedAt !== null || current.thread.deletedAt !== null) return;
            if (
              current.runs.some((run) =>
                ["preparing", "starting", "running", "waiting"].includes(run.status),
              )
            )
              return;
            const next = { ...handoff, state: "departing" as const };
            yield* setHandoff(threadId, handoff, next, "departing");
            yield* depart({ ...current.thread, handoff: next });
          } else yield* depart(current.thread);
        }),
      )
      .pipe(Effect.asVoid, Effect.ignoreCause({ log: true }));
  const options: ThreadHandoff["Service"]["options"] = (threadId) =>
    Effect.gen(function* () {
      const { thread } = yield* records(threadId);
      const listed = yield* links.list.pipe(Effect.mapError(failed));
      return yield* Effect.forEach(
        listed,
        (link) =>
          remoteProject(thread, link.environmentId).pipe(
            Effect.map((projectId) => ({
              environmentId: link.environmentId,
              label: link.label,
              projectId,
              reason: null,
            })),
            Effect.catch((error) =>
              Effect.succeed({
                environmentId: link.environmentId,
                label: link.label,
                projectId: null,
                reason: error.message,
              }),
            ),
          ),
        { concurrency: 4 },
      );
    });
  const start_: ThreadHandoff["Service"]["start_"] = () =>
    forkParked(
      Effect.gen(function* () {
        const snapshot = yield* projections.getShellSnapshot().pipe(Effect.orDie);
        yield* Effect.forEach(
          snapshot.threads.filter(
            (thread) =>
              thread.handoff?.state === "pending" || thread.handoff?.state === "departing",
          ),
          (thread) => settle(thread.id),
          { discard: true },
        );
        yield* events
          .stream({ afterSequence: snapshot.snapshotSequence, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                  event.payload.status,
                ),
            ),
            Stream.runForEach(({ event }) => settle(event.threadId)),
          );
      }).pipe(Effect.ignoreCause({ log: true })),
    );
  return ThreadHandoff.of({ options, start, cancel, settle, start_ });
});
export const layer = Layer.effect(ThreadHandoff, make);
