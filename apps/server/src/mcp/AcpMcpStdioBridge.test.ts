// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
import * as NodeStream from "node:stream";

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";

import { mcpToolSession, runAcpMcpStdioBridge } from "./AcpMcpStdioBridge.ts";

function makeHarness(responder: (request: Request) => Promise<Response> | Response) {
  const input = new NodeStream.PassThrough();
  const written: Array<string> = [];
  const requests: Array<{ readonly headers: Headers; readonly body: string }> = [];
  const bridge = runAcpMcpStdioBridge({
    endpoint: "http://127.0.0.1:1/mcp",
    authorization: "Bearer bridge-test",
    input,
    output: {
      write: (chunk: string) => {
        written.push(chunk);
      },
    },
    fetchImplementation: async (_url, init) => {
      const request = new Request("http://127.0.0.1:1/mcp", init);
      requests.push({ headers: request.headers, body: String(init?.body ?? "") });
      return responder(request);
    },
  });
  return { input, written, requests, bridge };
}

function pendingFetch(started: Deferred.Deferred<AbortSignal | undefined>) {
  return (_url: string, init?: RequestInit): Promise<Response> => {
    Deferred.doneUnsafe(started, Effect.succeed(init?.signal ?? undefined));
    return new Promise(() => {});
  };
}

