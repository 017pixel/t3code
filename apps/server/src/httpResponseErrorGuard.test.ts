// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  guardHttpResponseWriteErrors,
  holdRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";

const servers: NodeHttp.Server[] = [];

function listen(server: NodeHttp.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as NodeNet.AddressInfo).port);
    });
  });
}

function fetchStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = NodeHttp.get({ host: "127.0.0.1", port, path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.setTimeout(5_000, () => reject(new Error("request timed out")));
  });
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

describe("guardHttpResponseWriteErrors", () => {
  it("contains an upgrade socket write failure instead of crashing the process", async () => {
    const writeErrors: unknown[] = [];
    const failureObserved = Promise.withResolvers<void>();
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
      failureObserved.resolve();
    });

    server.on("upgrade", (_request, socket) => {
      // Simulate the client vanishing while the auth rejection response is
      // written to the upgrade socket: the write failure surfaces as an
      // "error" event on a socket Node's http server no longer listens to.
      socket.destroy(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    });

    const port = await listen(server);

    const client = NodeNet.connect(port, "127.0.0.1", () => {
      client.write(
        [
          "GET /rpc HTTP/1.1",
          "Host: 127.0.0.1",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"),
      );
    });
    client.on("error", () => {});

    await failureObserved.promise;
    client.destroy();

    expect(writeErrors).toHaveLength(1);
    expect(writeErrors[0]).toBeInstanceOf(Error);
    expect((writeErrors[0] as NodeJS.ErrnoException).code).toBe("EPIPE");

    server.on("request", (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });
    await expect(fetchStatus(port, "/")).resolves.toBe(200);
  });

  it("arms every response with an error listener without disturbing normal traffic", async () => {
    const writeErrors: unknown[] = [];
    let responseErrorListeners = -1;
    const server = guardHttpResponseWriteErrors(NodeHttp.createServer(), (error) => {
      writeErrors.push(error);
    });

    server.on("request", (_request, response) => {
      responseErrorListeners = response.listenerCount("error");
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    });

    const port = await listen(server);

    await expect(fetchStatus(port, "/")).resolves.toBe(200);
    expect(responseErrorListeners).toBeGreaterThan(0);
    expect(writeErrors).toEqual([]);
  });
});

it("serves HTTP and websocket requests received before handlers attach", async () => {
  const server = holdRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer()));
  const port = await listen(server);
  const parsed = Promise.withResolvers<void>();
  let received = 0;
  server.on("connection", (socket) =>
    socket.once("data", () => {
      if (++received === 2) parsed.resolve();
    }),
  );
  const response = fetchStatus(port, "/early");
  const client = NodeNet.connect(port, "127.0.0.1");
  const upgrade = new Promise<string>((resolve, reject) => {
    client.once("connect", () =>
      client.write(
        "GET /ws HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      ),
    );
    client.once("data", (data) => resolve(data.toString().split("\r\n")[0]!));
    client.once("error", reject);
  });
  try {
    await parsed.promise;
    server.on("request", (_, outgoing) => {
      outgoing.writeHead(204);
      outgoing.end();
    });
    server.on("upgrade", (_, socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\n\r\n"));
    await expect(response).resolves.toBe(204);
    await expect(upgrade).resolves.toBe("HTTP/1.1 101 Switching Protocols");
  } finally {
    client.destroy();
    server.closeAllConnections();
  }
});

it("bounds pending HTTP and upgrade admission and serves requests after attachment", async () => {
  const server = holdRequestsUntilServing(guardHttpResponseWriteErrors(NodeHttp.createServer()));
  const sockets: NodeNet.Socket[] = [];
  const handled: string[] = [];
  const send = (kind: "request" | "upgrade", url: string) => {
    const socket = new NodeNet.Socket();
    sockets.push(socket);
    const request = new NodeHttp.IncomingMessage(socket);
    request.url = url;
    const response = new NodeHttp.ServerResponse(request);
    response.assignSocket(socket);
    if (kind === "request") server.emit(kind, request, response);
    else server.emit(kind, request, socket, Buffer.alloc(0));
    return { socket, response };
  };

  try {
    // Both event types share the startup budget; two independent limits would
    // retain twice as many requests.
    const admitted = Array.from({ length: 256 }, (_, i) => `/early/${i}`);
    admitted.forEach((url, i) => send(i % 2 === 0 ? "request" : "upgrade", url));
    const excessHttp = send("request", "/excess-http");
    const excessUpgrade = send("upgrade", "/excess-upgrade");
    expect.soft(excessHttp.socket.destroyed || excessHttp.response.writableEnded).toBe(true);
    expect.soft(excessUpgrade.socket.destroyed || excessUpgrade.socket.writableEnded).toBe(true);

    server.on("request", (request, response) => {
      handled.push(request.url!);
      response.end();
    });
    server.on("upgrade", (request, socket) => {
      handled.push(request.url!);
      socket.destroy();
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect.soft(handled.toSorted()).toEqual(admitted.toSorted());

    handled.length = 0;
    send("request", "/after-http");
    send("upgrade", "/after-upgrade");
    expect(handled).toEqual(["/after-http", "/after-upgrade"]);
  } finally {
    for (const socket of sockets) socket.destroy();
  }
});
