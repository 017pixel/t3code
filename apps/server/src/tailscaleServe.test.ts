import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";

import * as TailscaleServe from "./tailscaleServe.ts";

const encoder = new TextEncoder();

// Stands in for the tailscale CLI: `serve --bg` is refused until the daemon
// accepts it (operator permission granted, or Tailscale.app finished starting).
const makeFakeTailscale = (refusedServeAttempts: number) => {
  const state = { serveAttempts: 0, configured: false, disables: 0 };
  const handle = (args: ReadonlyArray<string>) => {
    if (args[0] === "serve" && args[1] === "--bg") {
      state.serveAttempts += 1;
      if (state.serveAttempts <= refusedServeAttempts) {
        return { code: 1, stderr: "Access denied: serve config denied" };
      }
      state.configured = true;
      return { code: 0 };
    }
    if (args[0] === "serve" && args.at(-1) === "off") {
      state.disables += 1;
      state.configured = false;
      return { code: 0 };
    }
    return { code: 1, stderr: "unexpected command" };
  };
  const spawner = ChildProcessSpawner.make((command) => {
    const { args } = command as unknown as { readonly args: ReadonlyArray<string> };
    const result = handle(args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.code)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.make(encoder.encode(result.stderr ?? "")),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { state, spawner };
};

const startTailscaleServe = Effect.fn(function* (refusedServeAttempts: number) {
  const fake = makeFakeTailscale(refusedServeAttempts);
  const parked = yield* Deferred.make<void>();
  const scope = yield* Scope.make();
  yield* Layer.buildWithScope(
    TailscaleServe.layer({ servePort: 18443, parked, awaitActivation: Effect.void }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, fake.spawner),
          Layer.succeed(HostProcess.Platform, "linux"),
          Layer.mock(HttpServer.HttpServer)({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 18638),
          }),
        ),
      ),
    ),
    scope,
  );
  return { state: fake.state, scope };
});

describe("TailscaleServe", () => {
  // regression: #16238 - a refused first `tailscale serve` left Serve off
  // until the server was restarted.
  it.effect("configures Serve once a later attempt succeeds, without a restart", () =>
    Effect.gen(function* () {
      const { state } = yield* startTailscaleServe(1);
      assert.isFalse(state.configured);

      yield* TestClock.adjust("1 hour");

      assert.isTrue(state.configured, "Serve was never configured after the first refusal");
    }),
  );

  it.effect("disables Serve on shutdown after a later attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe(1);
      yield* TestClock.adjust("1 hour");

      yield* Scope.close(scope, Exit.void);

      assert.equal(state.disables, 1);
      assert.isFalse(state.configured);
    }),
  );

  it.effect("stops retrying on shutdown and leaves Serve alone if no attempt succeeded", () =>
    Effect.gen(function* () {
      const { state, scope } = yield* startTailscaleServe(Number.POSITIVE_INFINITY);
      yield* TestClock.adjust("1 minute");
      const attemptsBeforeShutdown = state.serveAttempts;

      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust("1 hour");

      assert.isAbove(attemptsBeforeShutdown, 1);
      assert.equal(state.serveAttempts, attemptsBeforeShutdown);
      assert.equal(state.disables, 0);
    }),
  );
});
