// EXPERIMENTAL mesh v1: the member side of `POST /api/mesh/session`. Another member redeems a
// relay-signed grant here for a `mesh-member` session bound to its mesh DPoP key.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is async; this hashes a short id.
import * as NodeCrypto from "node:crypto";

import {
  MESH_GRANT_JWT_TYPE,
  MESH_GRANT_TTL_SECONDS,
  MESH_SESSION_PATH,
  MeshGrantClaims,
  MeshSessionRequest,
  MeshSessionResponse,
} from "@t3tools/contracts";
import { normalizeRelayIssuer, verifyRelayJwt } from "@t3tools/shared/relayJwt";
import * as ByteSize from "effect/ByteSize";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { verifyRequestDpopProof } from "../auth/dpop.ts";
import { consumeCloudReplayGuards } from "../cloud/CloudLink.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import { MeshMembership } from "./Services.ts";

/** Replay markers for spent grant ids; pruned with the other replay markers. */
export const MESH_GRANT_REPLAY_MARKER_PREFIX = "mesh-grant-jti-";

const GRANT_CLOCK_SKEW_SECONDS = 60;

export class MeshGrantRejectedError extends Schema.TaggedError<MeshGrantRejectedError>()(
  "MeshGrantRejectedError",
  { reason: Schema.Literals(["disabled", "not-linked", "invalid", "replayed"]) },
) {
  override get message(): string {
    return `This member refused the mesh grant: ${this.reason}.`;
  }
}

export class MeshSessionIssueError extends Schema.TaggedError<MeshSessionIssueError>()(
  "MeshSessionIssueError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not issue a mesh member session.";
  }
}

/** Turns relay grants into `mesh-member` sessions on this machine. */
export class MeshSessionIssuer extends Context.Service<
  MeshSessionIssuer,
  {
    /** `proofThumbprint` is the key of the request's verified DPoP proof. */
    readonly redeem: (input: {
      readonly grant: string;
      readonly proofThumbprint: string;
    }) => Effect.Effect<MeshSessionResponse, MeshGrantRejectedError | MeshSessionIssueError>;
  }
>()("t3/mesh/MeshSessionHttp/MeshSessionIssuer") {}

