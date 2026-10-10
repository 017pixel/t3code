// @effect-diagnostics nodeBuiltinImport:off - the host runs without the Effect runtime to stay small.
// The spawn host: a small Node process that starts the server's children.
// Linux libuv forks to spawn, which copies the parent's page tables and
// blocks its event loop for the copy; a large server pays 10-60 ms per child.
// This process stays small, so its forks are cheap and off the server's
// thread. Each child's stdio sockets go back to the server over the IPC
// channel, so output never passes through here.
//
// `t3 __spawn-host` runs this from bin.ts before the CLI module graph loads,
// so it may import only Node builtins. Nothing runs on import.
import * as NodeChildProcess from "node:child_process";
import type * as NodeNet from "node:net";

export interface SpawnHostSpawnRequest {
  readonly type: "spawn";
  readonly id: number;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: NodeChildProcess.SpawnOptions;
}

export interface SpawnHostError {
  readonly message: string;
  readonly code?: string | undefined;
  readonly errno?: number | undefined;
  readonly syscall?: string | undefined;
  readonly path?: string | undefined;
  readonly spawnargs?: ReadonlyArray<string> | undefined;
}

/** Sent in order per child: `stdio` once per piped fd (carrying the socket), `spawn`, then `exit`. */
export type SpawnHostEvent =
  | { readonly type: "ready" }
  | { readonly type: "stdio"; readonly id: number; readonly fd: number }
  | { readonly type: "spawn"; readonly id: number; readonly pid: number }
  | {
      readonly type: "exit";
      readonly id: number;
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    }
  | { readonly type: "error"; readonly id: number; readonly error: SpawnHostError };

const toSpawnHostError = (cause: unknown): SpawnHostError => {
  const error = cause as Partial<NodeJS.ErrnoException> & { spawnargs?: ReadonlyArray<string> };
  return {
    message: typeof error?.message === "string" ? error.message : String(cause),
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    spawnargs: error?.spawnargs,
  };
};

/**
 * Stops the read Node starts on each stdio socket as it creates it. Child
 * stdio has no public paused option; net's `pauseOnCreate` makes this same call.
 */
const stopReading = (socket: NodeNet.Socket) =>
  (socket as unknown as { _handle?: { readStop?: () => void } | null })._handle?.readStop?.();

export function runSpawnHost(): void {
  const channel = process.send?.bind(process);
  if (!channel) {
    process.stderr.write("t3 __spawn-host is started by the T3 server.\n");
    process.exitCode = 1;
    return;
  }
  const send = (event: SpawnHostEvent, socket?: NodeNet.Socket) => channel(event, socket);

  // The server decides when its children stop. A terminal's Ctrl-C or a service
  // manager's SIGTERM reaches the whole group, and the host must keep reporting
  // exits while the server cleans up; it leaves when the server's channel closes.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => {});
  process.on("disconnect", () => process.exit(0));

  process.on("message", (request: SpawnHostSpawnRequest) => {
    if (request.type !== "spawn") return;
    const { id } = request;
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(request.command, [...request.args], request.options);
    } catch (cause) {
      send({ type: "error", id, error: toSpawnHostError(cause) });
      return;
    }
    // Every byte the child writes must stay in the kernel until the server owns
    // the socket. The loop has not polled yet, so nothing was read so far.
    const stdio = child.stdio.map((socket) => {
      if (socket) stopReading(socket as NodeNet.Socket);
      return socket as NodeNet.Socket | null;
    });
    // ChildProcess destroys stdin on exit, which can come before its socket leaves the send queue.
    child.stdin = null;
    child.on("error", (cause) => send({ type: "error", id, error: toSpawnHostError(cause) }));
    child.once("spawn", () => {
      stdio.forEach((socket, fd) => {
        if (socket) send({ type: "stdio", id, fd }, socket);
      });
      send({ type: "spawn", id, pid: child.pid! });
    });
    child.on("exit", (code, signal) => send({ type: "exit", id, code, signal }));
  });
  send({ type: "ready" });
}
