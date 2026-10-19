import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentAuthPolicy from "./EnvironmentAuthPolicy.ts";

const layerEnvironmentAuthPolicy = (overrides?: Partial<ServerConfig.ServerConfig["Service"]>) =>
  EnvironmentAuthPolicy.layer.pipe(
    Layer.provide(ServerEnvironment.layerIdentity),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return {
            ...config,
            ...overrides,
          } satisfies ServerConfig.ServerConfig["Service"];
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-policy-test-" })),
      ),
    ),
  );

it.layer(NodeServices.layer)("EnvironmentAuthPolicy.layer", (it) => {
  it.effect.each([
    {
      mode: "web",
      localPolicy: "loopback-browser",
      localBootstrapMethods: ["one-time-token"],
      remoteBootstrapMethods: ["one-time-token"],
    },
    {
      mode: "desktop",
      localPolicy: "desktop-managed-local",
      localBootstrapMethods: ["desktop-bootstrap"],
      remoteBootstrapMethods: ["desktop-bootstrap", "one-time-token"],
    },
  ] as const)(
    "advertises remote access only while Serve is configured for loopback $mode",
    ({ mode, localPolicy, localBootstrapMethods, remoteBootstrapMethods }) =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const descriptorForServe = (tailscaleServeEnabled: boolean) =>
          EnvironmentAuthPolicy.make.pipe(
            Effect.provideService(ServerConfig.ServerConfig, {
              ...config,
              mode,
              host: "127.0.0.1",
              port: 3773,
              tailscaleServeEnabled,
            }),
            Effect.flatMap((policy) => policy.getDescriptor()),
          );

        const local = yield* descriptorForServe(false);
        const remote = yield* descriptorForServe(true);
        const restored = yield* descriptorForServe(false);

        expect(local).toEqual({
          policy: localPolicy,
          bootstrapMethods: localBootstrapMethods,
          sessionMethods: ["browser-session-cookie", "bearer-access-token", "dpop-access-token"],
          sessionCookieName:
            mode === "web"
              ? expect.stringMatching(/^t3_session_3773_[a-f0-9]{12}$/)
              : "t3_session_3773",
          serverUpdateScope: "environment:maintain",
        });
        expect([remote, restored]).toEqual([
          { ...local, policy: "remote-reachable", bootstrapMethods: remoteBootstrapMethods },
          local,
        ]);
      }).pipe(
        Effect.provide(
          ServerEnvironment.layerIdentity.pipe(
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-serve-policy-test-" }),
            ),
          ),
        ),
      ),
  );

  it.effect("uses desktop-managed-local policy for desktop mode", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("desktop-managed-local");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap"]);
      expect(descriptor.serverUpdateScope).toBe("environment:maintain");
      expect(descriptor.sessionCookieName).toBe("t3_session_3773");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("keeps desktop cookies port-scoped on the port a second instance lands on", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.sessionCookieName).toBe("t3_session_3774");
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          port: 3774,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for desktop mode when bound beyond loopback", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["desktop-bootstrap", "one-time-token"]);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "desktop",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("uses loopback-browser policy for loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("loopback-browser");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.serverUpdateScope).toBe("environment:maintain");
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_3773_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for wildcard web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.bootstrapMethods).toEqual(["one-time-token"]);
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "0.0.0.0",
        }),
      ),
    ),
  );

  it.effect("isolates wildcard-bound web development sessions", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_5775_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "0.0.0.0",
          port: 5775,
          devUrl: new URL("http://127.0.0.1:5736"),
        }),
      ),
    ),
  );

  it.effect("uses remote-reachable policy for non-loopback web hosts", () =>
    Effect.gen(function* () {
      const policy = yield* EnvironmentAuthPolicy.EnvironmentAuthPolicy;
      const descriptor = yield* policy.getDescriptor();

      expect(descriptor.policy).toBe("remote-reachable");
      expect(descriptor.sessionCookieName).toMatch(/^t3_session_[a-f0-9]{12}$/);
    }).pipe(
      Effect.provide(
        layerEnvironmentAuthPolicy({
          mode: "web",
          host: "192.168.1.50",
        }),
      ),
    ),
  );
});
