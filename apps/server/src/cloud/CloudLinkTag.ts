// @effect-diagnostics deterministicKeys:off -- Preserve the service key while moving its lazy interface.
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
/**
 * The T3 Connect link lifecycle of this environment: linking it to the relay,
 * applying and reading the link, unlinking, answering the relay's signed health
 * and mint requests, and keeping the managed tunnel registered, recovered and
 * released. HTTP handlers, server startup and shutdown all go through it.
 */
import type {
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudPreferencesRequest,
  EnvironmentCloudRelayConfigResult,
} from "@t3tools/contracts";
import type {
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentHealthResponse,
  RelayEnvironmentLinkProof,
  RelayEnvironmentMintResponse,
  RelayLinkProofRequest,
  RelayManagedEndpointRuntimeConfig,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import type { HttpServerRequest } from "effect/http";
import type * as HttpClientError from "effect/http/HttpClientError";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type { CliDesiredLinkMode } from "./CliState.ts";
import type * as CliTokenManager from "./CliTokenManager.ts";
import type * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { type RelayRequestError, shouldRetryRelayRequest } from "./relayResponse.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
/** Secret store name prefixes of cloud replay markers. The server prunes expired ones. */
export const CLOUD_REPLAY_MARKER_PREFIXES = [
  CLOUD_MINT_NONCE_PREFIX,
  CLOUD_MINT_JTI_PREFIX,
  CLOUD_HEALTH_NONCE_PREFIX,
  CLOUD_HEALTH_JTI_PREFIX,
] as const;
const RELAY_CONFIG_FIELD_MESSAGES = {
  relayUrl: "Relay URL must be a secure absolute HTTPS URL.",
  relayIssuer: "Relay issuer must be a secure absolute HTTPS URL.",
  environmentCredential: "Relay environment credential is required.",
  cloudUserId: "Cloud user id is required.",
  cloudMintPublicKey: "Cloud mint public key must be a valid Ed25519 public key.",
} as const;

/** The relay sent a link configuration this environment cannot install. */
export class CloudLinkRelayConfigInvalidError extends Schema.TaggedError<CloudLinkRelayConfigInvalidError>()(
  "CloudLinkRelayConfigInvalidError",
  {
    field: Schema.Literals([
      "relayUrl",
      "relayIssuer",
      "environmentCredential",
      "cloudUserId",
      "cloudMintPublicKey",
    ]),
  },
) {
  override get message(): string {
    return RELAY_CONFIG_FIELD_MESSAGES[this.field];
  }
}

/**
 * A link was asked to point at an origin it may not serve: a link proof request
 * that did not reach this server directly on loopback (`endpoint`), or a local
 * origin that is not a bare http(s) origin (`local`).
 */
export class CloudLinkOriginInvalidError extends Schema.TaggedError<CloudLinkOriginInvalidError>()(
  "CloudLinkOriginInvalidError",
  { origin: Schema.Literals(["endpoint", "local"]) },
) {
  override get message(): string {
    return this.origin === "endpoint"
      ? "Invalid managed endpoint origin."
      : "Could not resolve local environment origin.";
  }
}

export class CloudLinkNotLinkedError extends Schema.TaggedError<CloudLinkNotLinkedError>()(
  "CloudLinkNotLinkedError",
  {},
) {
  override get message(): string {
    return "Link this environment to T3 Connect first.";
  }
}

export class CloudLinkAccountMismatchError extends Schema.TaggedError<CloudLinkAccountMismatchError>()(
  "CloudLinkAccountMismatchError",
  {},
) {
  override get message(): string {
    return "This environment is already linked to a different cloud account. Unlink it before switching accounts.";
  }
}

/** Linking from the CLI needs the authorization `t3 connect link` stores. */
export class CloudLinkAuthorizationMissingError extends Schema.TaggedError<CloudLinkAuthorizationMissingError>()(
  "CloudLinkAuthorizationMissingError",
  {},
) {
  override get message(): string {
    return "Run `t3 connect link` to authorize this environment.";
  }
}

const SignedRelayRequest = Schema.Literals(["health", "mint"]);

/** A signed relay request whose proof does not verify for this environment. */
export class CloudLinkProofRejectedError extends Schema.TaggedError<CloudLinkProofRejectedError>()(
  "CloudLinkProofRejectedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Invalid cloud ${this.request} request.`;
  }
}

