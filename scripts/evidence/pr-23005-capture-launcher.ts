// @effect-diagnostics nodeBuiltinImport:off - Evidence helper; copied next to tunnel.ts in the checkout under test.
// Prints the exact launch script launchOrReuseRemoteServer sends over SSH.
// Uses only the public launchOrReuseRemoteServer so it runs unchanged on
// checkouts that predate launcherTestHarness.ts.
// Usage: node <checkout>/packages/ssh/src/<this file> <out.sh> node <bin.ts> | archive <version>
// Writes to a file because the Effect logger prints to stdout.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import { launchOrReuseRemoteServer } from "./tunnel.ts";

const [out, mode, value] = process.argv.slice(2);
if (!out || (mode !== "node" && mode !== "archive") || !value) {
  console.error("usage: <out.sh> node <bin.ts> | archive <version>");
  process.exit(2);
}

let script = "";
const spawner = ChildProcessSpawner.make((command) =>
  Effect.gen(function* () {
    if (command._tag === "StandardCommand") {
      const stdin = command.options.stdin;
      if (typeof stdin === "object" && "stream" in stdin && Stream.isStream(stdin.stream)) {
        script = yield* stdin.stream.pipe(Stream.decodeText(), Stream.mkString);
      }
    }
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(123),
      stdout: Stream.make(new TextEncoder().encode('{"remotePort":3773}\n')),
      stderr: Stream.empty,
      all: Stream.empty,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }),
);

await Effect.runPromise(
  launchOrReuseRemoteServer(
    { alias: "evidence", hostname: "evidence.invalid", username: null, port: null },
    undefined,
    mode === "node" ? { nodeScriptPath: value } : { archiveVersion: value },
  ).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    ),
  ),
);
NodeFS.writeFileSync(out, script);
