import { EnvironmentId, type MeshCapabilities, type MeshScoreInputs } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  chooseCaptain,
  meshCaptainIneligibleReason,
  type MeshCaptainCandidate,
} from "./meshCaptain.ts";

const score: MeshScoreInputs = {
  backgroundService: false,
  onBattery: "false",
  lowPowerMode: "false",
  machineKind: "desktop",
  startedAt: "2026-10-01T00:00:00.000Z",
  tunnelReady: true,
};

const oldVersion: MeshCapabilities = { meshMember: true };
const notGateway: MeshCapabilities = { meshMember: true, meshGateway: false };

const member = (
  id: string,
  overrides: {
    readonly online?: boolean;
    readonly capabilities?: MeshCapabilities;
    readonly score?: Partial<MeshScoreInputs>;
  } = {},
): MeshCaptainCandidate => ({
  environmentId: EnvironmentId.make(id),
  online: overrides.online ?? true,
  capabilities: overrides.capabilities ?? { meshMember: true, meshGateway: true },
  score: { ...score, ...overrides.score },
});

const id = EnvironmentId.make;

describe("chooseCaptain", () => {
  it("only considers online members with meshGateway and a ready tunnel", () => {
    const members = [
      member("a", { online: false }),
      member("b", { capabilities: oldVersion }),
      member("c", { capabilities: notGateway }),
      member("d", { score: { tunnelReady: false } }),
    ];
    expect(chooseCaptain(members, null, null)).toBeNull();
    expect(chooseCaptain([...members, member("e")], null, null)).toBe(id("e"));
  });

  it("explains why an online member cannot be captain", () => {
    expect(meshCaptainIneligibleReason(member("a", { capabilities: oldVersion }))).toBe(
      "needs-update",
    );
    expect(meshCaptainIneligibleReason(member("a", { capabilities: notGateway }))).toBe(
      "not-gateway",
    );
    expect(meshCaptainIneligibleReason(member("a", { score: { tunnelReady: false } }))).toBe(
      "no-tunnel",
    );
    expect(meshCaptainIneligibleReason(member("a"))).toBeUndefined();
  });

  it("lets an eligible pin beat the current captain and a better member", () => {
    const members = [member("a", { score: { backgroundService: true } }), member("b")];
    expect(chooseCaptain(members, id("b"), id("a"))).toBe(id("b"));
  });

  it("ignores a pin on an ineligible member", () => {
    const members = [member("a"), member("b", { score: { tunnelReady: false } })];
    expect(chooseCaptain(members, id("b"), null)).toBe(id("a"));
    expect(chooseCaptain([member("a"), member("b", { online: false })], id("b"), null)).toBe(
      id("a"),
    );
  });

  it("keeps the current captain while it stays eligible", () => {
    const members = [member("a", { score: { backgroundService: true } }), member("b")];
    expect(chooseCaptain(members, null, id("b"))).toBe(id("b"));
    const currentGoesOffline = [members[0]!, member("b", { online: false })];
    expect(chooseCaptain(currentGoesOffline, null, id("b"))).toBe(id("a"));
  });

  it("prefers a background service", () => {
    const members = [member("a"), member("b", { score: { backgroundService: true } })];
    expect(chooseCaptain(members, null, null)).toBe(id("b"));
  });

  it("prefers a member on mains, counting unknown power as on mains", () => {
    expect(
      chooseCaptain([member("a", { score: { onBattery: "true" } }), member("b")], null, null),
    ).toBe(id("b"));
    expect(
      chooseCaptain([member("a", { score: { lowPowerMode: "true" } }), member("b")], null, null),
    ).toBe(id("b"));
    const unknownPower = member("b", {
      score: { onBattery: "unknown", lowPowerMode: "unknown", machineKind: "laptop" },
    });
    expect(
      chooseCaptain(
        [member("a", { score: { onBattery: "true", machineKind: "server" } }), unknownPower],
        null,
        null,
      ),
    ).toBe(id("b"));
  });

  it("ranks machine kinds with laptops last", () => {
    const ranked = (kinds: ReadonlyArray<MeshScoreInputs["machineKind"]>) =>
      chooseCaptain(
        kinds.map((machineKind, index) => member(`m${index}`, { score: { machineKind } })),
        null,
        null,
      );
    expect(ranked(["laptop", "desktop"])).toBe(id("m1"));
    expect(ranked(["mac-studio", "mac-mini"])).toBe(id("m1"));
    expect(ranked(["cloud", "server"])).toBe(id("m1"));
    expect(ranked(["laptop", null])).toBe(id("m1"));
    expect(ranked([null, "desktop"])).toBe(id("m1"));
  });

  it("prefers the longest uptime, then the lowest environment id", () => {
    const later = { startedAt: "2026-10-02T00:00:00.000Z" };
    expect(chooseCaptain([member("a", { score: later }), member("b")], null, null)).toBe(id("b"));
    expect(chooseCaptain([member("b"), member("a")], null, null)).toBe(id("a"));
  });
});
