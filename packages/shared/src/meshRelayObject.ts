// Handlers for the relay's per-user MeshObject Durable Object. Storage (SqlClient), clock and
// sockets are injected, so the relay runs them in the object and the server's test relay runs the
// same code over Node sockets. Nothing lives in memory: every handler rebuilds what it needs from
// storage and the open sockets, so hibernation is free.
import {
  type EnvironmentId,
  isUnknownUnionMember,
  MESH_GRANT_JWT_TYPE,
  MESH_GRANT_SCOPE,
  MESH_GRANT_TTL_SECONDS,
  MESH_IDLE_TIMEOUT_MS,
  MESH_OFFLINE_GRACE_MS,
  MeshCloseCode,
  type MeshCredentialErrorCode,
  type MeshGrantClaims,
  type MeshMemberCredentialRequest,
  type MeshMemberView,
  MeshRelayMessage,
  ReceivedMeshMemberMessage,
} from "@t3tools/contracts";
import {
  chooseCaptain,
  isMeshCaptainEligible,
  type MeshCaptainCandidate,
  meshCaptainIneligibleReason,
} from "@t3tools/shared/meshCaptain";
import { normalizeRelayIssuer, signRelayJwt } from "@t3tools/shared/relayJwt";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as MeshStore from "./meshRelayStore.ts";

export interface MeshSockets<Socket> {
  /** Open sockets only. */
  readonly list: Effect.Effect<ReadonlyArray<Socket>>;
  /** The member a socket was opened for; null once it was replaced or its member left. */
  readonly environmentOf: (socket: Socket) => EnvironmentId | null;
  /** Last ping the runtime auto-answered on this socket, epoch ms. Pings never wake the object. */
  readonly lastPingAt: (socket: Socket) => Effect.Effect<number | null>;
  readonly send: (socket: Socket, text: string) => Effect.Effect<void>;
  /** Detaches the socket from its member, then closes it, so its close event is ignored. */
  readonly retire: (socket: Socket, code: number, reason: string) => Effect.Effect<void>;
}

export interface MeshObjectContext<Socket> {
  /** Whether the mesh rollout includes this Connect user. */
  readonly isAllowlisted: (userId: string) => boolean;
  readonly issuer: string;
  readonly mintPrivateKey: Redacted.Redacted<string>;
  readonly sockets: MeshSockets<Socket>;
  /** Null clears the alarm. */
  readonly setAlarm: (at: number | null) => Effect.Effect<void>;
}

export interface MeshView {
  readonly members: ReadonlyArray<MeshMemberView>;
  readonly captain: EnvironmentId | null;
  readonly pin: EnvironmentId | null;
}

const decodeMemberMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReceivedMeshMemberMessage),
);
const encodeRelayMessage = Schema.encodeEffect(Schema.fromJsonString(MeshRelayMessage));

type ProfiledMember = MeshStore.MeshMemberRecord & {
  readonly profile: MeshStore.MeshMemberProfile;
};

const hasProfile = (member: MeshStore.MeshMemberRecord): member is ProfiledMember =>
  member.profile !== null;

const candidateOf = (member: ProfiledMember): MeshCaptainCandidate => ({
  environmentId: member.environmentId,
  online: member.online,
  capabilities: member.profile.capabilities,
  score: member.profile.score,
});

const memberView = (member: ProfiledMember): MeshMemberView => {
  const candidate = candidateOf(member);
  const ineligibleReason = member.online ? meshCaptainIneligibleReason(candidate) : undefined;
  return {
    environmentId: member.environmentId,
    label: member.profile.label,
    machineKind: member.profile.score.machineKind,
    serverVersion: member.profile.serverVersion,
    online: member.online,
    capabilities: member.profile.capabilities,
    connectHostname: member.profile.connectHostname,
    directEndpoints: member.profile.directEndpoints,
    captainEligible: isMeshCaptainEligible(candidate),
    ...(ineligibleReason === undefined ? {} : { ineligibleReason }),
  };
};

const send = <Socket>(ctx: MeshObjectContext<Socket>, socket: Socket, message: MeshRelayMessage) =>
  encodeRelayMessage(message).pipe(
    Effect.orDie,
    Effect.flatMap((text) => ctx.sockets.send(socket, text)),
  );

/** Picks the captain again and sends every member that said hello a fresh snapshot. */
const publish = Effect.fn("MeshObject.publish")(function* <Socket>(ctx: MeshObjectContext<Socket>) {
  const members = (yield* MeshStore.listMembers).filter(hasProfile);
  const state = yield* MeshStore.getState;
  const captain = chooseCaptain(members.map(candidateOf), state.pin, state.captain);
  if (captain !== state.captain) yield* MeshStore.setCaptain(captain);
  const views = members.map(memberView);
  const greeted = new Set(members.map((member) => member.environmentId));
  for (const socket of yield* ctx.sockets.list) {
    const selfEnvironmentId = ctx.sockets.environmentOf(socket);
    if (selfEnvironmentId === null || !greeted.has(selfEnvironmentId)) continue;
    yield* send(ctx, socket, {
      type: "snapshot",
      members: views,
      captain,
      pin: state.pin,
      selfEnvironmentId,
    });
  }
});

