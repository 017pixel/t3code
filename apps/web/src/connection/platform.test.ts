import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentBootstrap,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as PrimaryTarget from "../environments/primary/target.ts";
import { afterEach, vi } from "vite-plus/test";
import {
  ClientCapabilities,
  PlatformConnectionSource,
  Persistence,
} from "@t3tools/client-runtime/platform";
import {
  EnvironmentRegistry,
  Connectivity,
  ProfileStore,
  Wakeups,
  CredentialStore,
  type ConnectionCredential,
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  layer,
  layerPlatformConnectionSource,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  prepareDesktopSshEnvironment,
  provisionDesktopSshEnvironment,
  secondaryRegistrationsToRetainAfterTopologyRead,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const SSH_BOOTSTRAP = {
  target: TARGET,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  pairingToken: "abandoned-token",
};

function pendingSetup() {
  let resolve!: (bootstrap: DesktopSshEnvironmentBootstrap) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<DesktopSshEnvironmentBootstrap>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function pendingSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeBridge(
  calls: string[],
  options?: {
    readonly failDescriptor?: boolean;
    readonly savedTokenRejected?: boolean;
    readonly savedTokenPermissions?: ReadonlyArray<string>;
  },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (
      target: DesktopSshEnvironmentTarget,
      ensureOptions?: { issuePairingToken?: boolean },
    ) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: ensureOptions?.issuePairingToken === true ? "pairing-token" : null,
      };
    },
    disconnectSshEnvironment: async () => {
      calls.push("disconnect");
    },
    fetchSshSessionState: async () => {
      calls.push("session");
      return {
        authenticated: options?.savedTokenRejected !== true,
        permissions: options?.savedTokenPermissions ?? AuthStandardClientScopes,
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("exchanges one setup credential after repeated interrupted provisions", () =>
    Effect.gen(function* () {
      const bridge = makeBridge([]);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValue(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
      }

      const retry = yield* Effect.forkChild(provisionDesktopSshEnvironment(bridge, TARGET), {
        startImmediately: true,
      });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: true });
      expect(exchange).toHaveBeenCalledExactlyOnceWith(
        SSH_BOOTSTRAP.httpBaseUrl,
        "abandoned-token",
      );
    }),
  );

  it.effect("starts fresh after an abandoned setup settles in success or failure", () =>
    Effect.gen(function* () {
      for (const outcome of ["success", "failure"]) {
        const bridge = makeBridge([]);
        const setup = pendingSetup();
        const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
        const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
        const interrupted = yield* Effect.forkChild(
          provisionDesktopSshEnvironment(bridge, TARGET),
          { startImmediately: true },
        );
        yield* Fiber.interrupt(interrupted);
        if (outcome === "success") setup.resolve(SSH_BOOTSTRAP);
        else setup.reject(new Error("remote launch failed"));
        yield* Effect.promise(() =>
          setup.promise.then(
            () => undefined,
            () => undefined,
          ),
        );

        const provisioned = yield* provisionDesktopSshEnvironment(bridge, TARGET);

        expect(provisioned.bearerToken).toBe("bearer-token");
        expect(ensure).toHaveBeenCalledTimes(2);
        expect(exchange).toHaveBeenCalledExactlyOnceWith(
          SSH_BOOTSTRAP.httpBaseUrl,
          "pairing-token",
        );
      }
    }),
  );

  it.effect("disconnect invalidates unfinished setup even before provision is interrupted", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const bridge = makeBridge(calls);
      const setup = pendingSetup();
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment").mockReturnValueOnce(setup.promise);
      const exchange = vi.spyOn(bridge, "bootstrapSshBearerSession");
      vi.stubGlobal("window", { desktopBridge: bridge });
      const ssh = yield* ClientCapabilities.SshEnvironmentGateway.pipe(Effect.provide(layer));
      const interrupted = yield* Effect.forkChild(ssh.provision(TARGET), {
        startImmediately: true,
      });
      yield* ssh.disconnect(TARGET);
      yield* Fiber.interrupt(interrupted);

      const retry = yield* Effect.forkChild(ssh.provision(TARGET), { startImmediately: true });
      setup.resolve(SSH_BOOTSTRAP);
      const provisioned = yield* Fiber.join(retry);

      expect(provisioned.bearerToken).toBe("bearer-token");
      expect(ensure).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(["disconnect", "ensure", "descriptor", "token"]);
      expect(exchange).toHaveBeenCalledExactlyOnceWith(SSH_BOOTSTRAP.httpBaseUrl, "pairing-token");
    }),
  );

  it.effect("reconnects with the saved token while it holds every standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const bridge = makeBridge(calls);
      const ensure = vi.spyOn(bridge, "ensureSshEnvironment");
      const prepared = yield* prepareDesktopSshEnvironment(bridge, {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
        bearerToken: "saved-token",
      });

      expect(prepared.bearerToken).toBe("saved-token");
      expect(ensure).toHaveBeenCalledExactlyOnceWith(TARGET, { issuePairingToken: false });
      expect(calls).toEqual(["ensure", "descriptor", "session"]);
    }),
  );

  it.effect("pairs again when the host no longer accepts the saved token", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, { savedTokenRejected: true }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("pairs again when the saved token predates a standard scope", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const prepared = yield* prepareDesktopSshEnvironment(
        makeBridge(calls, {
          savedTokenPermissions: ["orchestration:read", "orchestration:operate"],
        }),
        {
          target: TARGET,
          expectedEnvironmentId: EnvironmentId.make("environment-ssh"),
          bearerToken: "saved-token",
        },
      );

      expect(prepared.bearerToken).toBe("bearer-token");
      expect(calls).toEqual(["ensure", "descriptor", "session", "ensure", "descriptor", "token"]);
    }),
  );

  it.effect("stops before sending the saved token or pairing on a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* prepareDesktopSshEnvironment(makeBridge(calls), {
        target: TARGET,
        expectedEnvironmentId: EnvironmentId.make("some-other-machine"),
        bearerToken: "saved-token",
      }).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  // regression: #16273 a rejected desktop-local credential was retried every poll
  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });
});