const decodeGrantClaims = Schema.decodeUnknownEffect(MeshGrantClaims);
const encodeSessionResponse = Schema.encodeSync(Schema.toCodecJson(MeshSessionResponse));
const decodeSessionRequest = Schema.decodeUnknownEffect(MeshSessionRequest);

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const membership = yield* MeshMembership;

  const readSecret = (name: string) =>
    secrets.get(name).pipe(Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))));

  const redeem: MeshSessionIssuer["Service"]["redeem"] = Effect.fn("MeshSessionIssuer.redeem")(
    function* ({ grant, proofThumbprint }) {
      const settings = yield* serverSettings.getSettings;
      if (!settings.meshEnabled) return yield* new MeshGrantRejectedError({ reason: "disabled" });

      const mintPublicKey = yield* readSecret(CLOUD_MINT_PUBLIC_KEY);
      const issuer = yield* readSecret(RELAY_ISSUER_SECRET);
      const relayIssuer = Option.isSome(issuer) ? issuer : yield* readSecret(RELAY_URL_SECRET);
      const installedUser = yield* readSecret(CLOUD_LINKED_USER_ID);
      if (
        Option.isNone(mintPublicKey) ||
        Option.isNone(relayIssuer) ||
        Option.isNone(installedUser)
      ) {
        return yield* new MeshGrantRejectedError({ reason: "not-linked" });
      }

      const selfEnvironmentId = yield* environment.getEnvironmentId;
      const now = yield* DateTime.now;
      const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
      // A grant is its own `typ` and scope, so a relay mint request never passes as one.
      const claims = yield* verifyRelayJwt({
        publicKey: mintPublicKey.value,
        token: grant,
        typ: MESH_GRANT_JWT_TYPE,
        issuer: normalizeRelayIssuer(relayIssuer.value),
        audience: selfEnvironmentId,
        nowEpochSeconds: nowSeconds,
        maxTokenAge: MESH_GRANT_TTL_SECONDS + GRANT_CLOCK_SKEW_SECONDS,
      }).pipe(Effect.flatMap(decodeGrantClaims), Effect.option);
      if (
        Option.isNone(claims) ||
        claims.value.aud !== selfEnvironmentId ||
        claims.value.sub !== installedUser.value ||
        claims.value.meshCaller === selfEnvironmentId ||
        claims.value.cnf.jkt !== proofThumbprint ||
        claims.value.exp <= claims.value.iat ||
        claims.value.exp - claims.value.iat > MESH_GRANT_TTL_SECONDS ||
        claims.value.iat > nowSeconds + GRANT_CLOCK_SKEW_SECONDS
      ) {
        return yield* new MeshGrantRejectedError({ reason: "invalid" });
      }

      const jtiHash = NodeCrypto.createHash("sha256").update(claims.value.jti).digest("base64url");
      const fresh = yield* consumeCloudReplayGuards({
        secrets,
        names: [`${MESH_GRANT_REPLAY_MARKER_PREFIX}${jtiHash}`],
        value: new TextEncoder().encode(DateTime.formatIso(now)),
      });
      if (!fresh) return yield* new MeshGrantRejectedError({ reason: "replayed" });

      const issued = yield* environmentAuth.withMeshSessionLock(
        Effect.gen(function* () {
          const currentUser = yield* readSecret(CLOUD_LINKED_USER_ID);
          const snapshot = yield* membership.snapshot;
          if (
            !Option.contains(currentUser, claims.value.sub) ||
            !(yield* membership.isEnabled) ||
            Option.isNone(snapshot) ||
            !snapshot.value.members.some(
              (member) => member.environmentId === claims.value.meshCaller,
            )
          ) {
            return yield* new MeshGrantRejectedError({ reason: "invalid" });
          }
          return yield* environmentAuth.issueMeshMemberSession({
            meshCaller: claims.value.meshCaller,
            proofKeyThumbprint: proofThumbprint,
          });
        }),
      );
      return { token: issued.token, expiresAt: DateTime.toUtc(issued.expiresAt) };
    },
    Effect.catchTags({
      ServerSettingsError: (cause) => Effect.fail(new MeshSessionIssueError({ cause })),
    }),
    Effect.catchIf(ServerSecretStore.isSecretStoreError, (cause) =>
      Effect.fail(new MeshSessionIssueError({ cause })),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (cause) =>
      Effect.fail(new MeshSessionIssueError({ cause })),
    ),
  );

  return MeshSessionIssuer.of({ redeem });
});

export const layer = Layer.effect(MeshSessionIssuer, make);

const NO_STORE = { "cache-control": "no-store" };
// A grant is a short JWT; anyone who can reach this member can post here.
const MAX_BODY_BYTES = 16 * 1024;

const refused = (status: number, reason: string) =>
  HttpServerResponse.jsonUnsafe({ reason }, { status, headers: NO_STORE });

export const routeLayer = HttpRouter.add(
  "POST",
  MESH_SESSION_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.json.pipe(
      Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(MAX_BODY_BYTES)),
      Effect.flatMap(decodeSessionRequest),
      Effect.option,
    );
    if (Option.isNone(body)) return refused(400, "invalid_request");
    const proofThumbprint = yield* verifyRequestDpopProof({ request }).pipe(Effect.option);
    if (Option.isNone(proofThumbprint)) {
      return HttpServerResponse.setHeader(
        refused(401, "invalid_proof"),
        "www-authenticate",
        "DPoP",
      );
    }
    const issuer = yield* MeshSessionIssuer;
    return yield* issuer
      .redeem({ grant: body.value.grant, proofThumbprint: proofThumbprint.value })
      .pipe(
        Effect.map((session) =>
          HttpServerResponse.jsonUnsafe(encodeSessionResponse(session), { headers: NO_STORE }),
        ),
        Effect.catchTags({
          MeshGrantRejectedError: (error) =>
            Effect.succeed(
              refused(
                error.reason === "disabled" || error.reason === "not-linked" ? 403 : 401,
                error.reason,
              ),
            ),
          MeshSessionIssueError: (error) =>
            Effect.logError("Mesh session issue failed", { cause: error.cause }).pipe(
              Effect.as(refused(500, "internal_error")),
            ),
        }),
      );
  }),
);
