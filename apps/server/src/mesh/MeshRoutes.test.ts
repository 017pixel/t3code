import { EnvironmentId, type MeshMemberView, type MeshRoute } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { meshRouteCandidates, ROUTE_CHECK_HEAD_START, walkMeshRoutes } from "./MeshRoutes.ts";

const lan: MeshRoute = { kind: "lan", httpBaseUrl: "http://192.168.1.20:3773/" };
const tailnet: MeshRoute = { kind: "tailnet", httpBaseUrl: "http://100.64.0.20:3773/" };
const tunnel: MeshRoute = { kind: "tunnel", httpBaseUrl: "https://box.t3.example/" };

const member = (overrides: Partial<MeshMemberView> = {}): MeshMemberView => ({
  environmentId: EnvironmentId.make("env-box"),
  label: "box",
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true },
  connectHostname: "box.t3.example",
  directEndpoints: [
    { kind: "tailnet", httpBaseUrl: tailnet.httpBaseUrl },
    { kind: "lan", httpBaseUrl: lan.httpBaseUrl },
  ],
  captainEligible: true,
  ...overrides,
});

it("orders a member's routes LAN, then tailnet, then its Connect tunnel", () => {
  assert.deepStrictEqual(meshRouteCandidates(member()), [lan, tailnet, tunnel]);
  assert.deepStrictEqual(meshRouteCandidates(member({ connectHostname: null })), [lan, tailnet]);
});

it.effect("takes LAN over tailnet and tunnel when every route answers", () =>
  Effect.gen(function* () {
    const chosen = yield* walkMeshRoutes([lan, tailnet, tunnel], () => Effect.succeed(true));
    assert.deepStrictEqual(chosen, Option.some(lan));
  }),
);

it.effect("falls through a dead LAN after the shared head start", () =>
  Effect.gen(function* () {
    const lanAnswer = yield* Deferred.make<boolean>();
    const walk = yield* walkMeshRoutes([lan, tailnet, tunnel], (route) =>
      route === lan ? Deferred.await(lanAnswer) : Effect.succeed(true),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(ROUTE_CHECK_HEAD_START);
    assert.deepStrictEqual(yield* Fiber.join(walk), Option.some(tailnet));
  }),
);

it.effect("never takes a route that answered as another environment", () =>
  Effect.gen(function* () {
    const tunnelAnswer = yield* Deferred.make<boolean>();
    const walk = yield* walkMeshRoutes([lan, tailnet, tunnel], (route) =>
      route === tunnel ? Deferred.await(tunnelAnswer) : Effect.succeed(false),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(ROUTE_CHECK_HEAD_START);
    // The tunnel answers late; it still wins because the others never answered as the member.
    yield* Deferred.succeed(tunnelAnswer, true);
    assert.deepStrictEqual(yield* Fiber.join(walk), Option.some(tunnel));

    const none = yield* walkMeshRoutes([lan, tailnet], () => Effect.succeed(false));
    assert.isTrue(Option.isNone(none));
  }),
);
