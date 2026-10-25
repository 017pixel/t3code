// EXPERIMENTAL mesh v1: `mesh-member` sessions this machine holds on other members. A session
// comes from a relay grant redeemed directly at the member and is bound to this machine's mesh
// DPoP key, so a token read off a plain-HTTP LAN route is useless without the key.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no P-256 signing.
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import {
  type EnvironmentId,
  MESH_SESSION_PATH,
  type MeshMemberView,
  type MeshRoute,
  MeshSessionResponse,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "@t3tools/shared/dpop";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  checkMeshRoute,
  meshRouteCandidates,
  meshRouteUrl,
  walkMeshRoutes,
  withoutRedirects,
} from "./MeshRoutes.ts";
import {
  MeshCredentials,
  MeshMemberOfflineError,
  MeshMemberUnreachableError,
  MeshMembership,
  MeshNotMemberError,
  type MeshSession,
  MeshSessionRefusedError,
  MeshUnavailableError,
} from "./Services.ts";

const MESH_DPOP_KEY_SECRET = "mesh-dpop-p256-key";
/** Half the member's one-hour session, so a renewal never races its expiry. */
const RENEW_AFTER = Duration.minutes(30);
const REDEEM_TIMEOUT = Duration.seconds(10);
// Reading the interfaces costs a syscall per interface; addresses rarely change faster.
const NETWORK_CHECK_INTERVAL_MS = 10_000;

const MeshDpopKey = Schema.Struct({
  privateJwk: Schema.Struct({ ...DpopPublicJwk.fields, d: Schema.String }),
  publicJwk: DpopPublicJwk,
});
type MeshDpopKey = typeof MeshDpopKey.Type;
const MeshDpopKeyJson = Schema.fromJsonString(MeshDpopKey);
const decodeMeshDpopKey = Schema.decodeUnknownEffect(MeshDpopKeyJson);
const encodeMeshDpopKey = Schema.encodeEffect(MeshDpopKeyJson);
const decodeSessionResponse = Schema.decodeUnknownEffect(Schema.toCodecJson(MeshSessionResponse));

const generateMeshDpopKey = (): MeshDpopKey => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const privateJwk = privateKey.export({ format: "jwk" });
  const publicJwk = publicKey.export({ format: "jwk" });
  return {
    privateJwk: { kty: "EC", crv: "P-256", x: publicJwk.x!, y: publicJwk.y!, d: privateJwk.d! },
    publicJwk: { kty: "EC", crv: "P-256", x: publicJwk.x!, y: publicJwk.y! },
  };
};

/** One persistent key: members bind every session to it, across restarts. */
const getOrCreateMeshDpopKey = Effect.fn("MeshCredentials.getOrCreateKey")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
) {
  const read = secrets.get(MESH_DPOP_KEY_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeedNone,
        onSome: (bytes) =>
          decodeMeshDpopKey(new TextDecoder().decode(bytes)).pipe(Effect.map(Option.some)),
      }),
    ),
  );
  const existing = yield* read;
  if (Option.isSome(existing)) return existing.value;
  const generated = generateMeshDpopKey();
  const encoded = yield* encodeMeshDpopKey(generated);
  return yield* secrets.create(MESH_DPOP_KEY_SECRET, new TextEncoder().encode(encoded)).pipe(
    Effect.as(generated),
    Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () =>
      read.pipe(Effect.flatMap(Effect.fromOption)),
    ),
  );
});

const base64UrlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** Local IPv4 addresses. A change means routes chosen before may no longer work. */
export const MeshNetworkFingerprint = Context.Reference<Effect.Effect<string>>(
  "t3/mesh/MeshCredentials/MeshNetworkFingerprint",
  {
    defaultValue: () =>
      Effect.sync(() =>
        Object.values(NodeOS.networkInterfaces())
          .flatMap((entries) => entries ?? [])
          .filter((entry) => !entry.internal && entry.family === "IPv4")
          .map((entry) => entry.address)
          .toSorted()
          .join(","),
      ),
  },
);

