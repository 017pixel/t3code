// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the host client drives a Node child process from its IPC callbacks, outside the Effect runtime.
/**
 * The server's `ChildProcessSpawner`. On Linux, libuv forks to spawn, and the
 * kernel copies the server's page tables while the event loop waits: 10-60 ms
 * per git, gh, rg or provider CLI once the heap is large. Children start from
 * the small spawn host process instead (spawnHostProcess.ts), and their stdio
 * sockets come back to this process, so streams, exit codes, signals, process
 * groups and kills behave as with a direct spawn. macOS spawns with
 * posix_spawn and Windows with CreateProcess, which copy nothing, so they
 * spawn directly. If the host cannot start or keeps dying, children spawn
 * directly too.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import type * as NodeNet from "node:net";
import type * as NodeStream from "node:stream";

import * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";

import type { SpawnHostError, SpawnHostEvent, SpawnHostSpawnRequest } from "./spawnHostProcess.ts";

/** After this many host crashes or failed starts, children spawn directly. */
const MAX_HOST_FAILURES = 3;
const HOST_READY_TIMEOUT_MS = 10_000;
/** The options the Effect spawner passes; anything else spawns directly. */
const HOSTED_OPTION_KEYS: ReadonlySet<string> = new Set([
  "cwd",
  "env",
  "stdio",
  "detached",
  "shell",
  "windowsHide",
]);
const HOSTED_STDIO: ReadonlySet<unknown> = new Set([undefined, null, "pipe", "ignore", "inherit"]);

const canHost = (options: NodeChildProcess.SpawnOptions) =>
  Object.keys(options).every((key) => HOSTED_OPTION_KEYS.has(key)) &&
  Array.isArray(options.stdio) &&
  options.stdio.every((stdio) => HOSTED_STDIO.has(stdio));

const toSpawnError = (error: SpawnHostError) =>
  Object.assign(new Error(error.message), {
    code: error.code,
    errno: error.errno,
    syscall: error.syscall,
    path: error.path,
    spawnargs: error.spawnargs,
  });

const killGroupOrProcess = (pid: number, signal: NodeJS.Signals) => {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
};

export interface SpawnHostFailure {
  readonly failures: number;
  /** Every later child spawns directly. */
  readonly disabled: boolean;
  readonly cause: unknown;
}

