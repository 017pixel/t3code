// EXPERIMENTAL mesh v1. Which member owns a thread or project id (PLAN §8.2). Ids are opaque, so
// an owner is found by asking, never by parsing the id.
import {
  type EnvironmentId,
  MESH_OWNS_PATH,
  type MeshMachineRef,
  type MeshMemberView,
  MeshOwnsRequest,
  MeshOwnsResponse,
  type MeshSnapshot,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { environmentEndpointUrl } from "@t3tools/shared/advertisedEndpoint";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as MeshServices from "./Services.ts";

/** A member that does not answer `mesh.owns` in time is named, not waited for. */
const OWNS_TIMEOUT = "5 seconds";

export type MeshPlacement =
  | { readonly _tag: "local" }
  | { readonly _tag: "remote"; readonly machine: MeshMachineRef };

export const localPlacement: MeshPlacement = { _tag: "local" };

export const machineRef = (member: MeshMemberView): MeshMachineRef => ({
  environmentId: member.environmentId,
  label: member.label,
});

/** Other members agents can call. Members without `meshAgents` run an older T3 Code. */
export const agentMembers = (snapshot: MeshSnapshot): ReadonlyArray<MeshMemberView> =>
  snapshot.members.filter(
    (member) =>
      member.environmentId !== snapshot.selfEnvironmentId &&
      member.capabilities.meshAgents === true,
  );

const encodeOwnsRequest = Schema.encodeEffect(MeshOwnsRequest);
const decodeOwnsResponse = Schema.decodeUnknownEffect(MeshOwnsResponse);
const encodeOwnsResponse = Schema.encodeEffect(MeshOwnsResponse);

const labels = (members: ReadonlyArray<MeshMachineRef>) =>
  members.map((member) => member.label).join(", ");

/** The member side of `mesh.owns`: whether this machine has the id, deleted or not. */
const ownsLocally = Effect.fn("MeshOwners.ownsLocally")(function* (request: MeshOwnsRequest) {
  switch (request.kind) {
    case "thread": {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return yield* threads.getThreadShell(ThreadId.make(request.id)).pipe(
        Effect.map((shell) => shell !== null),
        Effect.orElseSucceed(() => false),
      );
    }
    case "project": {
      const projects = yield* Project.ProjectService;
      return yield* projects.getById(ProjectId.make(request.id)).pipe(
        Effect.map(Option.isSome),
        Effect.orElseSucceed(() => false),
      );
    }
    // Queued runs and pending requests are reached through their thread id.
    case "queue":
    case "pending-request":
      return false;
  }
});

export class MeshOwners extends Context.Service<
  MeshOwners,
  {
    /** Local when this machine has the id or is not in a mesh; else the one member that has it. */
    readonly resolve: (
      request: MeshOwnsRequest,
    ) => Effect.Effect<MeshPlacement, OrchestratorMcpFailure>;
  }
>()("t3/mesh/MeshOwners") {}

const make = Effect.gen(function* () {
  const local = yield* Effect.context<
    ThreadManagement.ThreadManagementService | Project.ProjectService
  >();
  const membership = yield* MeshServices.MeshMembership;
  const credentials = yield* MeshServices.MeshCredentials;
  const httpClient = yield* HttpClient.HttpClient;
  // Nothing moves between members in v1, so an answer stays true.
  const cache = yield* Ref.make(new Map<string, EnvironmentId>());

  const askMember = Effect.fn("MeshOwners.askMember")(function* (
    member: MeshMemberView,
    request: MeshOwnsRequest,
  ) {
    const session = yield* credentials.session(member.environmentId);
    const url = environmentEndpointUrl(session.route.httpBaseUrl, MESH_OWNS_PATH);
    const headers = yield* session.authorizationHeaders({ method: "POST", url });
    const body = yield* encodeOwnsRequest(request);
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.setHeaders(headers),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      )
      .pipe(
        // A route that stopped answering is walked again next time; the session works on any route.
        Effect.tapError(() => credentials.forgetRoute(member.environmentId)),
      );
    if (response.status === 401) yield* credentials.invalidate(member.environmentId);
    if (response.status !== 200) {
      return yield* new MeshServices.MeshSessionRefusedError({
        environmentId: member.environmentId,
        status: response.status,
      });
    }
    return (yield* decodeOwnsResponse(yield* response.json)).owns;
  });

  const resolve = Effect.fn("MeshOwners.resolve")(function* (request: MeshOwnsRequest) {
    if (yield* ownsLocally(request).pipe(Effect.provide(local))) return localPlacement;
    const snapshot = yield* membership.snapshot;
    if (Option.isNone(snapshot)) return localPlacement;
    const key = `${request.kind}:${request.id}`;
    const members = agentMembers(snapshot.value);
    // Nobody else in the mesh: the local handler reports the id as missing in its usual words.
    if (members.length === 0) return localPlacement;
    const cached = (yield* Ref.get(cache)).get(key);
    const cachedMember = members.find((member) => member.environmentId === cached);
    if (cachedMember !== undefined) {
      return { _tag: "remote", machine: machineRef(cachedMember) } satisfies MeshPlacement;
    }
    const online = members.filter((member) => member.online);
    const answers = yield* Effect.forEach(
      online,
      (member) =>
        askMember(member, request).pipe(
          Effect.timeoutOption(OWNS_TIMEOUT),
          // The timeout interrupts the request before its own route drop can run.
          Effect.tap((owns) =>
            Option.isNone(owns) ? credentials.forgetRoute(member.environmentId) : Effect.void,
          ),
          Effect.map((owns) => ({ member: machineRef(member), owns })),
          Effect.orElseSucceed(() => ({ member: machineRef(member), owns: Option.none() })),
        ),
      { concurrency: "unbounded" },
    );
    const owners = answers.filter((answer) => Option.getOrElse(answer.owns, () => false));
    const [owner] = owners;
    if (owner !== undefined && owners.length === 1) {
      yield* Ref.update(cache, (entries) => new Map(entries).set(key, owner.member.environmentId));
      return { _tag: "remote", machine: owner.member } satisfies MeshPlacement;
    }
    if (owners.length > 1) {
      return yield* new OrchestratorMcpFailure({
        code: "owner_ambiguous",
        message: `More than one mesh machine has ${request.kind} ${request.id}: ${labels(owners.map((answer) => answer.member))}. Pass machine to choose one.`,
      });
    }
    // Offline members could own it too, so the error names them.
    const unanswered = [
      ...members.filter((member) => !member.online).map(machineRef),
      ...answers.filter((answer) => Option.isNone(answer.owns)).map((answer) => answer.member),
    ];
    return yield* new OrchestratorMcpFailure({
      code: "owner_not_found",
      message: `${request.kind} ${request.id} was not found on this machine or any mesh machine.${
        unanswered.length === 0 ? "" : ` No answer from: ${labels(unanswered)}.`
      }`,
    });
  });

  return MeshOwners.of({ resolve });
});

export const layer = Layer.effect(MeshOwners, make);

const decodeOwnsRequest = HttpServerRequest.schemaBodyJson(MeshOwnsRequest);

/** `POST /api/mesh/owns` for other members. */
export const layerOwnsRoute = HttpRouter.add(
  "POST",
  MESH_OWNS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const member = yield* environmentAuth.authenticateMeshMember(request).pipe(Effect.option);
    if (Option.isNone(member)) {
      return HttpServerResponse.jsonUnsafe(
        { error: "invalid_mesh_credential" },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    const body = yield* decodeOwnsRequest.pipe(Effect.option);
    if (Option.isNone(body)) {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_request" }, { status: 400 });
    }
    const owns = yield* ownsLocally(body.value);
    return HttpServerResponse.jsonUnsafe(yield* encodeOwnsResponse({ owns }));
  }),
);
