import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, MeshCloseCode, type MeshMemberView } from "@t3tools/contracts";
import { RelayApi, RelayClientAuth, RelayClientPrincipal } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as Devices from "../agentActivity/Devices.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentLinker from "../environments/EnvironmentLinker.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as ManagedEndpointProvider from "../environments/ManagedEndpointProvider.ts";
import * as HeldHooks from "../hooks/HeldHooks.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as RelayDb from "../db.ts";
import * as RelayHttpApi from "../http/Api.ts";
import * as MeshDirectory from "./MeshDirectory.ts";

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
  meshAllowedUserIds: ["user-allowed"],
};

const GOOD_CREDENTIAL = "t3env_good";

const boxView: MeshMemberView = {
  environmentId: EnvironmentId.make("env-box"),
  label: "box",
  machineKind: "server",
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true, meshGateway: true },
  connectHostname: "box.tunnels.example.test",
  directEndpoints: [{ kind: "lan", httpBaseUrl: "http://192.168.1.2:3773" }],
  captainEligible: true,
};

type MeshCall =
  | { readonly kind: "open"; readonly userId: string; readonly environmentId: string }
  | { readonly kind: "refuse"; readonly code: number; readonly reason: string };

const makeDirectory = (calls: Array<MeshCall>) =>
  Layer.mock(MeshDirectory.MeshDirectory, {
    openSocket: ({ userId, environmentId }) =>
      Effect.sync(() => {
        calls.push({ kind: "open", userId, environmentId });
        return HttpServerResponse.empty({ status: 204 });
      }),
    refuseSocket: (code, reason) =>
      Effect.sync(() => {
        calls.push({ kind: "refuse", code, reason });
        return HttpServerResponse.empty({ status: 205 });
      }),
    view: () => Effect.succeed({ members: [boxView], captain: boxView.environmentId, pin: null }),
  });

const serve = <E>(api: Layer.Layer<never, E, HttpRouter.HttpRouter>) =>
  Effect.acquireRelease(
    Effect.sync(() => HttpRouter.toWebHandler(api, { disableLogger: true })),
    (app) => Effect.promise(() => app.dispose()),
  );

/** The socket route with real environment auth and a link table of `usersForKey`. */
const serveSocketRoute = (usersForKey: ReadonlyArray<string>, calls: Array<MeshCall>) =>
  serve(
    HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.server)).pipe(
      Layer.provide(
        RelayHttpApi.layerServerApi.pipe(
          // Other server routes declare these per request; the mesh route reads the build context.
          HttpRouter.provideRequest(
            Layer.mergeAll(
              Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
              Layer.mock(ManagedEndpointAllocations.ManagedEndpointAllocations, {}),
              Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
              Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
            ),
          ),
          Layer.provide([
            Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
            Layer.mock(EnvironmentLinks.EnvironmentLinks, {
              listActiveUsersForKey: ({ environmentPublicKey }) =>
                Effect.succeed(environmentPublicKey === "key-1" ? usersForKey : []),
            }),
            Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {}),
            Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
            Layer.mock(HeldHooks.HeldHooks, {}),
            makeDirectory(calls),
          ]),
        ),
      ),
      Layer.provide(
        RelayHttpApi.layerEnvironmentAuth.pipe(
          Layer.provide(
            Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {
              authenticate: (token) =>
                Effect.succeed(
                  token === GOOD_CREDENTIAL
                    ? Option.some({
                        credentialId: "credential-1",
                        environmentId: "env-box",
                        environmentPublicKey: "key-1",
                      })
                    : Option.none(),
                ),
            }),
          ),
        ),
      ),
      Layer.provide(HttpServer.layerServices),
    ),
  );

const openSocket = (
  app: { readonly handler: (request: Request) => Promise<Response> },
  headers: Record<string, string>,
) =>
  Effect.promise(() =>
    app.handler(
      new Request("https://relay.example.test/v1/mesh/socket", {
        headers: { upgrade: "websocket", ...headers },
      }),
    ),
  );

