import { MeshCloseCode } from "@t3tools/contracts";
import type { MeshView } from "@t3tools/shared/meshRelayObject";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import type * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as RelayConfiguration from "../Config.ts";

export class MeshDirectoryError extends Schema.TaggedError<MeshDirectoryError>()(
  "MeshDirectoryError",
  {
    operation: Schema.Literals(["open-socket", "view", "unlink"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Mesh object call '${this.operation}' failed`;
  }
}

/** The worker's handle on each Connect user's MeshObject. */
export class MeshDirectory extends Context.Service<
  MeshDirectory,
  {
    /** Hands an authenticated upgrade to the user's object, which accepts the socket. */
    readonly openSocket: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly request: HttpServerRequest.HttpServerRequest;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse, MeshDirectoryError>;
    /** Accepts the upgrade and closes it at once, so the member sees a close code, not a 4xx. */
    readonly refuseSocket: (
      code: MeshCloseCode,
      reason: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse>;
    readonly view: (userId: string) => Effect.Effect<MeshView, MeshDirectoryError>;
    /** The environment's link to this user was revoked; it leaves the user's mesh. */
    readonly unlink: (input: {
      readonly userId: string;
      readonly environmentId: string;
    }) => Effect.Effect<void, MeshDirectoryError>;
  }
>()("t3code-relay/mesh/MeshDirectory") {}

export const isMeshAllowlisted = (
  config: RelayConfiguration.RelayConfiguration["Service"],
  userId: string,
): boolean => config.meshAllowedUserIds?.includes(userId) ?? false;

export type MeshAdmission =
  | { readonly _tag: "Admitted"; readonly userId: string }
  | { readonly _tag: "Refused"; readonly code: MeshCloseCode; readonly reason: string }
  | { readonly _tag: "Unlinked" };

/**
 * Whose mesh an environment joins, given the users whose active links match its credential's
 * key. Matching the key, not just the id, matters: another account can link the same id.
 */
export const meshAdmission = (
  userIds: ReadonlyArray<string>,
  config: RelayConfiguration.RelayConfiguration["Service"],
): MeshAdmission => {
  const [userId, ...others] = userIds;
  if (userId === undefined) return { _tag: "Unlinked" };
  if (others.length > 0) {
    return { _tag: "Refused", code: MeshCloseCode.sharedKey, reason: "shared-key" };
  }
  if (!isMeshAllowlisted(config, userId)) {
    return { _tag: "Refused", code: MeshCloseCode.notAllowlisted, reason: "not-allowlisted" };
  }
  return { _tag: "Admitted", userId };
};
