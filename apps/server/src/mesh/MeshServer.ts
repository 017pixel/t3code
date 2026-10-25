// EXPERIMENTAL mesh v1: the mesh services and routes one server runs. Provide `layer` above the
// HTTP routes: handlers read their services per request, and McpHttpServer reads MeshMembership,
// MeshCredentials and RemoteDelegation as optional services when it builds.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as MeshCredentials from "./MeshCredentials.ts";
import * as MeshMcpClient from "./MeshMcpClient.ts";
import * as MeshMembership from "./MeshMembership.ts";
import * as MeshOwners from "./MeshOwners.ts";
import * as MeshProxy from "./MeshProxy.ts";
import * as MeshSessionHttp from "./MeshSessionHttp.ts";
import * as MeshTaskState from "./MeshTaskState.ts";
import * as RemoteDelegation from "./RemoteDelegation.ts";

/** Relaunches and follows remote tasks; a follower runs only while its task is open. */
const layerRemoteTaskFollowers = Layer.effectDiscard(
  Effect.gen(function* () {
    const delegation = yield* RemoteDelegation.RemoteDelegation;
    yield* delegation.start();
  }),
);

export const layer = Layer.mergeAll(
  MeshSessionHttp.layer,
  MeshTaskState.layer,
  MeshProxy.layer,
  layerRemoteTaskFollowers,
).pipe(
  Layer.provideMerge(RemoteDelegation.layer.pipe(Layer.provide(ProjectionStore.layer))),
  Layer.provideMerge(Layer.mergeAll(MeshMcpClient.layer, MeshTaskState.layerClient)),
  Layer.provideMerge(MeshCredentials.layer),
  Layer.provideMerge(MeshMembership.layer),
);

/** Every mesh HTTP route, each registered once. Serve them inside the CORS layer. */
export const layerRoutes = Layer.mergeAll(
  MeshSessionHttp.routeLayer,
  MeshOwners.layerOwnsRoute,
  MeshTaskState.layerRoute,
  MeshProxy.layerRoutes,
);