describe("mesh socket route", () => {
  it.effect("refuses a missing or unknown environment credential before any mesh call", () => {
    const calls: Array<MeshCall> = [];
    return Effect.gen(function* () {
      const app = yield* serveSocketRoute(["user-allowed"], calls);
      expect((yield* openSocket(app, {})).status).toBe(401);
      expect((yield* openSocket(app, { authorization: "Bearer t3env_forged" })).status).toBe(401);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped);
  });

  it.effect("hands an allowlisted member to its account's mesh", () => {
    const calls: Array<MeshCall> = [];
    return Effect.gen(function* () {
      const app = yield* serveSocketRoute(["user-allowed"], calls);
      const response = yield* openSocket(app, { authorization: `Bearer ${GOOD_CREDENTIAL}` });
      expect(response.status).toBe(204);
      expect(calls).toEqual([{ kind: "open", userId: "user-allowed", environmentId: "env-box" }]);
    }).pipe(Effect.scoped);
  });

  it.effect("closes with a permanent code for a shared key or an account off the allowlist", () => {
    const calls: Array<MeshCall> = [];
    return Effect.gen(function* () {
      const shared = yield* serveSocketRoute(["user-allowed", "user-other"], calls);
      yield* openSocket(shared, { authorization: `Bearer ${GOOD_CREDENTIAL}` });
      const offList = yield* serveSocketRoute(["user-other"], calls);
      yield* openSocket(offList, { authorization: `Bearer ${GOOD_CREDENTIAL}` });
      expect(calls).toEqual([
        { kind: "refuse", code: MeshCloseCode.sharedKey, reason: "shared-key" },
        { kind: "refuse", code: MeshCloseCode.notAllowlisted, reason: "not-allowlisted" },
      ]);
    }).pipe(Effect.scoped);
  });

  it.effect("asks for an upgrade on a plain request", () => {
    const calls: Array<MeshCall> = [];
    return Effect.gen(function* () {
      const app = yield* serveSocketRoute(["user-allowed"], calls);
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/mesh/socket", {
            headers: { authorization: `Bearer ${GOOD_CREDENTIAL}` },
          }),
        ),
      );
      expect(response.status).toBe(426);
      expect(calls).toEqual([]);
    }).pipe(Effect.scoped);
  });
});

describe("GET /v1/mesh", () => {
  const serveMesh = (userId: string) =>
    serve(
      HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.client)).pipe(
        Layer.provide(
          RelayHttpApi.layerClientApi.pipe(
            HttpRouter.provideRequest(
              Layer.mergeAll(
                Layer.mock(EnvironmentCredentials.EnvironmentCredentials, {}),
                Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
                Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
                Layer.mock(RelayDb.RelayTransactions, {}),
                Layer.mock(HookInbox.HookInbox, {}),
                makeDirectory([]),
              ),
            ),
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(RelayConfiguration.RelayConfiguration, relaySettings),
                NodeCryptoLayer.layer,
                Layer.mock(RelayTokens.RelayTokens, { resolveDpopAccessTokenScopes: () => null }),
                Layer.mock(EnvironmentLinker.EnvironmentLinker, {}),
                Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
                Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {}),
                Layer.mock(Devices.Devices, {}),
                makeDirectory([]),
              ),
            ),
            Layer.provideMerge(
              Layer.succeed(RelayClientAuth, {
                clientBearer: (effect) =>
                  Effect.provideService(effect, RelayClientPrincipal, { userId, token: "token" }),
              }),
            ),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      ),
    );

  const getMesh = (userId: string) =>
    Effect.gen(function* () {
      const app = yield* serveMesh(userId);
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/mesh", {
            headers: { authorization: "Bearer token" },
          }),
        ),
      );
      return yield* Effect.promise(() => response.json());
    }).pipe(Effect.scoped);

  it.effect("reads the account's mesh, or says it is unavailable off the allowlist", () =>
    Effect.gen(function* () {
      expect(yield* getMesh("user-allowed")).toEqual({
        available: true,
        members: [boxView],
        captain: "env-box",
        pin: null,
      });
      expect(yield* getMesh("user-other")).toEqual({
        available: false,
        members: [],
        captain: null,
        pin: null,
      });
    }),
  );
});
