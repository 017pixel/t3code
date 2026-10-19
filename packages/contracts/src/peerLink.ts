import * as Schema from "effect/Schema";

import { AuthMcpClientAccess } from "./auth.ts";
import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PeerLink = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** Addresses the peer was linked at, tried in order. */
  urls: Schema.Array(TrimmedNonEmptyString),
  access: AuthMcpClientAccess,
  linkedAt: Schema.DateTimeUtc,
  expiresAt: Schema.DateTimeUtc,
  lastReachedAt: Schema.NullOr(Schema.DateTimeUtc),
  lastError: Schema.NullOr(Schema.String),
});
export type PeerLink = typeof PeerLink.Type;

/** Descriptor reachability and local expiry; this does not authenticate the peer session. */
export const PeerLinkStatus = Schema.Literals(["reachable", "unreachable", "expired"]);
export type PeerLinkStatus = typeof PeerLinkStatus.Type;

export const PeerLinkSummary = Schema.Struct({
  ...PeerLink.fields,
  status: PeerLinkStatus,
});
export type PeerLinkSummary = typeof PeerLinkSummary.Type;

export const PeerLinkCreateInput = Schema.Struct({
  /** Where the peer answers: HTTPS, loopback, or a Tailscale hostname/IPv6 base URL. */
  url: TrimmedNonEmptyString,
  /** More addresses for the same peer, tried after `url`. */
  alternateUrls: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  /** A pairing code from the peer (`t3 pair` there, or its Connections settings). */
  pairingCode: TrimmedNonEmptyString,
  access: AuthMcpClientAccess,
});
export type PeerLinkCreateInput = typeof PeerLinkCreateInput.Type;

export const PeerLinkRemoveInput = Schema.Struct({ environmentId: EnvironmentId });
export type PeerLinkRemoveInput = typeof PeerLinkRemoveInput.Type;

export const PeerLinkRemoveResult = Schema.Struct({ removed: Schema.Boolean });
export type PeerLinkRemoveResult = typeof PeerLinkRemoveResult.Type;

/** Why linking or calling a peer failed, in words a user can act on. */
export class PeerLinkError extends Schema.TaggedError<PeerLinkError>()("PeerLinkError", {
  reason: Schema.Literals([
    "unreachable",
    "not_a_t3_environment",
    "incompatible",
    "self",
    "pairing_rejected",
    "expired",
    "unknown_link",
    "storage",
  ]),
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
