import { describe, expect, it } from "@effect/vitest";
import {
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

const REMOTE = EnvironmentId.make("remote");
const LOCAL = EnvironmentId.make("local");

describe("asset URL signing", () => {
  it.effect("signs once per Read key and never sends the key to either server", () =>
    Effect.gen(function* () {
      const sent: Array<readonly [EnvironmentId, AssetCreateUrlInput]> = [];
      const makeSupervisor = (environmentId: EnvironmentId) =>
        Effect.gen(function* () {
          const client = {
            [WS_METHODS.assetsCreateUrl]: (input: AssetCreateUrlInput) =>
              Effect.gen(function* () {
                sent.push([environmentId, input]);
                // The remote host cannot see a local screenshot, so every
                // request also exercises the local media fallback.
                if (environmentId === REMOTE)
                  return yield* new AssetWorkspaceAssetNotFoundError({ resource: input.resource });
                return { relativeUrl: `/api/assets/${sent.length}/square.png`, expiresAt: 1 };
              }),
          };
          return {
            target: { environmentId },
            session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
            state: yield* SubscriptionRef.make({
              ...AVAILABLE_CONNECTION_STATE,
              phase: "connected" as const,
            }),
          } as unknown as EnvironmentSupervisor.EnvironmentSupervisor["Service"];
        });
      const supervisors = {
        [REMOTE]: yield* makeSupervisor(REMOTE),
        [LOCAL]: yield* makeSupervisor(LOCAL),
      };
      const environmentRegistry = {
        run: (environmentId, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors[environmentId]!,
          ),
        followStream: (environmentId, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            supervisors[environmentId]!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"];
      const atoms = createAssetEnvironmentAtoms(
        Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
        Atom.make({ environmentId: LOCAL, httpBaseUrl: "http://local.test" }),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const resource = {
        _tag: "media-file",
        threadId: ThreadId.make("thread"),
        path: "/tmp/color-test/square.png",
      } as const;
      const read = (signingKey?: string) =>
        AtomRegistry.getResult(
          registry,
          atoms.createUrl({
            environmentId: REMOTE,
            input: signingKey === undefined ? { resource } : { resource, signingKey },
          }),
          { suspendOnWaiting: true },
        ).pipe(
          Effect.map((asset) => asset.relativeUrl),
          Effect.tap(() => Effect.yieldNow),
        );

      const blueRead = yield* read("read-blue");
      expect(yield* read("read-blue")).toBe(blueRead);
      const redRead = yield* read("read-red");
      const unkeyed = yield* read();

      expect(new Set([blueRead, redRead, unkeyed]).size).toBe(3);
      expect(redRead).toMatch(/^http:\/\/local\.test\/api\/assets\//);
      expect(sent).toEqual(
        [1, 2, 3].flatMap(() => [
          [REMOTE, { resource }],
          [LOCAL, { resource }],
        ]),
      );
    }).pipe(Effect.scoped),
  );
});

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