describe("AcpMcpStdioBridge", () => {
  it.effect("forwards requests and replays the session id and protocol version", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness((request) => {
        const body = JSON.parse(String(requests.at(-1)?.body ?? "{}")) as { id?: number };
        void request;
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id ?? null,
            result: body.id === 1 ? { protocolVersion: "2025-06-18" } : { ok: true },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
          },
        );
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(2);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 1 });
      expect(JSON.parse(written[1]!)).toMatchObject({ id: 2, result: { ok: true } });
      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
    }),
  );

  it.effect("acknowledges notifications silently and synthesizes errors for failed requests", () =>
    Effect.gen(function* () {
      let call = 0;
      const { input, written, bridge } = makeHarness(() => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 202 })
          : new Response("upstream broke", { status: 500 });
      });
      const fiber = yield* Effect.forkChild(bridge);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })}\n`);
      input.end();
      yield* Fiber.join(fiber);

      expect(written).toHaveLength(1);
      expect(JSON.parse(written[0]!)).toMatchObject({
        id: 3,
        error: { code: -32603 },
      });
    }),
  );

  it.effect("emits parse errors for malformed JSON-RPC input", () =>
    Effect.gen(function* () {
      const { input, written, requests, bridge } = makeHarness(
        () => new Response(null, { status: 202 }),
      );
      const fiber = yield* Effect.forkChild(bridge);

      input.end("{not-json}\n");
      yield* Fiber.join(fiber);

      expect(requests).toHaveLength(0);
      expect(JSON.parse(written[0]!)).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }),
  );

  it.effect("forwards SSE messages before the HTTP response closes", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      let firstWrite: (() => void) | undefined;
      const firstWritten = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              firstWrite?.();
            },
          },
          fetchImplementation: async () =>
            new Response(
              new ReadableStream<Uint8Array>({
                start: (controller) => {
                  resolveResponseController(controller);
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            ),
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      const responseController = yield* Effect.promise(() => responseControllerReady);
      responseController.enqueue(
        new TextEncoder().encode(
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ),
      );
      yield* Effect.promise(() => firstWritten);
      expect(JSON.parse(written[0]!)).toMatchObject({ method: "notifications/progress" });

      responseController.enqueue(
        new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
      );
      responseController.close();
      input.end();
      yield* Fiber.join(fiber);
      expect(written).toHaveLength(2);
    }),
  );

  it.effect("forwards client responses while an SSE request is still open", () =>
    Effect.gen(function* () {
      let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
      let serverRequestWritten: (() => void) | undefined;
      const serverRequestReachedClient = new Promise<void>((resolve) => {
        serverRequestWritten = resolve;
      });
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: {
            write: (chunk) => {
              written.push(chunk);
              if (JSON.parse(chunk).id === "server-request-1") serverRequestWritten?.();
            },
          },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly id?: unknown;
              readonly method?: unknown;
              readonly result?: unknown;
            };
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: (controller) => {
                    responseController = controller;
                    controller.enqueue(
                      new TextEncoder().encode(
                        'data: {"jsonrpc":"2.0","id":"server-request-1","method":"elicitation/create","params":{}}\n\n',
                      ),
                    );
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            expect(body).toMatchObject({ id: "server-request-1", result: { action: "accept" } });
            responseController?.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            responseController?.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => serverRequestReachedClient);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: "server-request-1", result: { action: "accept" } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(written.map((line) => JSON.parse(line).id)).toEqual(["server-request-1", 7]);
    }),
  );

  it.effect("forwards cancellation while a tool SSE response is still open", () =>
    Effect.gen(function* () {
      let resolveResponseController!: (
        controller: ReadableStreamDefaultController<Uint8Array>,
      ) => void;
      const responseControllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>(
        (resolve) => {
          resolveResponseController = resolve;
        },
      );
      const methods: Array<string> = [];
      const input = new NodeStream.PassThrough();
      const written: Array<string> = [];
      const fiber = yield* Effect.forkChild(
        runAcpMcpStdioBridge({
          endpoint: "http://127.0.0.1:1/mcp",
          authorization: "Bearer bridge-test",
          input,
          output: { write: (chunk) => written.push(chunk) },
          fetchImplementation: async (_url, init) => {
            const body = JSON.parse(String(init?.body ?? "{}")) as {
              readonly method?: string;
            };
            methods.push(body.method ?? "");
            if (body.method === "tools/call") {
              return new Response(
                new ReadableStream<Uint8Array>({
                  start: resolveResponseController,
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            }
            const controller = await responseControllerReady;
            controller.enqueue(
              new TextEncoder().encode('data: {"jsonrpc":"2.0","id":7,"result":{}}\n\n'),
            );
            controller.close();
            return new Response(null, { status: 202 });
          },
        }),
      );

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call" })}\n`);
      yield* Effect.promise(() => responseControllerReady);
      input.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } })}\n`,
      );
      input.end();
      yield* Fiber.join(fiber);

      expect(methods).toEqual(["tools/call", "notifications/cancelled"]);
      expect(JSON.parse(written[0]!)).toMatchObject({ id: 7, result: {} });
    }),
  );

  it.effect("aborts the pending fetch when a tool call is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const fiber = yield* mcpToolSession({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        clientName: "t3-code-acp-cli",
        fetchImplementation: pendingFetch(started),
      }).pipe(
        Effect.flatMap((session) => session.call("orchestrator_capabilities", {})),
        Effect.scoped,
        Effect.forkChild,
      );

      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );

  for (const transport of ["session", "stdio"] as const) {
    it.effect.each(["application/json", "text/event-stream"])(
      `aborts a stalled %s body when the ${transport} caller is interrupted`,
      (contentType) =>
        Effect.gen(function* () {
          const reading = yield* Deferred.make<AbortSignal | undefined>();
          const input = new NodeStream.PassThrough();
          yield* Effect.addFinalizer(() => Effect.sync(() => input.destroy()));
          let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
          yield* Effect.addFinalizer(() => Effect.sync(() => bodyController?.error("test ended")));
          const fetchImplementation = async (_url: string, init?: RequestInit) => {
            if (init?.method === "DELETE") return new Response(null, { status: 204 });
            const body = JSON.parse(String(init?.body)) as { id?: string; method: string };
            if (body.method !== "tools/call") {
              return body.id === undefined
                ? new Response(null, { status: 202 })
                : Response.json({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: { protocolVersion: "2025-06-18" },
                  });
            }
            return new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  bodyController = controller;
                  init?.signal?.addEventListener("abort", () => controller.error("aborted"));
                  controller.enqueue(
                    new TextEncoder().encode(
                      contentType === "application/json" ? '{"jsonrpc":' : 'data: {"jsonrpc":',
                    ),
                  );
                },
                pull() {
                  Deferred.doneUnsafe(reading, Effect.succeed(init?.signal ?? undefined));
                },
              }),
              { headers: { "content-type": contentType } },
            );
          };
          const options = {
            endpoint: "http://127.0.0.1:1/mcp",
            clientName: "t3-code-mesh",
            authorization: "Bearer bridge-test",
            fetchImplementation,
          };
          const call = yield* (
            transport === "session"
              ? mcpToolSession(options).pipe(
                  Effect.flatMap((session) => session.call("t3_thread_read", {})),
                  Effect.scoped,
                )
              : runAcpMcpStdioBridge({ ...options, input, output: { write: () => undefined } })
          ).pipe(Effect.forkChild);
          if (transport === "stdio") {
            input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" })}\n`);
          }

          const signal = yield* Deferred.await(reading);
          yield* Fiber.interrupt(call);

          expect(signal?.aborted).toBe(true);
        }),
    );
  }

  it.effect("awaits DELETE before closing the session scope without a request timeout", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const events: Array<string> = [];
      let releaseDelete!: (response: Response) => void;
      const pendingDelete = new Promise<Response>((resolve) => {
        releaseDelete = resolve;
      });
      const call = yield* mcpToolSession({
        endpoint: "http://127.0.0.1:1/mcp",
        clientName: "t3-code-cli",
        authorization: "Bearer bridge-test",
        fetchImplementation: async (_url, init) => {
          if (init?.method === "DELETE") {
            Deferred.doneUnsafe(started, Effect.void);
            const response = await pendingDelete;
            events.push("delete completed");
            return response;
          }
          const body = JSON.parse(String(init?.body)) as { id?: string; method: string };
          return body.id === undefined
            ? new Response(null, { status: 202 })
            : Response.json(
                {
                  jsonrpc: "2.0",
                  id: body.id,
                  result:
                    body.method === "initialize"
                      ? { protocolVersion: "2025-06-18" }
                      : { content: [] },
                },
                { headers: { "mcp-session-id": "session-cli-cleanup" } },
              );
        },
      }).pipe(
        Effect.flatMap((session) => session.call("t3_thread_read", {})),
        Effect.scoped,
        Effect.ensuring(Effect.sync(() => events.push("scope closed"))),
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust("0 seconds");
      releaseDelete(new Response(null, { status: 204 }));
      yield* Fiber.join(call);

      expect(events).toEqual(["delete completed", "scope closed"]);
    }),
  );

  it.effect.each(["result", "deadline", "cancellation"] as const)(
    "does not delay the caller's %s while DELETE is pending and aborts cleanup after two seconds",
    (completion) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<AbortSignal | undefined>();
        const toolStarted = yield* Deferred.make<AbortSignal | undefined>();
        let releaseDelete: (response: Response) => void = () => {};
        const pendingDelete = new Promise<Response>((resolve) => {
          releaseDelete = resolve;
        });
        const call = yield* mcpToolSession({
          endpoint: "http://127.0.0.1:1/mcp",
          clientName: "t3-code-mesh",
          requestTimeout: "60 seconds",
          fetchImplementation: async (_url, init) => {
            if (init?.method === "DELETE") {
              Deferred.doneUnsafe(started, Effect.succeed(init.signal ?? undefined));
              return pendingDelete;
            }
            const body = JSON.parse(String(init?.body)) as { id?: string; method: string };
            if (body.method === "tools/call" && completion !== "result") {
              return pendingFetch(toolStarted)(_url, init);
            }
            return body.id === undefined
              ? new Response(null, { status: 202 })
              : Response.json(
                  {
                    jsonrpc: "2.0",
                    id: body.id,
                    result:
                      body.method === "initialize"
                        ? { protocolVersion: "2025-06-18" }
                        : { content: [] },
                  },
                  { headers: { "mcp-session-id": "session-cleanup" } },
                );
          },
        }).pipe(
          Effect.flatMap((session) => session.call("t3_thread_search", {})),
          Effect.scoped,
          Effect.timeoutOption("10 seconds"),
          Effect.forkChild,
        );

        if (completion !== "result") yield* Deferred.await(toolStarted);
        const cancellation =
          completion === "cancellation"
            ? yield* Fiber.interrupt(call).pipe(Effect.forkChild)
            : undefined;
        if (completion === "deadline") yield* TestClock.adjust("10 seconds");
        const signal = yield* Deferred.await(started);
        yield* TestClock.adjust("0 seconds");
        const result = (cancellation ?? call).pollUnsafe();
        yield* TestClock.adjust("1 second");
        const abortedBeforeDeadline = signal?.aborted;
        yield* TestClock.adjust("1 second");
        const aborted = signal?.aborted;
        releaseDelete(new Response(null, { status: 204 }));
        yield* Fiber.await(call);
        if (cancellation !== undefined) yield* Fiber.join(cancellation);
        expect(result?._tag).toBe("Success");
        if (completion === "result") {
          expect(result).toMatchObject({ value: { _tag: "Some", value: { content: [] } } });
        } else if (completion === "deadline") {
          expect(result).toMatchObject({ value: { _tag: "None" } });
        }
        expect(abortedBeforeDeadline).toBe(false);
        expect(aborted).toBe(true);
      }),
  );

  it.effect("aborts the pending fetch when the stdio bridge is interrupted", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<AbortSignal | undefined>();
      const input = new NodeStream.PassThrough();
      const fiber = yield* runAcpMcpStdioBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        input,
        output: { write: () => undefined },
        fetchImplementation: pendingFetch(started),
      }).pipe(Effect.forkChild);

      input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
      const signal = yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(signal?.aborted).toBe(true);
    }),
  );
});
