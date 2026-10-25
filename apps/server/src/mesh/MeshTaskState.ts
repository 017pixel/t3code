// EXPERIMENTAL mesh v1: the work state of a remote task's thread, read on the member that runs it.
import {
  EnvironmentId,
  MESH_TASK_STATE_PATH,
  MeshTaskStateRequest,
  MeshTaskStateResponse,
  type OrchestrationV2Run,
  ProviderRequestKind,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import {
  delegatedTaskProgress,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as MeshServices from "./Services.ts";

/** The thread or run is gone on the member, for example deleted there. */
export class MeshTaskStateNotFoundError extends Schema.TaggedError<MeshTaskStateNotFoundError>()(
  "MeshTaskStateNotFoundError",
  { threadId: ThreadId, runId: RunId },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no run ${this.runId} on this machine.`;
  }
}

export class MeshTaskStateReadError extends Schema.TaggedError<MeshTaskStateReadError>()(
  "MeshTaskStateReadError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Unable to read the work state of thread ${this.threadId}.`;
  }
}

/** The member answered `mesh.taskState` with an unexpected status or body. */
export class MeshTaskStateRequestError extends Schema.TaggedError<MeshTaskStateRequestError>()(
  "MeshTaskStateRequestError",
  { environmentId: EnvironmentId, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Mesh member ${this.environmentId} did not return a task state.`;
  }
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

/** How a settled thread's last run ended, in task terms. */
function settledStatus(run: OrchestrationV2Run): MeshTaskStateResponse["status"] {
  const outcome = runOutcome(run);
  return outcome === "failed" || outcome === "interrupted"
    ? outcome
    : outcome === "cancelled" || outcome === "rolled_back"
      ? "cancelled"
      : "completed";
}
const isTerminalRun = (run: OrchestrationV2Run) =>
  ThreadManagementService.isTerminalRunStatus(run.status);

/**
 * Member side of `mesh.taskState`. The thread is an ordinary launch here, not a task, so this
 * reads thread-level progress, which counts the thread's own delegated children.
 */
export class MeshTaskState extends Context.Service<
  MeshTaskState,
  {
    readonly read: (
      request: MeshTaskStateRequest,
    ) => Effect.Effect<MeshTaskStateResponse, MeshTaskStateNotFoundError | MeshTaskStateReadError>;
  }
>()("t3/mesh/MeshTaskState") {}

export const layer = Layer.effect(
  MeshTaskState,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;

    const read = Effect.fn("MeshTaskState.read")(function* (request: MeshTaskStateRequest) {
      const notFound = new MeshTaskStateNotFoundError(request);
      const readError = (cause: unknown) =>
        new MeshTaskStateReadError({ threadId: request.threadId, cause });
      const shell = yield* threads
        .getThreadShell(request.threadId)
        .pipe(Effect.mapError(readError));
      if (shell === null || shell.deletedAt !== null) return yield* notFound;
      const controls = yield* threads
        .getThreadRecords(
          request.threadId,
          ["runs", "messages", "subagents", "providerThreads", "runtimeRequests", "nodes"],
          { messageRoles: ["user"], omitSettledLeafNodes: true },
        )
        .pipe(Effect.mapError(readError));
      const run = controls.runs.find((candidate) => candidate.id === request.runId);
      if (run === undefined) return yield* notFound;

      const progress = delegatedTaskProgress(controls);
      const resultRun = progress.state === "result_available" ? progress.resultRun : undefined;
      const result =
        resultRun === undefined
          ? null
          : subagentResultForRun(
              yield* threads
                .getThreadRecords(request.threadId, ["messages", "turnItems"], {
                  messageRoles: ["assistant"],
                  messageRunIds: [resultRun.id],
                  turnItemRunIds: [resultRun.id],
                  turnItemTypes: ["assistant_message", "error"],
                })
                .pipe(Effect.mapError(readError)),
              resultRun,
            ).text;
      const latest = controls.runs.toSorted((a, b) => b.ordinal - a.ordinal)[0] ?? run;
      const status =
        resultRun !== undefined
          ? settledStatus(resultRun)
          : latest.status === "queued"
            ? "queued"
            : "running";

      // Questions and approvals count in any unfinished run: wakes from the thread's own
      // children start later runs, and they are still this task's work.
      const openRunIds = new Set(
        controls.runs.filter((candidate) => !isTerminalRun(candidate)).map(({ id }) => id),
      );
      const runIdOf = (nodeId: string) =>
        controls.nodes.find((node) => node.id === nodeId)?.runId ?? null;
      const pending = controls.runtimeRequests
        .filter((candidate) => candidate.status === "pending")
        .toSorted(
          (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
        );
      const live = pending.filter((candidate) => candidate.responseCapability.type === "live");
      const question = live.find((candidate) => candidate.kind === "user_input");
      const messageQuestions = pending.filter(
        (candidate) =>
          candidate.kind === "user_input" && candidate.responseCapability.type === "message",
      );
      const approval = live.flatMap((candidate) => {
        const runId = runIdOf(candidate.nodeId);
        return isApprovalRequestKind(candidate.kind) && runId !== null && openRunIds.has(runId)
          ? [{ requestId: candidate.id, kind: candidate.kind, runId }]
          : [];
      })[0];
      const settled = resultRun !== undefined;
      return {
        workState: progress.state,
        status,
        hasPendingQuestion: !settled && question !== undefined,
        pendingQuestionRequestId: settled ? null : (question?.id ?? null),
        // Still open after the work settles: they are answered by message, and the delegating
        // member has to wake its parent for them before it reports the result.
        messageQuestionRequestIds: messageQuestions.map(({ id }) => id),
        pendingApproval: settled ? null : (approval ?? null),
        result,
        settled,
      } satisfies MeshTaskStateResponse;
    });

    return MeshTaskState.of({ read });
  }),
);

const NO_STORE = { "cache-control": "no-store" };
const decodeTaskStateRequest = HttpServerRequest.schemaBodyJson(MeshTaskStateRequest);
const taskStateJson = HttpServerResponse.schemaJson(MeshTaskStateResponse);

/** `POST /api/mesh/task-state` for the member that delegated the task. */
export const layerRoute = HttpRouter.add(
  "POST",
  MESH_TASK_STATE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const member = yield* environmentAuth.authenticateMeshMember(request).pipe(Effect.option);
    if (Option.isNone(member)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_mesh_credential" },
        { status: 401, headers: NO_STORE },
      );
    }
    const body = yield* decodeTaskStateRequest.pipe(Effect.option);
    if (Option.isNone(body)) {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 });
    }
    const taskStates = yield* MeshTaskState;
    return yield* taskStates.read(body.value).pipe(
      Effect.flatMap((state) => taskStateJson(state, { headers: NO_STORE })),
      Effect.catchTags({
        MeshTaskStateNotFoundError: () =>
          Effect.succeed(
            HttpServerResponse.jsonUnsafe(
              { error: "not_found" },
              { status: 404, headers: NO_STORE },
            ),
          ),
        MeshTaskStateReadError: (error) =>
          Effect.logError("Mesh task state read failed", { cause: error.cause }).pipe(
            Effect.as(HttpServerResponse.jsonUnsafe({ error: "internal_error" }, { status: 500 })),
          ),
      }),
      Effect.orDie,
    );
  }),
);

/** Reads `mesh.taskState` on another member over a `mesh-member` session. */
export class MeshTaskStateClient extends Context.Service<
  MeshTaskStateClient,
  {
    readonly read: (
      environmentId: EnvironmentId,
      request: MeshTaskStateRequest,
    ) => Effect.Effect<
      MeshTaskStateResponse,
      MeshServices.MeshCredentialsError | MeshTaskStateNotFoundError | MeshTaskStateRequestError
    >;
  }
>()("t3/mesh/MeshTaskState/MeshTaskStateClient") {}

const decodeResponse = HttpClientResponse.schemaBodyJson(MeshTaskStateResponse);

export const layerClient = Layer.effect(
  MeshTaskStateClient,
  Effect.gen(function* () {
    const credentials = yield* MeshServices.MeshCredentials;
    const httpClient = yield* HttpClient.HttpClient;

    const read = Effect.fn("MeshTaskStateClient.read")(function* (
      environmentId: EnvironmentId,
      request: MeshTaskStateRequest,
    ) {
      const session = yield* credentials.session(environmentId);
      const url = `${session.route.httpBaseUrl.replace(/\/+$/, "")}${MESH_TASK_STATE_PATH}`;
      const headers = yield* session.authorizationHeaders({ method: "POST", url });
      const requestError = (cause: unknown) =>
        new MeshTaskStateRequestError({ environmentId, cause });
      return yield* Effect.gen(function* () {
        const response = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJson(request),
          Effect.flatMap(httpClient.execute),
          Effect.mapError(requestError),
        );
        if (response.status === 404) return yield* new MeshTaskStateNotFoundError(request);
        if (response.status === 401 || response.status === 403) {
          // The member dropped the session (renewal, restart, revocation); the next read redeems anew.
          yield* credentials.invalidate(environmentId);
          return yield* new MeshServices.MeshSessionRefusedError({
            environmentId,
            status: response.status,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* requestError(`HTTP ${response.status}`);
        }
        return yield* decodeResponse(response).pipe(Effect.mapError(requestError));
      }).pipe(
        Effect.timeout("15 seconds"),
        Effect.catchTags({
          TimeoutError: (cause) => Effect.fail(requestError(cause)),
        }),
        // A route that stopped answering is walked again next time; the session works on any route.
        Effect.tapError((error) =>
          error._tag === "MeshTaskStateRequestError"
            ? credentials.forgetRoute(environmentId)
            : Effect.void,
        ),
      );
    });

    return MeshTaskStateClient.of({ read });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));
