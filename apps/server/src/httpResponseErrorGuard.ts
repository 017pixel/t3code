// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeHttp from "node:http";

/**
 * An "error" event without a listener escalates into an uncaught exception and
 * terminates the whole server process, taking every other client and all
 * in-flight provider work with it.
 */
export function guardHttpResponseWriteErrors<T extends NodeHttp.Server>(
  server: T,
  onError?: (error: unknown) => void,
): T {
  server.on("request", (_request, response) => {
    response.on("error", (error) => {
      onError?.(error);
    });
  });
  server.on("upgrade", (_request, socket) => {
    socket.on("error", (error) => {
      onError?.(error);
    });
  });
  return server;
}

/** Node starts listening before HttpRouter.serve attaches its handlers. */
export function holdRequestsUntilServing<T extends NodeHttp.Server>(server: T): T {
  for (const event of ["request", "upgrade"] as const) {
    const existing = new Set(server.listeners(event));
    const parked: Array<ReadonlyArray<unknown>> = [];
    const park = (...args: ReadonlyArray<unknown>) => {
      parked.push(args);
    };
    const onNewListener = (name: string | symbol) => {
      if (name !== event) return;
      server.off("newListener", onNewListener);
      server.off(event, park);
      // newListener fires before attachment. Replay before subsequent connection I/O.
      queueMicrotask(() => {
        const handlers = server.listeners(event).filter((listener) => !existing.has(listener));
        for (const args of parked.splice(0)) {
          for (const handler of handlers) handler.call(server, ...args);
        }
      });
    };
    server.on(event, park);
    server.on("newListener", onNewListener);
  }
  return server;
}
