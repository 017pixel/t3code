import type { Discovery } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { planRelayAutoSelection, resolveSelectedComputers } from "./relayDiscoveryStore";

const relayTarget = { _tag: "RelayConnectionTarget" } as const;
const directTarget = { _tag: "DirectConnectionTarget" } as const;

function discovered(
  id: string,
  availability: Discovery.RelayEnvironmentAvailability = "online",
): Discovery.RelayDiscoveredEnvironment {
  return {
    environment: {
      environmentId: EnvironmentId.make(id),
      label: id,
    } as RelayClientEnvironmentRecord,
    availability,
    status: Option.none(),
    error: Option.none(),
  };
}

function discovery(
  ...environments: Discovery.RelayDiscoveredEnvironment[]
): Discovery.RelayEnvironmentDiscoveryState {
  return {
    environments: new Map(environments.map((entry) => [entry.environment.environmentId, entry])),
    refreshing: false,
    offline: false,
    error: Option.none(),
  };
}

function saved(
  entries: Array<[string, { relay: boolean; phase?: string }]>,
): Parameters<typeof planRelayAutoSelection>[1] {
  return new Map(
    entries.map(([id, { relay, phase = "connected" }]) => [
      EnvironmentId.make(id),
      {
        entry: { target: relay ? relayTarget : directTarget, alternateRoutes: [] } as never,
        connection: { phase },
      },
    ]),
  );
}

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const options = { waitForHealthChecks: false };

describe("planRelayAutoSelection", () => {
  it("selects and connects each checked relay computer once", () => {
    const first = planRelayAutoSelection(
      discovery(discovered("a"), discovered("b", "checking")),
      new Map(),
      new Map(),
      options,
    );
    expect([...first.choices]).toEqual([[a, true]]);
    expect(first.connect.map((environment) => environment.environmentId)).toEqual([a]);

    const unchecked = new Map(first.choices).set(a, false);
    const second = planRelayAutoSelection(
      discovery(discovered("a"), discovered("b")),
      new Map(),
      unchecked,
      options,
    );
    expect(second.choices.get(a)).toBe(false);
    expect(second.choices.get(b)).toBe(true);
    expect(second.connect.map((environment) => environment.environmentId)).toEqual([b]);
  });

  it("leaves saved computers to their defaults but deselects unsupported ones", () => {
    const plan = planRelayAutoSelection(
      discovery(discovered("a"), discovered("b")),
      saved([
        ["a", { relay: true }],
        ["b", { relay: true, phase: "unsupported" }],
      ]),
      new Map(),
      options,
    );
    expect([...plan.choices]).toEqual([[b, false]]);
    expect(plan.connect).toEqual([]);
  });

  it("skips computers saved without a relay route", () => {
    const plan = planRelayAutoSelection(
      discovery(discovered("a")),
      saved([["a", { relay: false }]]),
      new Map(),
      options,
    );
    expect(plan.choices.size).toBe(0);
    expect(plan.connect).toEqual([]);
  });

  it("waits for every health check when asked to", () => {
    const choices = new Map();
    const waiting = planRelayAutoSelection(
      discovery(discovered("a"), discovered("b", "checking")),
      new Map(),
      choices,
      { waitForHealthChecks: true },
    );
    expect(waiting.choices).toBe(choices);
    expect(waiting.connect).toEqual([]);
  });

  it("keeps the same choices when nothing changes", () => {
    const choices = new Map([[a, true]]);
    expect(
      planRelayAutoSelection(discovery(discovered("a")), new Map(), choices, options).choices,
    ).toBe(choices);
  });
});

describe("resolveSelectedComputers", () => {
  it("defaults saved computers to enabled and keeps explicit picks", () => {
    const selected = resolveSelectedComputers(
      [
        { environmentId: a, entry: { enabled: true } },
        { environmentId: b, entry: { enabled: false } },
      ],
      new Map([[EnvironmentId.make("relay"), true]]),
    );
    expect([...selected]).toEqual([a, EnvironmentId.make("relay")]);
    expect([
      ...resolveSelectedComputers(
        [{ environmentId: a, entry: { enabled: true } }],
        new Map([[a, false]]),
      ),
    ]).toEqual([]);
  });
});
