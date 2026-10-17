import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  type AuthSessionState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);
const sessionStateAtom = createEnvironmentSessionAtoms(runtime).sessionStateAtom(
  EnvironmentId.make("environment"),
);
const session = (scopes: NonNullable<AuthSessionState["scopes"]>): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes,
});

describe("environment session state", () => {
  it("treats a refetch of the same session as unchanged, so readers do not re-render", () => {
    const fetched = AsyncResult.success(session([AuthOrchestrationOperateScope]), {
      timestamp: 1,
    });
    const refetched = AsyncResult.success(session([AuthOrchestrationOperateScope]), {
      timestamp: 2,
    });
    expect(sessionStateAtom.equals(fetched, refetched)).toBe(true);
    expect(sessionStateAtom.equals(fetched, AsyncResult.success(session([])))).toBe(false);
    expect(sessionStateAtom.equals(fetched, AsyncResult.waiting(fetched))).toBe(false);
  });
});
