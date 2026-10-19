import {
  AuthMcpClientAccess,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  EnvironmentHttpApi,
  EnvironmentId,
  type PeerLink,
  type PeerLinkCreateInput,
  PeerLinkError,
  type PeerLinkStatus,
  type PeerLinkSummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { isLocalLoopbackHost, isTailnetHost } from "@t3tools/shared/hostClassification";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";

/** The redirect registered for a link. Nothing ever listens there: the code comes back in the response. */
const LINK_REDIRECT_URI = "http://127.0.0.1/t3code-peer-link";
/**
 * How long a peer's descriptor may take before a route counts as unreachable.
 * A tailnet or relayed route to a machine that is waking up takes longer.
 */
const probeTimeout = (origin: string) =>
  isLocalLoopbackHost(new URL(origin).hostname) ? Duration.seconds(3) : Duration.seconds(10);

interface ResolvedPeerLink {
  readonly link: PeerLink;
  readonly url: string;
  readonly token: string;
}

/** Peer sessions use the existing MCP OAuth flow; tokens stay in the secret store. */
export class PeerLinks extends Context.Service<
  PeerLinks,
  {
    readonly link: (input: PeerLinkCreateInput) => Effect.Effect<PeerLink, PeerLinkError>;
    readonly list: Effect.Effect<ReadonlyArray<PeerLinkSummary>, PeerLinkError>;
    /** The stored link, without asking the peer whether it answers. */
    readonly get: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<Option.Option<PeerLink>, PeerLinkError>;
    /** Forgets the link here. The peer still lists the session until it is revoked there. */
    readonly unlink: (environmentId: EnvironmentId) => Effect.Effect<boolean, PeerLinkError>;
    readonly resolve: (
      environmentId: EnvironmentId,
    ) => Effect.Effect<ResolvedPeerLink, PeerLinkError>;
    readonly recordOutcome: (
      environmentId: EnvironmentId,
      outcome: { readonly error: string | null },
    ) => Effect.Effect<void>;
  }
>()("t3/peer/PeerLinks") {}

interface PeerLinkRow {
  readonly environment_id: string;
  readonly secret_name: string;
  readonly label: string;
  readonly urls_json: string;
  readonly access: string;
  readonly linked_at: string;
  readonly expires_at: string;
  readonly last_reached_at: string | null;
  readonly last_error: string | null;
}

const decodeUrls = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeUrls = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccess = Schema.decodeUnknownEffect(AuthMcpClientAccess);

const failStorage = (cause: unknown) =>
  Effect.logWarning("Peer link storage failed", cause).pipe(
    Effect.andThen(
      Effect.fail(
        new PeerLinkError({
          reason: "storage",
          message:
            "Linked environments could not be read or saved here. The server log has details.",
          cause,
        }),
      ),
    ),
  );

// Only loopback and Tailscale-specific hosts can use HTTP for credentials.
const peerOrigin = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is not an http or https address.`,
      }),
    );
  }
  if (
    parsed.protocol === "http:" &&
    !isLocalLoopbackHost(parsed.hostname) &&
    !isTailnetHost(parsed.hostname)
  ) {
    return Effect.fail(
      new PeerLinkError({
        reason: "unreachable",
        message: `${url} is plain http, which would send the link's credentials unencrypted. Use HTTPS, or HTTP with loopback, a Tailscale .ts.net name, or Tailscale IPv6.`,
      }),
    );
  }
  return Effect.succeed(parsed.origin);
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    ),
  );
  const environment = yield* ServerEnvironment.ServerEnvironment;

  const newSecretName = crypto.randomBytes(16).pipe(
    Effect.map((bytes) => `peer-link-${Hex.encode(bytes)}`),
    Effect.orDie,
  );

  const clientFor = (origin: string) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

  const describe = (origin: string) =>
    clientFor(origin).pipe(
      Effect.flatMap((client) => client.metadata.descriptor()),
      Effect.timeout(probeTimeout(origin)),
      Effect.option,
    );

  const toLink = (row: PeerLinkRow) =>
    Effect.gen(function* () {
      return {
        environmentId: EnvironmentId.make(row.environment_id),
        label: row.label,
        urls: yield* decodeUrls(row.urls_json),
        access: yield* decodeAccess(row.access),
        linkedAt: DateTime.makeUnsafe(row.linked_at),
        expiresAt: DateTime.makeUnsafe(row.expires_at),
        lastReachedAt:
          row.last_reached_at === null ? null : DateTime.makeUnsafe(row.last_reached_at),
        lastError: row.last_error,
      } satisfies PeerLink;
    }).pipe(Effect.catch(failStorage));

  const readRows = sql<PeerLinkRow>`
    SELECT * FROM peer_environment_links ORDER BY label, environment_id
  `.pipe(Effect.catch(failStorage));

  const readRow = (environmentId: EnvironmentId) =>
    sql<PeerLinkRow>`
      SELECT * FROM peer_environment_links WHERE environment_id = ${environmentId}
    `.pipe(
      Effect.catch(failStorage),
      Effect.map((rows) => Option.fromNullishOr(rows[0])),
    );

  const signIn = (origin: string, input: PeerLinkCreateInput, clientName: string) =>
    Effect.gen(function* () {
      const client = yield* clientFor(origin);
      // Only the peer's own refusals are rejections. A dropped connection or
      // an answer this version cannot read is classified below.
      const registered = yield* client.mcpOAuth
        .register({ payload: { client_name: clientName, redirect_uris: [LINK_REDIRECT_URI] } })
        .pipe(
          // A plain Schema.Error has no tag to catch by.
          Effect.catchIf(Schema.is(AuthMcpRegistrationError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused to register this environment: ${error.message}`,
              }),
            ),
          ),
        );
      const verifier = Base64Url.encode(yield* crypto.randomBytes(32).pipe(Effect.orDie));
      const challenge = Base64Url.encode(
        yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(Effect.orDie),
      );
      const state = Base64Url.encode(yield* crypto.randomBytes(16).pipe(Effect.orDie));
      const resource = `${origin}/mcp`;
      const decided = yield* client.mcpOAuth
        .decision({
          payload: {
            authorization: {
              response_type: "code",
              client_id: registered.client_id,
              redirect_uri: LINK_REDIRECT_URI,
              code_challenge: challenge,
              code_challenge_method: "S256",
              state,
              resource,
            },
            decision: { _tag: "pairing-code", access: input.access, code: input.pairingCode },
          },
        })
        .pipe(
          Effect.catchTags({
            AuthMcpApprovalError: (error) =>
              Effect.fail(
                new PeerLinkError({ reason: "pairing_rejected", message: error.message }),
              ),
          }),
        );
      const redirect = URL.parse(decided.redirectTo);
      if (redirect === null) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${origin} answered the sign-in with an address this version cannot read. Update both environments.`,
        });
      }
      const code = redirect.searchParams.get("code");
      if (code === null || redirect.searchParams.get("state") !== state) {
        return yield* new PeerLinkError({
          reason: "pairing_rejected",
          message:
            redirect.searchParams.get("error_description") ??
            "The peer did not approve the link. Check the pairing code and try again.",
        });
      }
      return yield* client.mcpOAuth
        .token({
          payload: {
            grant_type: "authorization_code",
            code,
            redirect_uri: LINK_REDIRECT_URI,
            client_id: registered.client_id,
            code_verifier: verifier,
            resource,
          },
        })
        .pipe(
          Effect.catchIf(Schema.is(AuthMcpTokenError), (error) =>
            Effect.fail(
              new PeerLinkError({
                reason: "pairing_rejected",
                message: `The peer refused the sign-in: ${error.message}`,
              }),
            ),
          ),
        );
    }).pipe(
      // Endpoint errors are mapped above; what is left is the transport or an
      // answer this version cannot decode.
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(
            new PeerLinkError({
              reason: "incompatible",
              message: `${origin} answered in a shape this version does not understand. Update both environments.`,
              cause,
            }),
          ),
        HttpClientError: (cause) =>
          Effect.fail(
            new PeerLinkError({
              reason: "unreachable",
              message: `${origin} stopped answering while linking.`,
              cause,
            }),
          ),
      }),
    );

  const link: PeerLinks["Service"]["link"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        const origins = yield* Effect.forEach(
          [input.url, ...(input.alternateUrls ?? [])],
          peerOrigin,
        );
        const primary = origins[0]!;
        const descriptor = yield* describe(primary);
        if (Option.isNone(descriptor)) {
          return yield* new PeerLinkError({
            reason: "not_a_t3_environment",
            message: `Nothing at ${primary} answered as a T3 Code environment.`,
          });
        }
        const peer = descriptor.value;
        const self = yield* environment.getDescriptor;
        if (peer.environmentId === self.environmentId) {
          return yield* new PeerLinkError({
            reason: "self",
            message: "That address is this environment.",
          });
        }
        if (peer.capabilities.mcpModeLimitHeader !== true) {
          return yield* new PeerLinkError({
            reason: "incompatible",
            message: `${peer.label} runs a T3 Code version that cannot keep a linked agent's limits. Update it, then link again.`,
          });
        }
        const issued = yield* signIn(primary, input, `T3 Code · ${self.label}`);
        const now = yield* DateTime.now;
        const linked: PeerLink = {
          environmentId: peer.environmentId,
          label: peer.label,
          urls: origins,
          access: input.access,
          linkedAt: now,
          expiresAt: DateTime.add(now, { seconds: issued.expires_in }),
          lastReachedAt: now,
          lastError: null,
        };
        // A failed or cancelled save must release only its own credential.
        const secretName = yield* newSecretName;
        let committed = false;
        yield* Effect.addFinalizer(() =>
          committed
            ? Effect.void
            : secrets.remove(secretName).pipe(Effect.ignoreCause({ log: true })),
        );
        yield* secrets
          .set(secretName, new TextEncoder().encode(issued.access_token))
          .pipe(Effect.catch(failStorage));
        const urlsJson = yield* encodeUrls(origins).pipe(Effect.catch(failStorage));
        const previous = yield* readRow(peer.environmentId);
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO peer_environment_links (
                environment_id, secret_name, label, urls_json, access, linked_at, expires_at,
                last_reached_at, last_error
              ) VALUES (
                ${linked.environmentId}, ${secretName}, ${linked.label}, ${urlsJson}, ${linked.access},
                ${DateTime.formatIso(linked.linkedAt)}, ${DateTime.formatIso(linked.expiresAt)},
                ${DateTime.formatIso(now)}, NULL
              )
              ON CONFLICT (environment_id) DO UPDATE SET
                secret_name = excluded.secret_name,
                label = excluded.label,
                urls_json = excluded.urls_json,
                access = excluded.access,
                linked_at = excluded.linked_at,
                expires_at = excluded.expires_at,
                last_reached_at = excluded.last_reached_at,
                last_error = NULL
            `.pipe(Effect.catch(failStorage));
            // Commit and ownership transfer cannot be interrupted between them.
            committed = true;
            if (Option.isSome(previous) && previous.value.secret_name !== secretName) {
              yield* secrets.remove(previous.value.secret_name).pipe(Effect.ignore);
            }
          }),
        );
        return linked;
      }),
    );

  const findPeer = (link: PeerLink) =>
    Effect.gen(function* () {
      let incompatibleUrl: string | undefined;
      for (const url of link.urls) {
        const found = yield* describe(url);
        if (Option.isSome(found) && found.value.environmentId === link.environmentId) {
          if (found.value.capabilities.mcpModeLimitHeader === true) {
            return Option.some({ url, compatible: true });
          }
          incompatibleUrl ??= url;
        }
      }
      return incompatibleUrl === undefined
        ? Option.none()
        : Option.some({ url: incompatibleUrl, compatible: false });
    });

  const statusOf = (link: PeerLink, now: DateTime.Utc) =>
    DateTime.isLessThanOrEqualTo(link.expiresAt, now)
      ? Effect.succeed<PeerLinkStatus>("expired")
      : findPeer(link).pipe(
          Effect.map((peer): PeerLinkStatus =>
            Option.isNone(peer)
              ? "unreachable"
              : peer.value.compatible
                ? "reachable"
                : "incompatible",
          ),
        );

  const list: PeerLinks["Service"]["list"] = Effect.gen(function* () {
    const links = yield* Effect.forEach(yield* readRows, toLink);
    const now = yield* DateTime.now;
    return yield* Effect.forEach(
      links,
      (link) => statusOf(link, now).pipe(Effect.map((status) => ({ ...link, status }))),
      { concurrency: "unbounded" },
    );
  });

  const get: PeerLinks["Service"]["get"] = (environmentId) =>
    readRow(environmentId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => Effect.map(toLink(row), Option.some),
        }),
      ),
    );

  const unlink: PeerLinks["Service"]["unlink"] = (environmentId) =>
    Effect.gen(function* () {
      const deleted = yield* sql<{ secret_name: string }>`
        DELETE FROM peer_environment_links WHERE environment_id = ${environmentId}
        RETURNING secret_name
      `.pipe(Effect.catch(failStorage));
      for (const row of deleted) {
        yield* secrets.remove(row.secret_name).pipe(Effect.catch(failStorage));
      }
      return deleted.length > 0;
    });

  const resolve: PeerLinks["Service"]["resolve"] = (environmentId) =>
    Effect.gen(function* () {
      const row = yield* readRow(environmentId);
      if (Option.isNone(row)) {
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `This environment is not linked to ${environmentId}. Run t3 environment list to see linked environments.`,
        });
      }
      const link = yield* toLink(row.value);
      if (DateTime.isLessThanOrEqualTo(link.expiresAt, yield* DateTime.now)) {
        return yield* new PeerLinkError({
          reason: "expired",
          message: `The link to ${link.label} expired. Link it again with a new pairing code from ${link.label}.`,
        });
      }
      const peer = yield* findPeer(link);
      if (Option.isNone(peer)) {
        return yield* new PeerLinkError({
          reason: "unreachable",
          message: `${link.label} did not answer at ${link.urls.join(", ")}.`,
        });
      }
      if (!peer.value.compatible) {
        return yield* new PeerLinkError({
          reason: "incompatible",
          message: `${link.label} can no longer keep a linked agent's limits. Update it before using this link.`,
        });
      }
      const stored = yield* secrets.get(row.value.secret_name).pipe(Effect.catch(failStorage));
      if (Option.isNone(stored)) {
        return yield* new PeerLinkError({
          reason: "unknown_link",
          message: `The link to ${link.label} lost its credential. Link it again.`,
        });
      }
      return { link, url: peer.value.url, token: new TextDecoder().decode(stored.value) };
    });

  const recordOutcome: PeerLinks["Service"]["recordOutcome"] = (environmentId, outcome) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        outcome.error === null
          ? sql`
              UPDATE peer_environment_links
              SET last_reached_at = ${DateTime.formatIso(now)}, last_error = NULL
              WHERE environment_id = ${environmentId}
            `
          : sql`
              UPDATE peer_environment_links SET last_error = ${outcome.error}
              WHERE environment_id = ${environmentId}
            `,
      ),
      Effect.asVoid,
      Effect.ignoreCause({ log: true }),
    );

  return PeerLinks.of({ link, list, get, unlink, resolve, recordOutcome });
});

export const layer = Layer.effect(PeerLinks, make);