/**
 * Applies due presence changes and returns when the next one is due. A member is idle after
 * {@link MESH_IDLE_TIMEOUT_MS} without a ping or message, and offline
 * {@link MESH_OFFLINE_GRACE_MS} after its last socket went away.
 */
const sweep = Effect.fn("MeshObject.sweep")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  now: number,
) {
  const openByMember = new Map<EnvironmentId, Array<Socket>>();
  for (const socket of yield* ctx.sockets.list) {
    const environmentId = ctx.sockets.environmentOf(socket);
    if (environmentId === null) continue;
    openByMember.set(environmentId, [...(openByMember.get(environmentId) ?? []), socket]);
  }
  let changed = false;
  let next: number | null = null;
  const dueAt = (at: number) => {
    next = next === null ? at : Math.min(next, at);
  };
  for (const member of yield* MeshStore.listMembers) {
    const open = openByMember.get(member.environmentId) ?? [];
    let disconnectedAt = member.disconnectedAt;
    if (open.length > 0) {
      const pings = yield* Effect.forEach(open, ctx.sockets.lastPingAt);
      const lastSeen = Math.max(
        member.seenAt,
        ...pings.filter((ping): ping is number => ping !== null),
      );
      if (now - lastSeen < MESH_IDLE_TIMEOUT_MS) {
        dueAt(lastSeen + MESH_IDLE_TIMEOUT_MS);
        continue;
      }
      for (const socket of open) yield* ctx.sockets.retire(socket, MeshCloseCode.idle, "idle");
      yield* MeshStore.markDisconnected(member.environmentId, now);
      disconnectedAt ??= now;
    } else if (disconnectedAt === null) {
      // The runtime dropped the socket without a close event, as on a deploy.
      yield* MeshStore.markDisconnected(member.environmentId, now);
      disconnectedAt = now;
    }
    const offlineAt = disconnectedAt + MESH_OFFLINE_GRACE_MS;
    if (now < offlineAt) {
      dueAt(offlineAt);
    } else if (member.profile === null) {
      yield* MeshStore.removeMember(member.environmentId);
    } else if (member.online) {
      yield* MeshStore.markOffline(member.environmentId);
      changed = true;
    }
  }
  return { changed, next };
});

/** Ends every handler: applies due presence changes, publishes, and arms the next alarm. */
const settle = Effect.fn("MeshObject.settle")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  changed: boolean,
) {
  const swept = yield* sweep(ctx, yield* Clock.currentTimeMillis);
  if (changed || swept.changed) yield* publish(ctx);
  yield* ctx.setAlarm(swept.next);
});

const removeMember = Effect.fn("MeshObject.removeMember")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  environmentId: EnvironmentId,
) {
  for (const socket of yield* ctx.sockets.list) {
    if (ctx.sockets.environmentOf(socket) === environmentId) {
      yield* ctx.sockets.retire(socket, MeshCloseCode.left, "left");
    }
  }
  yield* MeshStore.removeMember(environmentId);
});

const answerCredentialRequest = Effect.fn("MeshObject.answerCredentialRequest")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  socket: Socket,
  callerId: EnvironmentId,
  request: MeshMemberCredentialRequest,
) {
  const refuse = (code: MeshCredentialErrorCode, message: string) =>
    send(ctx, socket, { type: "credentialError", requestId: request.requestId, code, message });
  const userId = yield* MeshStore.getOwner;
  if (userId === null || !ctx.isAllowlisted(userId)) {
    return yield* refuse("not-allowlisted", "This account is not in the mesh rollout.");
  }
  const caller = yield* MeshStore.getMember(callerId);
  if (caller?.profile == null || !caller.online) {
    return yield* refuse("not-member", "Say hello before asking for a credential.");
  }
  const target = yield* MeshStore.getMember(request.targetEnvironmentId);
  if (target?.profile == null) {
    return yield* refuse("not-member", "The target is not a member of this mesh.");
  }
  if (!target.online) return yield* refuse("target-offline", "The target is offline.");

  const crypto = yield* Crypto.Crypto;
  const issuedAt = Math.floor((yield* Clock.currentTimeMillis) / 1_000);
  const claims: MeshGrantClaims = {
    iss: normalizeRelayIssuer(ctx.issuer),
    sub: userId,
    aud: target.environmentId,
    meshCaller: callerId,
    scope: MESH_GRANT_SCOPE,
    cnf: { jkt: request.jkt },
    jti: yield* crypto.randomUUIDv4().pipe(Effect.orDie),
    iat: issuedAt,
    exp: issuedAt + MESH_GRANT_TTL_SECONDS,
  };
  const grant = yield* signRelayJwt({
    privateKey: Redacted.value(ctx.mintPrivateKey),
    typ: MESH_GRANT_JWT_TYPE,
    payload: claims,
  }).pipe(
    Effect.tapError((error) => Effect.logError("Could not sign a mesh grant", { error })),
    Effect.option,
  );
  if (Option.isNone(grant)) {
    return yield* refuse("internal", "The relay could not sign the grant.");
  }
  yield* send(ctx, socket, {
    type: "credentialGrant",
    requestId: request.requestId,
    grant: grant.value,
  });
});