/** A signed relay request whose proof was already used once. */
export class CloudLinkProofReplayedError extends Schema.TaggedError<CloudLinkProofReplayedError>()(
  "CloudLinkProofReplayedError",
  { request: SignedRelayRequest },
) {
  override get message(): string {
    return `Cloud ${this.request} request was already consumed.`;
  }
}

/** The stored tunnel changed while its registration was in flight. */
export class CloudLinkTunnelSupersededError extends Schema.TaggedError<CloudLinkTunnelSupersededError>()(
  "CloudLinkTunnelSupersededError",
  {},
) {
  override get message(): string {
    return "The managed tunnel configuration changed during registration.";
  }
}

/**
 * The managed tunnel is not serving: its connector did not start
 * (`runtime-not-started`, with the runtime's status), or the relay never
 * confirmed this server's origin (`origin-unconfirmed`).
 */
export class CloudLinkEndpointUnavailableError extends Schema.TaggedError<CloudLinkEndpointUnavailableError>()(
  "CloudLinkEndpointUnavailableError",
  {
    reason: Schema.Literals(["runtime-not-started", "origin-unconfirmed"]),
    endpointRuntimeStatus: Schema.Unknown,
  },
) {
  override get message(): string {
    return this.reason === "runtime-not-started"
      ? "Managed endpoint runtime could not be started."
      : "Managed endpoint origin could not be confirmed.";
  }
}

const INTERNAL_OPERATION_MESSAGES = {
  "relay-url-unconfigured":
    "T3CODE_RELAY_URL must be configured as a secure absolute HTTPS origin.",
  "generate-link-proof": "Could not generate environment link proof.",
  "persist-relay-config": "Could not persist environment relay configuration.",
  "register-endpoint-origin": "Could not register the managed endpoint origin.",
  "resolve-server-origin": "Could not resolve the local server origin.",
  "persist-desired-link": "Could not persist desired T3 Connect link state.",
  "sign-recovery-proof": "Could not sign the managed tunnel recovery request.",
  "unsupported-recovered-tunnel":
    "T3 Connect returned an unsupported managed tunnel configuration.",
  "persist-recovered-tunnel": "Could not persist the recovered managed tunnel configuration.",
  "read-relay-config": "Could not read environment relay configuration.",
  "remove-relay-config": "Could not remove environment relay configuration.",
  "update-webhook-settings": "Could not update T3 Connect webhook settings.",
  "read-preferences": "Could not read environment cloud preferences.",
  "persist-preferences": "Could not persist environment cloud preferences.",
  "answer-health": "Could not answer cloud health request.",
  "issue-credential": "Could not issue cloud connection credential.",
} as const;