/** A child started by the host, shaped like the `ChildProcess` the Effect spawner reads. */
class HostedChildProcess
  extends NodeEvents.EventEmitter
  implements NodeChildProcessSpawner.SpawnedChildProcess
{
  pid: number | undefined = undefined;
  stdin: NodeStream.Writable | null = null;
  stdout: NodeStream.Readable | null = null;
  stderr: NodeStream.Readable | null = null;
  stdio: Array<NodeStream.Readable | NodeStream.Writable | null | undefined> = [];
  state: "queued" | "sent" | "running" | "exited" = "queued";
  referenced = true;
  readonly request: SpawnHostSpawnRequest;
  readonly #client: SpawnHostClient;
  #pendingSignal: NodeJS.Signals | number | undefined;
  #direct: NodeChildProcess.ChildProcess | undefined;

  constructor(client: SpawnHostClient, request: SpawnHostSpawnRequest) {
    super();
    this.#client = client;
    this.request = request;
  }

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    if (this.#direct) return this.#direct.kill(signal);
    if (this.state === "exited") return false;
    if (this.state === "queued") {
      // Never sent: dropping the request is the whole kill.
      this.#client.settle(this);
      return true;
    }
    if (this.pid === undefined) {
      this.#pendingSignal = signal;
      return true;
    }
    try {
      process.kill(this.pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  ref(): void {
    if (this.#direct) this.#direct.ref();
    else this.#client.setReferenced(this, true);
  }

  unref(): void {
    if (this.#direct) this.#direct.unref();
    else this.#client.setReferenced(this, false);
  }

  attachStdio(fd: number, socket: NodeNet.Socket): void {
    this.stdio[fd] = socket;
    if (fd === 0) this.stdin = socket;
    else if (fd === 1) this.stdout = socket;
    else if (fd === 2) this.stderr = socket;
  }

  markSpawned(pid: number): void {
    this.state = "running";
    this.pid = pid;
    if (this.#pendingSignal !== undefined) this.kill(this.#pendingSignal);
    this.emit("spawn");
  }

  markExited(code: number | null, signal: NodeJS.Signals | null): void {
    this.#client.settle(this);
    // Node destroys a child's stdin when it exits.
    this.stdin?.destroy();
    this.emit("exit", code, signal);
  }

  markFailed(error: Error): void {
    this.#client.settle(this);
    this.emit("error", error);
  }

  /** Spawns from this process a request no host ever received. */
  spawnDirectly(): void {
    this.#client.settle(this);
    const { command, args, options } = this.request;
    const child = NodeChildProcess.spawn(command, [...args], options);
    this.#direct = child;
    this.stdin = child.stdin;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.stdio = [...child.stdio];
    if (!this.referenced) child.unref();
    child.on("error", (error) => this.emit("error", error));
    child.on("spawn", () => {
      this.pid = child.pid;
      this.emit("spawn");
    });
    child.on("exit", (code, signal) => this.emit("exit", code, signal));
  }
}

class SpawnHostClient {
  readonly #command: string;
  readonly #args: ReadonlyArray<string>;
  readonly #onHostFailure: (failure: SpawnHostFailure) => void;
  readonly #children = new Map<number, HostedChildProcess>();
  #host: NodeChildProcess.ChildProcess | undefined;
  #ready = false;
  #closed = false;
  #failures = 0;
  #nextId = 0;
  #referencedChildren = 0;
  #readyTimer: NodeJS.Timeout | undefined;

  constructor(
    command: string,
    args: ReadonlyArray<string>,
    onHostFailure: (failure: SpawnHostFailure) => void,
  ) {
    this.#command = command;
    this.#args = args;
    this.#onHostFailure = onHostFailure;
  }

  readonly spawn = (
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ): NodeChildProcessSpawner.SpawnedChildProcess => {
    if (this.#closed || this.#failures >= MAX_HOST_FAILURES || !canHost(options)) {
      return NodeChildProcess.spawn(command, [...args], options);
    }
    const child = new HostedChildProcess(this, {
      type: "spawn",
      id: ++this.#nextId,
      command,
      args,
      // The host's own cwd and env are a snapshot from its start; send this process's.
      options: { ...options, cwd: options.cwd ?? process.cwd(), env: options.env ?? process.env },
    });
    this.#children.set(child.request.id, child);
    this.#referencedChildren++;
    if (this.#ready) this.#send(child);
    else this.#start();
    this.#syncChannelRef();
    return child;
  };

  /** Forgets a child that exited, failed, was dropped, or moved to a direct spawn. */
  settle(child: HostedChildProcess): void {
    if (child.state === "exited") return;
    child.state = "exited";
    this.#children.delete(child.request.id);
    if (child.referenced) this.#referencedChildren--;
    this.#syncChannelRef();
  }

  setReferenced(child: HostedChildProcess, referenced: boolean): void {
    if (child.referenced === referenced) return;
    child.referenced = referenced;
    if (child.state !== "exited") this.#referencedChildren += referenced ? 1 : -1;
    this.#syncChannelRef();
  }

  close(): void {
    this.#closed = true;
    clearTimeout(this.#readyTimer);
    const host = this.#host;
    this.#host = undefined;
    if (host?.connected) host.disconnect();
  }

  // Like a direct child's process handle, the channel keeps this process
  // alive only while a referenced child runs.
  #syncChannelRef(): void {
    const channel = this.#host?.channel;
    if (!channel) return;
    if (this.#referencedChildren > 0) channel.ref();
    else channel.unref();
  }

  #send(child: HostedChildProcess): void {
    child.state = "sent";
    this.#host?.send(child.request);
  }

  #start(): void {
    if (this.#host) return;
    const env = { ...process.env };
    // The host runs only its own module; preloads and flags meant for the server stay out.
    delete env.NODE_OPTIONS;
    let host: NodeChildProcess.ChildProcess;
    try {
      host = NodeChildProcess.spawn(this.#command, [...this.#args], {
        env,
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      });
    } catch (cause) {
      this.#failures++;
      this.#onHostLost(cause);
      return;
    }
    this.#host = host;
    host.unref();
    this.#syncChannelRef();
    this.#readyTimer = setTimeout(() => {
      host.kill("SIGKILL");
      this.#lose(host, new Error("The spawn host did not start in time."));
    }, HOST_READY_TIMEOUT_MS);
    this.#readyTimer.unref();
    host.on("message", (event, socket) => {
      if (host === this.#host) {
        this.#onEvent(event as SpawnHostEvent, socket as NodeNet.Socket | undefined);
      }
    });
    host.once("error", (cause) => this.#lose(host, cause));
    // `close` follows the last IPC message, so every exit the host reported is handled first.
    host.once("close", (code, signal) =>
      this.#lose(host, new Error(`The spawn host exited (code ${code}, signal ${signal}).`)),
    );
  }

  #onEvent(event: SpawnHostEvent, socket: NodeNet.Socket | undefined): void {
    if (event.type === "ready") {
      clearTimeout(this.#readyTimer);
      this.#ready = true;
      for (const child of this.#children.values()) {
        if (child.state === "queued") this.#send(child);
      }
      return;
    }
    const child = this.#children.get(event.id);
    if (!child) {
      socket?.destroy();
      return;
    }
    switch (event.type) {
      case "stdio":
        if (socket) child.attachStdio(event.fd, socket);
        return;
      case "spawn":
        child.markSpawned(event.pid);
        return;
      case "exit":
        child.markExited(event.code, event.signal);
        return;
      case "error":
        child.markFailed(toSpawnError(event.error));
        return;
    }
  }

  #lose(host: NodeChildProcess.ChildProcess, cause: unknown): void {
    if (host !== this.#host) return;
    clearTimeout(this.#readyTimer);
    this.#host = undefined;
    this.#ready = false;
    if (host.connected) host.disconnect();
    if (this.#closed) return;
    this.#failures++;
    this.#onHostLost(cause);
  }

  #onHostLost(cause: unknown): void {
    const disabled = this.#failures >= MAX_HOST_FAILURES;
    this.#onHostFailure({ failures: this.#failures, disabled, cause });
    for (const child of this.#children.values()) {
      if (child.state === "queued") {
        // The host never saw it, so it cannot have started. It waits for the next host.
        if (disabled) child.spawnDirectly();
      } else if (child.state === "sent") {
        // It may have started; spawning again could run it twice.
        child.markFailed(new Error("The spawn host exited before reporting the spawn."));
      } else if (child.pid !== undefined) {
        // Its exit status left with the host. Stop the group it leads, as a scope release would.
        killGroupOrProcess(child.pid, "SIGKILL");
        child.markExited(null, "SIGKILL");
      }
    }
    if (this.#children.size > 0 && !disabled) this.#start();
  }
}

/** Starts children from the spawn host that `command args` runs. */
export const layerHost = (
  command: string,
  args: ReadonlyArray<string>,
  onHostFailure: (failure: SpawnHostFailure) => void,
) =>
  Layer.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => new SpawnHostClient(command, args, onHostFailure)),
      (client) => Effect.sync(() => client.close()),
    ).pipe(Effect.map((client) => NodeChildProcessSpawner.layerWithSpawn(client.spawn))),
  );

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "linux") return NodeChildProcessSpawner.layer;
    const invocation = yield* resolveSelfInvocation();
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    return layerHost(
      invocation.command,
      selfInvocationArgs(invocation, ["__spawn-host"]),
      ({ failures, disabled, cause }) =>
        runFork(
          Effect.logWarning(
            disabled
              ? "The spawn host failed; child processes now start from the server."
              : "The spawn host stopped; it restarts for the next child process.",
            { failures, cause },
          ),
        ),
    );
  }),
);