export class MeshOwnerMismatchError extends Schema.TaggedError<MeshOwnerMismatchError>()(
  "MeshOwnerMismatchError",
  {},
) {
  override get message(): string {
    return "This mesh object belongs to another Connect user.";
  }
}

/**
 * Records the authenticated Connect user the worker named on the object's first call, and is
 * false for any other user after that. Run it before accepting a socket.
 */
export const claimOwner = MeshStore.claimOwner;

const requireOwner = (userId: string) =>
  MeshStore.claimOwner(userId).pipe(
    Effect.flatMap((owned) => (owned ? Effect.void : Effect.fail(new MeshOwnerMismatchError()))),
  );

/** The worker authenticated `environmentId` and upgraded a socket for it. */
export const connect = Effect.fn("MeshObject.connect")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  environmentId: EnvironmentId,
) {
  yield* MeshStore.markConnected(environmentId, yield* Clock.currentTimeMillis);
  yield* settle(ctx, false);
});

export const message = Effect.fn("MeshObject.message")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  socket: Socket,
  data: string | ArrayBuffer,
) {
  const environmentId = ctx.sockets.environmentOf(socket);
  if (environmentId === null) return;
  const decoded = decodeMemberMessage(
    typeof data === "string" ? data : new TextDecoder().decode(data),
  );
  if (Option.isNone(decoded)) {
    return yield* Effect.logWarning("Ignored a malformed mesh message", { environmentId });
  }
  const now = yield* Clock.currentTimeMillis;
  yield* MeshStore.markSeen(environmentId, now);
  const received = decoded.value;
  if (isUnknownUnionMember(received)) return yield* settle(ctx, false);

  switch (received.type) {
    case "hello": {
      for (const other of yield* ctx.sockets.list) {
        if (other !== socket && ctx.sockets.environmentOf(other) === environmentId) {
          yield* ctx.sockets.retire(other, MeshCloseCode.replaced, "replaced");
        }
      }
      const { type: _type, ...profile } = received;
      yield* MeshStore.writeProfile(environmentId, profile, now);
      return yield* settle(ctx, true);
    }
    case "update": {
      const member = yield* MeshStore.getMember(environmentId);
      if (member?.profile == null) return yield* settle(ctx, false);
      const { type: _type, ...changes } = received;
      yield* MeshStore.writeProfile(environmentId, { ...member.profile, ...changes }, now);
      return yield* settle(ctx, true);
    }
    case "setPin": {
      const sender = yield* MeshStore.getMember(environmentId);
      const pinned =
        received.environmentId === null ? null : yield* MeshStore.getMember(received.environmentId);
      if (sender?.profile == null || (received.environmentId !== null && pinned?.profile == null)) {
        return yield* settle(ctx, false);
      }
      yield* MeshStore.setPin(received.environmentId);
      return yield* settle(ctx, true);
    }
    case "credentialRequest": {
      yield* answerCredentialRequest(ctx, socket, environmentId, received);
      return yield* settle(ctx, false);
    }
    case "ping": {
      // A ping whose bytes differ from the auto-response request reaches the object.
      yield* send(ctx, socket, { type: "pong" });
      return yield* settle(ctx, false);
    }
  }
});

/** A socket closed with `code`, as the member sent it. A member leaves by closing with `left`. */
export const close = Effect.fn("MeshObject.close")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  socket: Socket,
  code: number,
) {
  const environmentId = ctx.sockets.environmentOf(socket);
  if (environmentId === null) return;
  if (code === MeshCloseCode.left) {
    yield* removeMember(ctx, environmentId);
    return yield* settle(ctx, true);
  }
  const others = (yield* ctx.sockets.list).filter(
    (other) => other !== socket && ctx.sockets.environmentOf(other) === environmentId,
  );
  if (others.length === 0) {
    yield* MeshStore.markDisconnected(environmentId, yield* Clock.currentTimeMillis);
  }
  yield* settle(ctx, false);
});

export const alarm = <Socket>(ctx: MeshObjectContext<Socket>) => settle(ctx, false);

/** The member's Connect link was revoked: it leaves the mesh at once. */
export const unlink = Effect.fn("MeshObject.unlink")(function* <Socket>(
  ctx: MeshObjectContext<Socket>,
  userId: string,
  environmentId: EnvironmentId,
) {
  yield* requireOwner(userId);
  yield* removeMember(ctx, environmentId);
  yield* settle(ctx, true);
});

export const view = Effect.fn("MeshObject.view")(function* (userId: string) {
  yield* requireOwner(userId);
  const members = (yield* MeshStore.listMembers).filter(hasProfile);
  const state = yield* MeshStore.getState;
  return {
    members: members.map(memberView),
    captain: state.captain,
    pin: state.pin,
  } satisfies MeshView;
});