/** A link step failed on this machine: storage, signing, or an unexpected relay answer. */
export class CloudLinkInternalError extends Schema.TaggedError<CloudLinkInternalError>()(
  "CloudLinkInternalError",
  {
    operation: Schema.Literals(
      Object.keys(INTERNAL_OPERATION_MESSAGES) as [
        keyof typeof INTERNAL_OPERATION_MESSAGES,
        ...Array<keyof typeof INTERNAL_OPERATION_MESSAGES>,
      ],
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return INTERNAL_OPERATION_MESSAGES[this.operation];
  }
}

const isPermanentLinkError = Schema.is(
  Schema.Union([
    CloudLinkRelayConfigInvalidError,
    CloudLinkOriginInvalidError,
    CloudLinkNotLinkedError,
    CloudLinkAccountMismatchError,
    CloudLinkAuthorizationMissingError,
    CloudLinkProofRejectedError,
    CloudLinkProofReplayedError,
    CloudLinkTunnelSupersededError,
  ]),
);

/** Whether a failed link step may succeed on retry: not when the relay or this server refused it. */
export const shouldRetryCloudLink = (error: unknown): boolean =>
  shouldRetryRelayRequest(error) && !isPermanentLinkError(error);

/** A failed rollback leaves a setting changed; it is logged, not hidden. */
/** Records each one-shot marker; false when any already existed, so the request is a replay. */
export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.forEach(
    input.names,
    (name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

export type CloudLinkError =
  | CloudLinkAccountMismatchError
  | CloudLinkAuthorizationMissingError
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkNotLinkedError
  | CloudLinkOriginInvalidError
  | CloudLinkProofRejectedError
  | CloudLinkProofReplayedError
  | CloudLinkRelayConfigInvalidError
  | CloudLinkTunnelSupersededError;

/** Failures of the link work that talks to the relay: linking, recovery and shutdown. */
export type CloudLinkBackgroundError =
  | CloudLinkEndpointUnavailableError
  | CloudLinkInternalError
  | CloudLinkOriginInvalidError
  | RelayRequestError
  | ServerSecretStore.SecretStoreError
  | Schema.SchemaError
  | PlatformError.PlatformError;

export type ManagedTunnelRegistration =
  | { readonly status: "not_linked" | "superseded" | "revoked" }
  | { readonly status: "recovery_required"; readonly config: RelayManagedEndpointRuntimeConfig }
  | {
      readonly status: "ready";
      readonly endpointRuntimeStatus: ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus;
    };

export class CloudLink extends Context.Service<
  CloudLink,
  {
    /**
     * Signs the proof the relay asks for to link this environment. The request
     * must reach this server directly on the loopback origin it names.
     */
    readonly linkProof: (
      request: RelayLinkProofRequest,
      httpRequest: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<
      RelayEnvironmentLinkProof,
      CloudLinkOriginInvalidError | CloudLinkInternalError | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Installs the link the relay returned and, for a managed tunnel, confirms its origin. */
    readonly applyRelayConfig: (
      payload: RelayEnvironmentConfigRequest,
    ) => Effect.Effect<
      EnvironmentCloudRelayConfigResult,
      | CloudLinkAccountMismatchError
      | CloudLinkEndpointUnavailableError
      | CloudLinkInternalError
      | CloudLinkOriginInvalidError
      | CloudLinkRelayConfigInvalidError
      | CloudLinkTunnelSupersededError
      | EnvironmentAuth.ServerAuthInternalError
      | RelayRequestError
    >;
    readonly linkState: () => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkInternalError
    >;
    /** Stops the tunnel and forgets the link, including the CLI's wish to keep it. */
    readonly unlink: () => Effect.Effect<EnvironmentCloudRelayConfigResult, CloudLinkInternalError>;
    /**
     * Saves this environment's T3 Connect preferences, all or nothing, and
     * returns the link state. The activity setting is saved first. Holding
     * webhooks while offline is decided by the relay, so the relay is told
     * before the local copy is saved. If either step fails, the activity
     * setting is put back, and so is the relay when only the local save failed.
     */
    readonly updatePreferences: (
      input: EnvironmentCloudPreferencesRequest,
    ) => Effect.Effect<
      EnvironmentCloudLinkStateResult,
      CloudLinkNotLinkedError | CloudLinkInternalError
    >;
    /** Answers the relay's signed health check once per proof. */
    readonly answerHealthRequest: (
      request: RelayCloudEnvironmentHealthRequest,
    ) => Effect.Effect<
      RelayEnvironmentHealthResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Issues a short-lived pairing credential for a client the relay vouched for, once per proof. */
    readonly mintCredential: (
      request: RelayCloudMintCredentialRequest,
    ) => Effect.Effect<
      RelayEnvironmentMintResponse,
      | CloudLinkProofRejectedError
      | CloudLinkProofReplayedError
      | CloudLinkInternalError
      | EnvironmentAuth.ServerAuthInternalError
    >;
    /** Links this environment with the stored CLI authorization and records the CLI's wish. */
    readonly reconcileDesiredLink: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode,
      | CloudLinkBackgroundError
      | CloudLinkAccountMismatchError
      | CloudLinkAuthorizationMissingError
      | CloudLinkRelayConfigInvalidError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliTokenManagerError
    >;
    /** As `reconcileDesiredLink`, but returns null when the CLI no longer wants a link. */
    readonly reconcileDesiredLinkIfStillDesired: (
      localOrigin: string,
    ) => Effect.Effect<
      CliDesiredLinkMode | null,
      | CloudLinkBackgroundError
      | CloudLinkAccountMismatchError
      | CloudLinkAuthorizationMissingError
      | CloudLinkRelayConfigInvalidError
      | EnvironmentAuth.ServerAuthInternalError
      | CliTokenManager.CloudCliTokenManagerError
    >;
    /** Tells the relay which local origin the stored tunnel serves, then starts it. */
    readonly registerManagedTunnelRecovery: (
      localOrigin: string,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<ManagedTunnelRegistration, CloudLinkBackgroundError>;
    /** Asks the relay for a replacement tunnel, unless the stored one changed meanwhile. */
    readonly recoverManagedTunnel: (
      localOrigin: string,
      expectedConfig?: RelayManagedEndpointRuntimeConfig,
      options?: { readonly retryRuntimeFailures?: boolean },
    ) => Effect.Effect<boolean, CloudLinkBackgroundError>;
    /**
     * Starts the stored tunnel. By default only one the relay already confirmed
     * on this origin; startup falls back to any stored tunnel when the relay
     * stays unreachable.
     */
    readonly startManagedTunnelIfOriginConfirmed: (
      localOrigin: string,
      options?: { readonly requireConfirmedOrigin?: boolean },
    ) => Effect.Effect<
      boolean,
      | CloudLinkEndpointUnavailableError
      | CloudLinkOriginInvalidError
      | ServerSecretStore.SecretStoreError
    >;
    /** Deletes a CLI-managed tunnel when this server goes offline for good. */
    readonly releaseManagedTunnelOnShutdown: () => Effect.Effect<
      boolean,
      | CloudLinkBackgroundError
      | CliTokenManager.CloudCliTokenManagerError
      | HttpClientError.HttpClientError
    >;
  }
>()("t3/cloud/CloudLink") {}

const make = Effect.gen(function* () {
  const live = yield* cacheInOwnerScope(
    Effect.promise(() => import("./CloudLink.ts")).pipe(Effect.flatMap((module) => module.make)),
  );
  return CloudLink.of({
    linkProof: (...args: Parameters<CloudLink["Service"]["linkProof"]>) =>
      live.pipe(Effect.flatMap((value) => value.linkProof(...args))),
    applyRelayConfig: (...args: Parameters<CloudLink["Service"]["applyRelayConfig"]>) =>
      live.pipe(Effect.flatMap((value) => value.applyRelayConfig(...args))),
    linkState: (...args: Parameters<CloudLink["Service"]["linkState"]>) =>
      live.pipe(Effect.flatMap((value) => value.linkState(...args))),
    unlink: (...args: Parameters<CloudLink["Service"]["unlink"]>) =>
      live.pipe(Effect.flatMap((value) => value.unlink(...args))),
    updatePreferences: (...args: Parameters<CloudLink["Service"]["updatePreferences"]>) =>
      live.pipe(Effect.flatMap((value) => value.updatePreferences(...args))),
    answerHealthRequest: (...args: Parameters<CloudLink["Service"]["answerHealthRequest"]>) =>
      live.pipe(Effect.flatMap((value) => value.answerHealthRequest(...args))),
    mintCredential: (...args: Parameters<CloudLink["Service"]["mintCredential"]>) =>
      live.pipe(Effect.flatMap((value) => value.mintCredential(...args))),
    reconcileDesiredLink: (...args: Parameters<CloudLink["Service"]["reconcileDesiredLink"]>) =>
      live.pipe(Effect.flatMap((value) => value.reconcileDesiredLink(...args))),
    reconcileDesiredLinkIfStillDesired: (
      ...args: Parameters<CloudLink["Service"]["reconcileDesiredLinkIfStillDesired"]>
    ) => live.pipe(Effect.flatMap((value) => value.reconcileDesiredLinkIfStillDesired(...args))),
    registerManagedTunnelRecovery: (
      ...args: Parameters<CloudLink["Service"]["registerManagedTunnelRecovery"]>
    ) => live.pipe(Effect.flatMap((value) => value.registerManagedTunnelRecovery(...args))),
    recoverManagedTunnel: (...args: Parameters<CloudLink["Service"]["recoverManagedTunnel"]>) =>
      live.pipe(Effect.flatMap((value) => value.recoverManagedTunnel(...args))),
    startManagedTunnelIfOriginConfirmed: (
      ...args: Parameters<CloudLink["Service"]["startManagedTunnelIfOriginConfirmed"]>
    ) => live.pipe(Effect.flatMap((value) => value.startManagedTunnelIfOriginConfirmed(...args))),
    releaseManagedTunnelOnShutdown: (
      ...args: Parameters<CloudLink["Service"]["releaseManagedTunnelOnShutdown"]>
    ) => live.pipe(Effect.flatMap((value) => value.releaseManagedTunnelOnShutdown(...args))),
  });
});
export const layer = Layer.effect(CloudLink, make);
