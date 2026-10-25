// Storage for the relay's per-user mesh object. Runs on the Durable Object's SQLite in the relay
// and on Node SQLite in the server's test relay.
import { EnvironmentId, MeshMemberHello } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Struct from "effect/Struct";

/** What a member last told the relay about itself: its hello with later updates applied. */
export const MeshMemberProfile = MeshMemberHello.mapFields(Struct.omit(["type"]));
export type MeshMemberProfile = typeof MeshMemberProfile.Type;

const ProfileJson = Schema.fromJsonString(MeshMemberProfile);
const encodeProfile = Schema.encodeEffect(ProfileJson);
const decodeProfile = Schema.decodeUnknownOption(ProfileJson);

export interface MeshMemberRecord {
  readonly environmentId: EnvironmentId;
  /** Null until the member's first hello; such rows stay out of every view. */
  readonly profile: MeshMemberProfile | null;
  readonly online: boolean;
  /** Last connect or message, epoch ms. Pings are auto-answered and tracked by the runtime. */
  readonly seenAt: number;
  /** When its last socket went away, epoch ms; null while a socket is open. */
  readonly disconnectedAt: number | null;
}

export interface MeshStateRecord {
  readonly pin: EnvironmentId | null;
  readonly captain: EnvironmentId | null;
}

interface MemberRow {
  readonly environment_id: string;
  readonly profile: string | null;
  readonly online: number;
  readonly seen_at: number;
  readonly disconnected_at: number | null;
}

interface StateRow {
  readonly pin: string | null;
  readonly captain: string | null;
}

export const migrate = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_members (
      environment_id TEXT PRIMARY KEY,
      profile TEXT,
      online INTEGER NOT NULL DEFAULT 0,
      seen_at INTEGER NOT NULL,
      disconnected_at INTEGER
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      pin TEXT,
      captain TEXT
    )
  `;
  yield* sql`INSERT OR IGNORE INTO mesh_state (id, pin, captain) VALUES (1, NULL, NULL)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mesh_owner (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      user_id TEXT NOT NULL
    )
  `;
});

/** The Connect user this object belongs to, or null before its first call. */
export const getOwner = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly user_id: string;
  }>`SELECT user_id FROM mesh_owner WHERE id = 1`;
  return rows[0]?.user_id ?? null;
});

/** Records `userId` as the owner on first use. False when another user already owns it. */
export const claimOwner = Effect.fn("MeshStore.claimOwner")(function* (userId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT OR IGNORE INTO mesh_owner (id, user_id) VALUES (1, ${userId})`;
  return (yield* getOwner) === userId;
});

// A profile written by an older relay that no longer decodes hides the member until its next hello.
const toRecord = (row: MemberRow): MeshMemberRecord => ({
  environmentId: EnvironmentId.make(row.environment_id),
  profile: row.profile === null ? null : Option.getOrNull(decodeProfile(row.profile)),
  online: row.online === 1,
  seenAt: row.seen_at,
  disconnectedAt: row.disconnected_at,
});

export const listMembers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<MemberRow>`
    SELECT environment_id, profile, online, seen_at, disconnected_at
    FROM mesh_members ORDER BY environment_id
  `;
  return rows.map(toRecord);
});

export const getMember = Effect.fn("MeshStore.getMember")(function* (environmentId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<MemberRow>`
    SELECT environment_id, profile, online, seen_at, disconnected_at
    FROM mesh_members WHERE environment_id = ${environmentId}
  `;
  const row = rows[0];
  return row === undefined ? null : toRecord(row);
});

/** A socket opened for the member: it is connected again, whatever its presence was. */
export const markConnected = Effect.fn("MeshStore.markConnected")(function* (
  environmentId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO mesh_members (environment_id, profile, online, seen_at, disconnected_at)
    VALUES (${environmentId}, NULL, 0, ${now}, NULL)
    ON CONFLICT (environment_id) DO UPDATE SET seen_at = ${now}, disconnected_at = NULL
  `;
});

export const markSeen = Effect.fn("MeshStore.markSeen")(function* (
  environmentId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE mesh_members SET seen_at = ${now} WHERE environment_id = ${environmentId}`;
});

/** The member said hello or sent an update over an open socket, so it is online. */
export const writeProfile = Effect.fn("MeshStore.writeProfile")(function* (
  environmentId: string,
  profile: MeshMemberProfile,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* encodeProfile(profile).pipe(Effect.orDie);
  yield* sql`
    INSERT INTO mesh_members (environment_id, profile, online, seen_at, disconnected_at)
    VALUES (${environmentId}, ${encoded}, 1, ${now}, NULL)
    ON CONFLICT (environment_id) DO UPDATE
    SET profile = ${encoded}, online = 1, seen_at = ${now}, disconnected_at = NULL
  `;
});

export const markDisconnected = Effect.fn("MeshStore.markDisconnected")(function* (
  environmentId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE mesh_members SET disconnected_at = ${now}
    WHERE environment_id = ${environmentId} AND disconnected_at IS NULL
  `;
});

export const markOffline = Effect.fn("MeshStore.markOffline")(function* (environmentId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE mesh_members SET online = 0 WHERE environment_id = ${environmentId}`;
});

/** Drops the member, and the pin when it pointed at it. */
export const removeMember = Effect.fn("MeshStore.removeMember")(function* (environmentId: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM mesh_members WHERE environment_id = ${environmentId}`;
  yield* sql`UPDATE mesh_state SET pin = NULL WHERE id = 1 AND pin = ${environmentId}`;
});

export const getState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<StateRow>`SELECT pin, captain FROM mesh_state WHERE id = 1`;
  const row = rows[0];
  return {
    pin: row?.pin == null ? null : EnvironmentId.make(row.pin),
    captain: row?.captain == null ? null : EnvironmentId.make(row.captain),
  } satisfies MeshStateRecord;
});

export const setPin = Effect.fn("MeshStore.setPin")(function* (pin: string | null) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE mesh_state SET pin = ${pin} WHERE id = 1`;
});

export const setCaptain = Effect.fn("MeshStore.setCaptain")(function* (captain: string | null) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE mesh_state SET captain = ${captain} WHERE id = 1`;
});
