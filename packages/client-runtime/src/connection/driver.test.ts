import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as RpcHttp from "../rpc/http.ts";
import * as RpcSession from "../rpc/session.ts";
import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import * as MeshCaptain from "./meshCaptain.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import * as ConnectionResolver from "./resolver.ts";
import { captainRoute, type CaptainPath } from "./routes.ts";

const ENVIRONMENT_ID = EnvironmentId.make("member-1");
const ENTRY: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: ENVIRONMENT_ID, label: "Member" }),
  profile: Option.none(),
  enabled: true,
};
const PATH: CaptainPath = {
  captain: EnvironmentId.make("captain-1"),
  httpBaseUrl: `http://192.168.1.5:3773/api/mesh/via/handle/${ENVIRONMENT_ID}`,
};
const LAN = {
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Member",
    connectionId: "lan",
  }),
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: "lan",
      environmentId: ENVIRONMENT_ID,
      label: "Member",
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};

const makeDriver = Effect.fn("DriverTest.makeDriver")(function* (reply: () => Response) {
  const failures: Array<readonly [CaptainPath, MeshCaptain.CaptainRouteFailure]> = [];
  const unused = () => Effect.die("unused");
  const mesh = MeshCaptain.MeshCaptain.of({
    state: yield* SubscriptionRef.make<MeshCaptain.MeshCaptainState>({ mesh: null, saved: null }),
    paths: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, CaptainPath>>(new Map()),
    observeConnection: () => Effect.void,
    reportRouteFailure: (path, reason) => Effect.sync(() => failures.push([path, reason])),
    betterRouteTick: () => Effect.void,
    refresh: Effect.void,
  });
  const driver = yield* ConnectionDriver.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(
          ConnectionResolver.ConnectionResolver,
          ConnectionResolver.ConnectionResolver.of({ prepare: unused, prepareForUpdate: unused }),
        ),
        Layer.succeed(
          RpcSession.RpcSessionFactory,
          RpcSession.RpcSessionFactory.of({ connect: unused }),
        ),
        Layer.succeed(MeshCaptain.MeshCaptain, mesh),
        RpcHttp.layerRemoteHttpClient(async () => reply()),
      ),
    ),
  );
  return { driver, failures };
});

describe("ConnectionDriver captain route checks", () => {
  it.effect("refuses a route the captain answers with 421 and has the handle minted again", () =>
    Effect.gen(function* () {
      const { driver, failures } = yield* makeDriver(() => new Response(null, { status: 421 }));
      expect(yield* driver.checkRoute(ENTRY, captainRoute(ENTRY.target, PATH))).toBe("refused");
      expect(yield* driver.preflight(ENTRY, captainRoute(ENTRY.target, PATH))).toBe(false);
      expect(failures[0]).toEqual([PATH, "refused"]);
    }),
  );

  it.effect("refuses a route through a demoted captain and reads the mesh again", () =>
    Effect.gen(function* () {
      const { driver, failures } = yield* makeDriver(() => new Response(null, { status: 410 }));
      expect(yield* driver.checkRoute(ENTRY, captainRoute(ENTRY.target, PATH))).toBe("refused");
      expect(failures).toEqual([[PATH, "not-captain"]]);
    }),
  );

  it.effect("keeps a silent captain route in the walk without a mesh read", () =>
    Effect.gen(function* () {
      const { driver, failures } = yield* makeDriver(() => new Response(null, { status: 502 }));
      expect(yield* driver.checkRoute(ENTRY, captainRoute(ENTRY.target, PATH))).toBe("silent");
      // A dead captain the relay still lists is found by the better-route tick instead.
      expect(failures).toEqual([]);
    }),
  );

  it.effect("treats a 421 from any other address as silent", () =>
    Effect.gen(function* () {
      const { driver, failures } = yield* makeDriver(() => new Response(null, { status: 421 }));
      expect(yield* driver.checkRoute(ENTRY, LAN)).toBe("silent");
      expect(failures).toEqual([]);
    }),
  );
});
