// @effect-diagnostics-next-line nodeBuiltinImport:off -- the member fixture is a plain Node server.
import * as NodeHttp from "node:http";

import { EnvironmentId, type MeshRoute } from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

import * as MeshMcpClient from "./MeshMcpClient.ts";
import * as MeshServices from "./Services.ts";
import * as MeshTestkit from "./testkit.ts";

const MEMBER = EnvironmentId.make("env-member");

it.effect.each([
  { stage: "initialize", contentType: "application/json", tool: "t3_thread_read", deadline: 15 },
  {
    stage: "notifications/initialized",
    contentType: "application/json",
    tool: "t3_thread_read",
    deadline: 15,
  },
  { stage: "tools/call", contentType: "application/json", tool: "t3_thread_launch", deadline: 15 },
  { stage: "tools/call", contentType: "text/event-stream", tool: "t3_thread_read", deadline: 15 },
  { stage: "tools/call", contentType: "application/json", tool: "t3_thread_wait", deadline: 60 },
  // Cloning answers only when it ends, within its own 120 s budget.
  { stage: "tools/call", contentType: "application/json", tool: "t3_project_clone", deadline: 130 },
])("aborts a stalled $stage $contentType body for $tool at its deadline", (test) =>
  Effect.gen(function* () {
    const reading = yield* Deferred.make<AbortSignal | undefined>();
    const forgotten = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    yield* Effect.addFinalizer(() => Effect.sync(() => controller?.error("test ended")));
    using fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init?.body)) as { id?: string; method: string };
      if (message.method === test.stage) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              init?.signal?.addEventListener("abort", () => value.error("aborted"));
              value.enqueue(
                new TextEncoder().encode(
                  test.contentType === "application/json" ? '{"jsonrpc":' : 'data: {"jsonrpc":',
                ),
              );
            },
            pull() {
              Deferred.doneUnsafe(reading, Effect.succeed(init?.signal ?? undefined));
            },
          }),
          { headers: { "content-type": test.contentType } },
        );
      }
      return message.id === undefined
        ? new Response(null, { status: 202 })
        : Response.json(
            { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } },
            { headers: { "mcp-session-id": "deadline-session" } },
          );
    });
    const mcp = yield* MeshServices.MeshMcpClient.pipe(
      Effect.provide(
        MeshMcpClient.layer.pipe(
          Layer.provide(
            MeshTestkit.layerCredentials({
              forgetRoute: (environmentId) =>
                Ref.update(forgotten, (ids) => [...ids, environmentId]),
            }),
          ),
        ),
      ),
    );
    const call = yield* mcp
      .callTool(
        MEMBER,
        test.tool,
        { timeoutMs: 50_000 },
        {
          modeLimit: { runtimeMode: "full-access", interactionMode: "default" },
          requestKey: "stable-launch-key",
        },
      )
      .pipe(Effect.result, Effect.forkChild);

    const signal = yield* Deferred.await(reading);
    yield* TestClock.adjust(`${test.deadline - 1} seconds`);
    assert.isUndefined(call.pollUnsafe());
    assert.isFalse(signal?.aborted);
    yield* TestClock.adjust("1 second");
    const completed = call.pollUnsafe();
    yield* Fiber.interrupt(call);

    assert.isDefined(completed);
    expect(completed).toMatchObject({
      _tag: "Success",
      value: { _tag: "Failure", failure: { _tag: "MeshMemberUnreachableError" } },
    });
    assert.isTrue(signal?.aborted);
    assert.deepStrictEqual(yield* Ref.get(forgotten), [MEMBER]);
    if (test.tool === "t3_thread_launch") {
      const toolRequests = fetch.mock.calls
        .filter(([, init]) => init?.method === "POST")
        .map(([, init]) => JSON.parse(String(init?.body)))
        .filter((message) => message.method === "tools/call");
      assert.strictEqual(toolRequests.length, 1);
      assert.strictEqual(toolRequests[0].params.arguments.clientRequestId, "stable-launch-key");
    }
  }),
);

it.effect("drops the route when the retry after a refused session cannot reach the member", () =>
  Effect.gen(function* () {
    const refusing = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((_request, response) => {
          response.writeHead(401);
          response.end();
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.sync(() => {
          server.closeAllConnections();
          server.close();
        }),
    );
    const address = refusing.address();
    if (address === null || typeof address === "string") return yield* Effect.die("no port");
    // The member revoked the first session; the next one is redeemed on a route that then dies.
    const routes: ReadonlyArray<MeshRoute> = [
      { kind: "lan", httpBaseUrl: `http://127.0.0.1:${address.port}/` },
      { kind: "lan", httpBaseUrl: "http://127.0.0.1:9/" },
    ];
    const redeemed = yield* Ref.make(0);
    const forgotten = yield* Ref.make<ReadonlyArray<EnvironmentId>>([]);
    const credentials = MeshTestkit.layerCredentials({
      session: (environmentId) =>
        Ref.get(redeemed).pipe(
          Effect.map((count) => MeshTestkit.testSession(environmentId, routes[count]!)),
        ),
      invalidate: () => Ref.update(redeemed, (count) => count + 1),
      forgetRoute: (environmentId) => Ref.update(forgotten, (ids) => [...ids, environmentId]),
    });
    const mcp = yield* MeshServices.MeshMcpClient.pipe(
      Effect.provide(MeshMcpClient.layer.pipe(Layer.provide(credentials))),
    );

    const failed = yield* mcp
      .callTool(
        MEMBER,
        "t3_thread_read",
        {},
        { modeLimit: { runtimeMode: "full-access", interactionMode: "default" } },
      )
      .pipe(Effect.match({ onFailure: (error) => error._tag, onSuccess: () => "answered" }));
    assert.strictEqual(failed, "MeshMemberUnreachableError");
    assert.strictEqual(yield* Ref.get(redeemed), 1);
    assert.deepStrictEqual(yield* Ref.get(forgotten), [MEMBER]);
  }),
);

it.effect("keeps the launch retry key when renewing a refused MCP session", () =>
  Effect.gen(function* () {
    const keys: Array<unknown> = [];
    const renewals = yield* Ref.make(0);
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      const message = JSON.parse(String(init?.body)) as {
        id?: string;
        method: string;
        params?: { arguments: { clientRequestId?: string } };
      };
      if (message.method === "tools/call") {
        keys.push(message.params?.arguments.clientRequestId);
        if (keys.length === 1) return new Response(null, { status: 401 });
      }
      return message.id === undefined
        ? new Response(null, { status: 202 })
        : Response.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              result:
                message.method === "initialize"
                  ? { protocolVersion: "2025-06-18" }
                  : { structuredContent: { threadId: "remote-thread" } },
            },
            { headers: { "mcp-session-id": "renewed-session" } },
          );
    });
    const mcp = yield* MeshServices.MeshMcpClient.pipe(
      Effect.provide(
        MeshMcpClient.layer.pipe(
          Layer.provide(
            MeshTestkit.layerCredentials({ invalidate: () => Ref.update(renewals, (n) => n + 1) }),
          ),
        ),
      ),
    );

    const result = yield* mcp.callTool(
      MEMBER,
      "t3_thread_launch",
      {},
      {
        modeLimit: { runtimeMode: "full-access", interactionMode: "default" },
        requestKey: "stable-launch-key",
      },
    );

    assert.deepStrictEqual(result, { threadId: "remote-thread" });
    assert.deepStrictEqual(keys, ["stable-launch-key", "stable-launch-key"]);
    assert.strictEqual(yield* Ref.get(renewals), 1);
  }),
);