/** The loaded mesh key, ready to sign proofs. */
interface MeshKey {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly thumbprint: string;
  readonly proofHeader: string;
}

interface CachedSession {
  readonly token: string;
  readonly expiresAt: DateTime.Utc;
  readonly issuedAt: DateTime.Utc;
  readonly connectUrl: string | null;
  readonly lastRoute: MeshRoute;
}

interface CachedRoute {
  readonly route: MeshRoute;
  /** The member's addresses when the route was chosen; new ones mean a new walk. */
  readonly candidates: string;
}

const candidatesKey = (candidates: ReadonlyArray<MeshRoute>) =>
  candidates.map((candidate) => `${candidate.kind} ${candidate.httpBaseUrl}`).join("\n");

const make = Effect.gen(function* () {
  const membership = yield* MeshMembership;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const readNetworkFingerprint = yield* MeshNetworkFingerprint;

  // Loaded on the first session, so a machine that never uses the mesh never makes a key.
  const keyRef = yield* Ref.make<MeshKey | null>(null);
  const keyLock = yield* Semaphore.make(1);
  const loadKey = keyLock
    .withPermits(1)(
      Effect.gen(function* () {
        const loaded = yield* Ref.get(keyRef);
        if (loaded !== null) return loaded;
        const key = yield* getOrCreateMeshDpopKey(secrets);
        const made: MeshKey = {
          privateKey: NodeCrypto.createPrivateKey({ key: key.privateJwk, format: "jwk" }),
          thumbprint: computeDpopJwkThumbprint(key.publicJwk),
          proofHeader: base64UrlJson({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk }),
        };
        yield* Ref.set(keyRef, made);
        return made;
      }),
    )
    .pipe(Effect.orDie);
  const meshKey = Ref.get(keyRef).pipe(
    Effect.flatMap((key) => (key === null ? loadKey : Effect.succeed(key))),
  );

  const sessionsRef = yield* Ref.make(new Map<EnvironmentId, CachedSession>());
  const routesRef = yield* Ref.make(new Map<EnvironmentId, CachedRoute>());
  const fingerprintRef = yield* Ref.make<{
    readonly fingerprint: string;
    readonly checkedAt: number;
  } | null>(null);
  const locks = new Map<EnvironmentId, Semaphore.Semaphore>();
  const withMemberLock = (environmentId: EnvironmentId) => {
    const lock = locks.get(environmentId) ?? Semaphore.makeUnsafe(1);
    locks.set(environmentId, lock);
    return lock.withPermit;
  };

  /* Signed once per request to another member; the caller's span covers it. */
  const proof = Effect.fnUntraced(function* (method: string, url: string, accessToken?: string) {
    const { privateKey, proofHeader } = yield* meshKey;
    const iat = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
    return yield* Effect.sync(() => {
      const payload = base64UrlJson({
        htm: method.toUpperCase(),
        htu: normalizeDpopHtu(url) ?? url,
        jti: NodeCrypto.randomUUID(),
        iat,
        ...(accessToken === undefined ? {} : { ath: computeDpopAccessTokenHash(accessToken) }),
      });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${proofHeader}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${proofHeader}.${payload}.${signature}`;
    });
  });

  const forget = (environmentId: EnvironmentId, options: { readonly session: boolean }) =>
    Effect.all([
      Ref.update(routesRef, (routes) => {
        const next = new Map(routes);
        next.delete(environmentId);
        return next;
      }),
      options.session
        ? Ref.update(sessionsRef, (sessions) => {
            const next = new Map(sessions);
            next.delete(environmentId);
            return next;
          })
        : Effect.void,
    ]).pipe(Effect.asVoid);

  const forgetRoutesAfterNetworkChange = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const last = yield* Ref.get(fingerprintRef);
    if (last !== null && now - last.checkedAt < NETWORK_CHECK_INTERVAL_MS) return;
    const fingerprint = yield* readNetworkFingerprint;
    yield* Ref.set(fingerprintRef, { fingerprint, checkedAt: now });
    if (last !== null && last.fingerprint !== fingerprint) yield* Ref.set(routesRef, new Map());
  });

  const requireEnabled = Effect.gen(function* () {
    if (yield* membership.isEnabled) return;
    yield* Ref.set(sessionsRef, new Map());
    yield* Ref.set(routesRef, new Map());
    return yield* new MeshUnavailableError({ reason: "disabled" });
  });

  const memberView = Effect.fn("MeshCredentials.memberView")(function* (
    environmentId: EnvironmentId,
  ) {
    const snapshot = yield* membership.snapshot;
    if (Option.isNone(snapshot)) {
      const status = yield* membership.status;
      return yield* new MeshUnavailableError({ reason: status.unavailableReason ?? "connecting" });
    }
    const member = snapshot.value.members.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (
      member === undefined ||
      environmentId === snapshot.value.selfEnvironmentId ||
      member.capabilities.meshMember !== true
    ) {
      return yield* new MeshNotMemberError({ environmentId });
    }
    if (!member.online) return yield* new MeshMemberOfflineError({ environmentId });
    return member;
  });

  const connectUrlOf = (member: MeshMemberView) =>
    member.connectHostname === null ? null : `https://${member.connectHostname}/`;

  /*
   * The cached route while this machine's network and the member's addresses are unchanged. Takes
   * no lock and runs on every captain request; the request span covers it.
   */
  const cachedRoute = Effect.fnUntraced(function* (environmentId: EnvironmentId) {
    yield* forgetRoutesAfterNetworkChange;
    const cached = (yield* Ref.get(routesRef)).get(environmentId);
    if (cached === undefined) return Option.none<MeshRoute>();
    // Without a snapshot (the relay is away) a cached route still works: members call each other
    // directly and never depend on the relay once a session exists.
    if (Option.isNone(yield* membership.snapshot)) return Option.some(cached.route);
    const member = yield* memberView(environmentId);
    return cached.candidates === candidatesKey(meshRouteCandidates(member))
      ? Option.some(cached.route)
      : Option.none<MeshRoute>();
  });

  /** Under the member's lock, so concurrent callers share one walk. */
  const resolveRoute = Effect.fn("MeshCredentials.resolveRoute")(function* (
    environmentId: EnvironmentId,
  ) {
    const cached = yield* cachedRoute(environmentId);
    if (Option.isSome(cached)) return cached.value;
    const candidates = meshRouteCandidates(yield* memberView(environmentId));
    const chosen = yield* walkMeshRoutes(candidates, (route) =>
      checkMeshRoute(route, environmentId).pipe(
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    );
    if (Option.isNone(chosen)) return yield* new MeshMemberUnreachableError({ environmentId });
    yield* Ref.update(routesRef, (routes) =>
      new Map(routes).set(environmentId, {
        route: chosen.value,
        candidates: candidatesKey(candidates),
      }),
    );
    yield* Effect.annotateCurrentSpan({ "mesh.route.kind": chosen.value.kind });
    return chosen.value;
  });

  const postGrant = Effect.fn("MeshCredentials.postGrant")(function* (
    environmentId: EnvironmentId,
    route: MeshRoute,
    grant: string,
  ) {
    const url = meshRouteUrl(route, MESH_SESSION_PATH);
    return yield* HttpClientRequest.post(url).pipe(
      HttpClientRequest.setHeader("dpop", yield* proof("POST", url)),
      HttpClientRequest.bodyJsonUnsafe({ grant }),
      httpClient.execute,
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status !== 200) {
            return yield* new MeshSessionRefusedError({ environmentId, status: response.status });
          }
          return yield* response.json.pipe(Effect.flatMap(decodeSessionResponse));
        }),
      ),
      Effect.timeout(REDEEM_TIMEOUT),
      withoutRedirects,
      Effect.mapError((cause) =>
        cause._tag === "MeshSessionRefusedError"
          ? cause
          : new MeshMemberUnreachableError({ environmentId, cause }),
      ),
    );
  });

  const redeem = Effect.fn("MeshCredentials.redeem")(function* (environmentId: EnvironmentId) {
    const member = yield* memberView(environmentId);
    const attempt = Effect.gen(function* () {
      const route = yield* resolveRoute(environmentId);
      // The grant names this key, and the member checks the proof against it.
      const grant = yield* membership.requestGrant({
        targetEnvironmentId: environmentId,
        jkt: (yield* meshKey).thumbprint,
      });
      return { route, response: yield* postGrant(environmentId, route, grant) };
    });
    // A route that answered the check can still drop the redeem; walk again once.
    const { route, response } = yield* attempt.pipe(
      Effect.catchTags({
        MeshMemberUnreachableError: () =>
          forget(environmentId, { session: false }).pipe(Effect.andThen(attempt)),
      }),
    );
    const cached: CachedSession = {
      token: response.token,
      expiresAt: response.expiresAt,
      issuedAt: yield* DateTime.now,
      connectUrl: connectUrlOf(member),
      lastRoute: route,
    };
    yield* Ref.update(sessionsRef, (sessions) => new Map(sessions).set(environmentId, cached));
    return cached;
  });

  const toMeshSession = (environmentId: EnvironmentId, cached: CachedSession): MeshSession => ({
    environmentId,
    token: cached.token,
    expiresAt: cached.expiresAt,
    route: cached.lastRoute,
    connectUrl: cached.connectUrl,
    authorizationHeaders: ({ method, url }) =>
      proof(method, url, cached.token).pipe(
        Effect.map((dpop) => ({ authorization: `DPoP ${cached.token}`, dpop })),
      ),
  });

  const session: MeshCredentials["Service"]["session"] = Effect.fn("MeshCredentials.session")(
    function* (environmentId) {
      yield* requireEnabled;
      return yield* withMemberLock(environmentId)(
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const cached = (yield* Ref.get(sessionsRef)).get(environmentId);
          if (
            cached !== undefined &&
            DateTime.isLessThan(now, DateTime.addDuration(cached.issuedAt, RENEW_AFTER)) &&
            DateTime.isLessThan(now, cached.expiresAt)
          ) {
            const route = yield* resolveRoute(environmentId);
            const current = { ...cached, lastRoute: route };
            yield* Ref.update(sessionsRef, (sessions) =>
              new Map(sessions).set(environmentId, current),
            );
            return toMeshSession(environmentId, current);
          }
          // Each renewal walks the routes again; the member revokes the earlier session.
          yield* forget(environmentId, { session: false });
          return toMeshSession(environmentId, yield* redeem(environmentId));
        }),
      );
    },
  );

  // A member that left or was removed loses its cached session and route.
  yield* membership.snapshots.pipe(
    Stream.runForEach((snapshot) => {
      const members = new Set(snapshot.members.map((member) => member.environmentId));
      const keep = <V>(entries: Map<EnvironmentId, V>) =>
        new Map([...entries].filter(([environmentId]) => members.has(environmentId)));
      return Effect.all([Ref.update(sessionsRef, keep), Ref.update(routesRef, keep)]);
    }),
    Effect.forkScoped,
  );

  return MeshCredentials.of({
    session,
    // Per captain request; the request span covers these reads.
    route: Effect.fnUntraced(function* (environmentId) {
      yield* requireEnabled;
      const cached = yield* cachedRoute(environmentId);
      if (Option.isSome(cached)) return cached.value;
      return yield* withMemberLock(environmentId)(resolveRoute(environmentId));
    }),
    cachedRoute: Effect.fnUntraced(function* (environmentId) {
      return Option.fromNullishOr((yield* Ref.get(routesRef)).get(environmentId)?.route);
    }),
    invalidate: (environmentId) => forget(environmentId, { session: true }),
    forgetRoute: (environmentId) => forget(environmentId, { session: false }),
    cachedSessions: Ref.get(sessionsRef).pipe(
      Effect.map((sessions) =>
        [...sessions].map(([environmentId, cached]) => ({
          environmentId,
          route: cached.lastRoute,
          expiresAt: cached.expiresAt,
        })),
      ),
    ),
  });
});

export const layer = Layer.effect(MeshCredentials, make);
