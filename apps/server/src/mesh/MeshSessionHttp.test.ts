// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no Ed25519 key generation.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  MESH_GRANT_JWT_TYPE,
  MESH_GRANT_SCOPE,
  type MeshGrantClaims,
} from "@t3tools/contracts";
import { RELAY_MINT_REQUEST_TYP, signRelayJwt } from "@t3tools/shared/relayJwt";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
} from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as MeshSessionHttp from "./MeshSessionHttp.ts";
import * as MeshTestkit from "./testkit.ts";

const RELAY_ISSUER = "https://relay.mesh.test";
const CLOUD_USER = "user_mesh";
const CALLER = EnvironmentId.make("env-caller");
const CALLER_KEY = "caller-key-thumbprint";
const mintKey = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const encode = (value: string) => new TextEncoder().encode(value);

const layerServerEnvironment = Layer.effect(
  ServerEnvironment.ServerEnvironment,
  Effect.gen(function* () {
    const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
    return ServerEnvironment.ServerEnvironment.of({
      getEnvironmentId: identity.getEnvironmentId,
      getDescriptor: Effect.die("unused"),
    });
  }),
);

/** A member linked to {@link CLOUD_USER}, with the relay's mint key installed. */
const startMember = Effect.fn("test.startMember")(function* (
  prefix: string,
  beforeSessionLock: Effect.Effect<void> = Effect.void,
) {
  const membership = yield* MeshTestkit.makeMembership({
    snapshot: {
      selfEnvironmentId: EnvironmentId.make("env-self"),
      members: [
        {
          environmentId: CALLER,
          label: "Caller",
          machineKind: null,
          serverVersion: "0.0.0-test",
          online: true,
          capabilities: { meshMember: true },
          connectHostname: null,
          directEndpoints: [],
          captainEligible: false,
        },
      ],
      captain: null,
      pin: null,
    },
  });
  const context = yield* Layer.build(
    MeshSessionHttp.layer.pipe(
      Layer.provide(membership.layer),
      Layer.updateService(EnvironmentAuth.EnvironmentAuth, (auth) => ({
        ...auth,
        withMeshSessionLock: (effect) =>
          beforeSessionLock.pipe(Effect.andThen(auth.withMeshSessionLock(effect))),
      })),
      Layer.provideMerge(EnvironmentAuth.layer),
      Layer.provideMerge(layerServerEnvironment),
      Layer.provideMerge(ServerEnvironment.layerIdentity),
      Layer.provideMerge(SqlitePersistence.layerMemory),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    ),
  );
  const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
  yield* secrets.set(CLOUD_MINT_PUBLIC_KEY, encode(mintKey.publicKey));
  yield* secrets.set(RELAY_ISSUER_SECRET, encode(RELAY_ISSUER));
  yield* secrets.set(CLOUD_LINKED_USER_ID, encode(CLOUD_USER));
  const self = yield* Context.get(context, ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const issuer = Context.get(context, MeshSessionHttp.MeshSessionIssuer);

  /** A grant for this member, signed by the relay's mint key, with `overrides` applied. */
  const grant = Effect.fn("test.grant")(function* (
    overrides: Partial<MeshGrantClaims> = {},
    typ: string = MESH_GRANT_JWT_TYPE,
  ) {
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    return yield* signRelayJwt({
      privateKey: mintKey.privateKey,
      typ,
      payload: {
        iss: RELAY_ISSUER,
        sub: CLOUD_USER,
        aud: self,
        meshCaller: CALLER,
        scope: MESH_GRANT_SCOPE,
        cnf: { jkt: CALLER_KEY },
        jti: NodeCrypto.randomUUID(),
        iat,
        exp: iat + 60,
        ...overrides,
      },
    }).pipe(Effect.orDie);
  });

  return {
    self,
    grant,
    issuer,
    secrets,
    auth: Context.get(context, EnvironmentAuth.EnvironmentAuth),
    sessions: Context.get(context, SessionStore.SessionStore),
    settings: Context.get(context, ServerSettings.ServerSettingsService),
    /** The reason the member refused, or "redeemed". */
    redeem: (token: string, proofThumbprint = CALLER_KEY) =>
      issuer.redeem({ grant: token, proofThumbprint }).pipe(
        Effect.as("redeemed"),
        Effect.catchTags({
          MeshGrantRejectedError: (error) => Effect.succeed(error.reason),
        }),
      ),
  };
});

it.layer(NodeServices.layer)("MeshSessionIssuer", (it) => {
  it.effect("redeems a grant once, for a session bound to the caller's key", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-session-redeem-");
      const token = yield* member.grant();
      const session = yield* member.issuer.redeem({ grant: token, proofThumbprint: CALLER_KEY });
      const verified = yield* member.sessions.verify(session.token);
      expect(verified.meshCaller).toBe(CALLER);
      expect(verified.proofKeyThumbprint).toBe(CALLER_KEY);
      expect(yield* member.redeem(token)).toBe("replayed");
    }),
  );

  it.effect("refuses a grant that is not for this member, its account, or the caller's key", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-session-refuse-");
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
      const refused = {
        "another account": yield* member.redeem(yield* member.grant({ sub: "user_other" })),
        "another member": yield* member.redeem(
          yield* member.grant({ aud: EnvironmentId.make("env-other") }),
        ),
        "itself as caller": yield* member.redeem(yield* member.grant({ meshCaller: member.self })),
        "another key": yield* member.redeem(yield* member.grant(), "another-key-thumbprint"),
        expired: yield* member.redeem(yield* member.grant({ iat: now - 300, exp: now - 240 })),
        "a mint request": yield* member.redeem(yield* member.grant({}, RELAY_MINT_REQUEST_TYP)),
        "a plain JWT": yield* member.redeem(yield* member.grant({}, "JWT")),
      };
      expect(refused).toEqual({
        "another account": "invalid",
        "another member": "invalid",
        "itself as caller": "invalid",
        "another key": "invalid",
        expired: "invalid",
        "a mint request": "invalid",
        "a plain JWT": "invalid",
      });
    }),
  );

  it.effect("refuses every grant while this member is out of the mesh", () =>
    Effect.gen(function* () {
      const member = yield* startMember("t3-mesh-session-disabled-");
      yield* member.settings.updateSettings({ meshEnabled: false });
      expect(yield* member.redeem(yield* member.grant())).toBe("disabled");
    }),
  );

  it.effect("refuses an old account's grant paused before the session lock", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const member = yield* startMember(
        "t3-mesh-session-account-change-",
        Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(resume))),
      );
      const redemption = yield* member.redeem(yield* member.grant()).pipe(Effect.forkChild);
      yield* Deferred.await(ready);
      yield* member.secrets.set(CLOUD_LINKED_USER_ID, encode("user_other"));
      yield* member.auth.revokeMeshMemberSessions();
      yield* Deferred.succeed(resume, undefined);
      expect(yield* Fiber.join(redemption)).toBe("invalid");
    }),
  );
});
