import { EnvironmentId, type MeshMemberView, type MeshStatus } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { resolveMeshMember } from "./mesh.ts";

const member = (environmentId: string, label: string): MeshMemberView => ({
  environmentId: EnvironmentId.make(environmentId),
  label,
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true },
  connectHostname: null,
  directEndpoints: [],
  captainEligible: true,
});

const status: MeshStatus = {
  enabled: true,
  selfRole: "member",
  captain: null,
  pin: null,
  members: [member("env-box", "Box"), member("env-mac-1", "Mac"), member("env-mac-2", "mac")],
};

it.effect("pins by id, by label ignoring case, and refuses an ambiguous label", () =>
  Effect.gen(function* () {
    assert.strictEqual(yield* resolveMeshMember(status, "env-mac-2"), "env-mac-2");
    assert.strictEqual(yield* resolveMeshMember(status, "box"), "env-box");
    const ambiguous = yield* Effect.flip(resolveMeshMember(status, "MAC"));
    assert.include(ambiguous.message, "env-mac-1, env-mac-2");
    const missing = yield* Effect.flip(resolveMeshMember(status, "laptop"));
    assert.include(missing.message, "No mesh member is called 'laptop'");
  }),
);