const layerTestCredentials = Layer.effect(
  CredentialStore.ConnectionCredentialStore,
  Effect.gen(function* () {
    const stored = yield* Ref.make(new Map<string, ConnectionCredential>());
    return CredentialStore.ConnectionCredentialStore.of({
      get: (id) =>
        Ref.get(stored).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(id)))),
      put: (id, credential) =>
        Ref.update(stored, (current) => new Map(current).set(id, credential)),
      remove: (id) =>
        Ref.update(stored, (current) => {
          const next = new Map(current);
          next.delete(id);
          return next;
        }),
    });
  }),
);

describe("desktop-local startup bearer exchange", () => {
  function fakeBootstrapEndpoint(beforeExchange?: (request: number) => Promise<void>) {
    const tokenRequests: string[] = [];
    let rejectExchange = false;
    let bootstrapToken = "bootstrap-token";
    let present = true;
    let host = "backend.example.test";
    vi.spyOn(PrimaryTarget, "readPrimaryEnvironmentTarget").mockReturnValue(null);
    vi.stubGlobal("window", {
      location: new URL("http://renderer.example.test/"),
      desktopBridge: {
        getLocalEnvironmentBootstraps: () =>
          present
            ? [
                {
                  id: "wsl:test",
                  label: "WSL test",
                  httpBaseUrl: `http://${host}/`,
                  wsBaseUrl: `ws://${host}/`,
                  bootstrapToken,
                },
              ]
            : [],
      },
    });
    vi.stubGlobal("navigator", { userAgent: "test", platform: "Linux", maxTouchPoints: 0 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname === "/.well-known/t3/environment") {
          return Response.json({
            environmentId: "desktop-secondary-test",
            label: "WSL test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          });
        }
        if (url.pathname === "/oauth/token") {
          tokenRequests.push(url.href);
          const request = tokenRequests.length;
          await beforeExchange?.(request);
          if (rejectExchange) {
            return Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "revoked-session-test",
              },
              { status: 401 },
            );
          }
          return Response.json({
            access_token: `bearer-${request}`,
            issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
            token_type: "Bearer",
            expires_in: 60,
            scope: AuthStandardClientScopes.join(" "),
          });
        }
        throw new Error(`Unexpected endpoint: ${url.href}`);
      }),
    );
    return {
      tokenRequests,
      move: () => {
        host = "restarted-backend.example.test";
      },
      rotate: () => {
        bootstrapToken = "rotated-bootstrap";
      },
      remove: () => {
        present = false;
      },
      revoke: () => {
        rejectExchange = true;
      },
      recover: () => {
        rejectExchange = false;
      },
    };
  }

  it.effect(
    "shares one oauth token exchange between concurrent startup callers for the same backend",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const [first, second] = yield* Effect.all(
            [Stream.runHead(source.registrations), Stream.runHead(source.registrations)],
            { concurrency: "unbounded" },
          );
          expect(endpoint.tokenRequests).toHaveLength(1);
          expect(Option.getOrThrow(first)).toHaveLength(1);
          expect(Option.getOrThrow(second)[0]).toBe(Option.getOrThrow(first)[0]);
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect("exchanges again on the next poll after its bearer credential is invalidated", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(first).toHaveLength(1);
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        const registration = first[0]!;
        if (registration._tag !== "BearerConnectionRegistration")
          throw new Error("Expected bearer");
        yield* credentials.remove(registration.target.connectionId);
        const recovered = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(endpoint.tokenRequests).toHaveLength(2);
        expect(recovered).toHaveLength(1);
        expect(recovered[0]).not.toEqual(first[0]);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("retains a valid bearer and backs off when a rotated bootstrap grant is rejected", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        endpoint.rotate();
        endpoint.revoke();
        const rejected = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(rejected).toEqual(first);
        endpoint.recover();
        const backedOff = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(backedOff).toEqual(first);
        expect(endpoint.tokenRequests).toHaveLength(2);
        yield* TestClock.adjust("60 seconds");
        const recovered = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(endpoint.tokenRequests).toHaveLength(3);
        expect(recovered).not.toEqual(first);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a known revoked bearer is not retained when its bootstrap refresh also fails", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        const target = first[0]!.target;
        if (target._tag !== "BearerConnectionTarget") throw new Error("Expected bearer");
        const credentials = yield* CredentialStore.ConnectionCredentialStore;
        yield* credentials.remove(target.connectionId);
        endpoint.revoke();
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        expect(endpoint.tokenRequests).toHaveLength(2);
        endpoint.recover();
        yield* TestClock.adjust("60 seconds");
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toHaveLength(1);
        expect(endpoint.tokenRequests).toHaveLength(3);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("one canceled consumer leaves the shared exchange running for the other", () =>
    Effect.gen(function* () {
      const started = pendingSignal();
      const release = pendingSignal();
      const endpoint = fakeBootstrapEndpoint(async () => {
        started.resolve();
        await release.promise;
      });
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = yield* Stream.runHead(source.registrations).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => started.promise);
        const second = yield* Stream.runHead(source.registrations).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Fiber.interrupt(first);
        release.resolve();
        expect(Option.getOrThrow(yield* Fiber.join(second))).toHaveLength(1);
        expect(endpoint.tokenRequests).toHaveLength(1);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("all canceled consumers clear the exchange so a later poll can retry", () =>
    Effect.gen(function* () {
      const started = pendingSignal();
      const release = pendingSignal();
      const endpoint = fakeBootstrapEndpoint(async (request) => {
        if (request !== 1) return;
        started.resolve();
        await release.promise;
      });
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = yield* Stream.runHead(source.registrations).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* Effect.promise(() => started.promise);
        yield* Fiber.interrupt(first);
        release.resolve();
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toHaveLength(1);
        expect(endpoint.tokenRequests).toHaveLength(2);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect("a failed exchange is cleared and retried after bootstrap rejection backoff", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      endpoint.revoke();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        endpoint.recover();
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual([]);
        expect(endpoint.tokenRequests).toHaveLength(1);
        yield* TestClock.adjust("60 seconds");
        expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toHaveLength(1);
        expect(endpoint.tokenRequests).toHaveLength(2);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );

  it.effect.each(["rotate", "move", "remove"] as const)(
    "an older exchange cannot emit or store stale registrations after backend %s",
    (change) =>
      Effect.gen(function* () {
        const started = pendingSignal();
        const release = pendingSignal();
        const endpoint = fakeBootstrapEndpoint(async (request) => {
          if (request !== 1) return;
          started.resolve();
          await release.promise;
        });
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const old = yield* Stream.runHead(source.registrations).pipe(
            Effect.forkChild({ startImmediately: true }),
          );
          yield* Effect.promise(() => started.promise);
          endpoint[change]();
          const current = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          release.resolve();
          expect(Option.getOrThrow(yield* Fiber.join(old))).toEqual(current);
          expect(Option.getOrThrow(yield* Stream.runHead(source.registrations))).toEqual(current);
          expect(endpoint.tokenRequests).toHaveLength(change === "remove" ? 1 : 2);
          if (change !== "remove") {
            const registration = current[0]!;
            if (registration._tag !== "BearerConnectionRegistration")
              throw new Error("Expected bearer");
            const credentials = yield* CredentialStore.ConnectionCredentialStore;
            expect(yield* credentials.get(registration.target.connectionId)).toEqual(
              Option.some(registration.credential),
            );
          }
        }).pipe(
          Effect.provide(
            layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect(
    "registry bearer rejection causes the platform's next poll to exchange and reconnect",
    () =>
      Effect.gen(function* () {
        const endpoint = fakeBootstrapEndpoint();
        const freshAttempt = yield* Deferred.make<string>();
        const layerRegistry = EnvironmentRegistry.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(Persistence.ConnectionTargetStore, {
                list: Effect.succeed([]),
                listDisabled: Effect.succeed([]),
              }),
              Layer.succeed(Persistence.ConnectionRegistrationStore, {
                register: () => Effect.void,
                setRoutes: () => Effect.void,
                remove: () => Effect.void,
                setEnabled: () => Effect.void,
              }),
              Layer.succeed(Persistence.EnvironmentCacheStore, {
                loadShell: () => Effect.succeedNone,
                saveShell: () => Effect.void,
                loadThread: () => Effect.succeedNone,
                saveThread: () => Effect.void,
                removeThread: () => Effect.void,
                loadServerConfig: () => Effect.succeedNone,
                saveServerConfig: () => Effect.void,
                loadVcsRefs: () => Effect.succeedNone,
                saveVcsRefs: () => Effect.void,
                removeVcsRefs: () => Effect.void,
                clearVcsRefs: () => Effect.void,
                clear: () => Effect.void,
              }),
              Layer.succeed(ProfileStore.ConnectionProfileStore, {
                get: () => Effect.succeedNone,
                put: () => Effect.void,
                remove: () => Effect.void,
              }),
              Layer.succeed(ClientCapabilities.SshEnvironmentGateway, {
                provision: () => Effect.never,
                prepare: () => Effect.never,
                disconnect: () => Effect.void,
              }),
              Connectivity.layer({ status: Effect.succeed("online"), changes: Stream.never }),
              Wakeups.layer({ changes: Stream.never }),
              Layer.effect(
                EnvironmentRegistry.ConnectionDriver,
                Effect.gen(function* () {
                  const credentials = yield* CredentialStore.ConnectionCredentialStore;
                  return EnvironmentRegistry.ConnectionDriver.of({
                    connect: (entry) =>
                      Effect.gen(function* () {
                        if (entry.target._tag !== "BearerConnectionTarget")
                          return yield* Effect.never;
                        const credential = Option.getOrThrow(
                          yield* credentials.get(entry.target.connectionId),
                        );
                        if (credential.token === "bearer-1")
                          return yield* new ConnectionBlockedError({
                            reason: "authentication",
                            detail: "The environment credential is invalid.",
                            hop: "server",
                          });
                        yield* Deferred.succeed(freshAttempt, credential.token);
                        return yield* Effect.never;
                      }),
                    checkRoute: () => Effect.succeed("unchecked"),
                    preflight: () => Effect.succeed(false),
                  });
                }),
              ),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const source = yield* PlatformConnectionSource.PlatformConnectionSource;
          const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
          const credentials = yield* CredentialStore.ConnectionCredentialStore;
          const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          const target = first[0]!.target;
          if (target._tag !== "BearerConnectionTarget") throw new Error("Expected bearer");
          yield* registry.reconcilePlatform(first);
          yield* registry.stateChanges(target.environmentId).pipe(
            Stream.filter((state) => state.phase === "blocked"),
            Stream.runHead,
          );
          expect(yield* credentials.get(target.connectionId)).toEqual(Option.none());
          const next = Option.getOrThrow(yield* Stream.runHead(source.registrations));
          yield* registry.reconcilePlatform(next);
          expect(yield* Deferred.await(freshAttempt)).toBe("bearer-2");
          expect(endpoint.tokenRequests).toHaveLength(2);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(layerRegistry, layerPlatformConnectionSource).pipe(
              Layer.provideMerge(layerTestCredentials),
            ),
          ),
          Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
          Effect.scoped,
        );
      }),
  );

  it.effect("reuses a valid bearer when the endpoint and bootstrap token are unchanged", () =>
    Effect.gen(function* () {
      const endpoint = fakeBootstrapEndpoint();
      yield* Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const first = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        yield* TestClock.adjust("3 seconds");
        const next = Option.getOrThrow(yield* Stream.runHead(source.registrations));
        expect(first).toHaveLength(1);
        expect(next[0]).toBe(first[0]);
        expect(endpoint.tokenRequests).toHaveLength(1);
      }).pipe(
        Effect.provide(
          layerPlatformConnectionSource.pipe(Layer.provideMerge(layerTestCredentials)),
        ),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
        Effect.scoped,
      );
    }),
  );
});
