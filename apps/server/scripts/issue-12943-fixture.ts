// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off - Manual fixture driver for an already running isolated server.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
  ProviderDriverKind,
  WsRpcGroup,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    origin: { type: "string" },
    "gate-dir": { type: "string" },
    thread: { type: "string" },
    project: { type: "string" },
    action: { type: "string", default: "dispatch" },
    "isolated-server": { type: "boolean", default: false },
  },
});
if (
  !values.origin ||
  !values["gate-dir"] ||
  !values["isolated-server"] ||
  !["configure", "seed", "dispatch"].includes(values.action)
) {
  throw new Error(
    "Required: --origin <isolated origin> --gate-dir <fresh absolute directory> --isolated-server --action configure|seed|dispatch [--thread <empty fixture thread>]",
  );
}
const token = process.env.T3_FIXTURE_ACCESS_TOKEN;
if (!token) throw new Error("Set T3_FIXTURE_ACCESS_TOKEN privately; it is never printed");
const origin = new URL(values.origin).origin;
const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  },
});
if (!ticketResponse.ok) throw new Error(`WebSocket ticket failed: ${ticketResponse.status}`);
const { ticket } = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
  await ticketResponse.json(),
);
const layerSocket = Socket.layerWebSocket(
  `${origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket)}`,
).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
const layerProtocol = RpcClient.layerProtocolSocket().pipe(
  Layer.provide(layerSocket),
  Layer.provide(RpcSerialization.layerJson),
);
const instanceId = ProviderInstanceId.make("selectionFixture");
const gateDir = NodePath.resolve(values["gate-dir"]);
const proxyPath = NodePath.resolve(
  import.meta.dirname,
  "../../../scripts/fixtures/issue-12943/gated-acp.mjs",
);
const program = Effect.gen(function* () {
  const client = yield* RpcClient.make(WsRpcGroup);
  if (values.action === "configure") {
    yield* client["server.updateSettings"]({
      patch: {},
      providerInstanceMutation: {
        operation: "create",
        instanceId,
        instance: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Selection fixture",
          enabled: true,
          config: {
            source: "local",
            commandPath: process.execPath,
            commandArgs: [proxyPath, gateDir],
            customModels: ["default"],
          },
        },
      },
    });
    yield* Effect.log(
      "Configured selectionFixture. Create a new empty thread titled Selection fixture, then dispatch.",
    );
    return;
  }
  if (values.action === "seed") {
    if (!values.project) throw new Error("--project is required for seed");
    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    yield* client["orchestration.dispatchCommand"]({
      type: "thread.create",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      projectId: ProjectId.make(values.project),
      title: "Selection fixture",
      createdBy: "user",
      creationSource: "web",
      modelSelection: { instanceId, model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* Effect.log(`Fixture thread: ${threadId}`);
    return;
  }
  if (!values.thread) throw new Error("--thread is required for dispatch");
  const threadId = ThreadId.make(values.thread);
  const projection = yield* client["orchestration.getThreadProjection"]({ threadId });
  // Refuse existing conversations even when the operator selects the wrong thread ID.
  if (
    !projection.thread.title.startsWith("Selection fixture") ||
    projection.messages.length !== 0 ||
    projection.runs.length !== 0
  ) {
    throw new Error("Dispatch requires a new empty thread titled Selection fixture");
  }
  yield* client["orchestration.dispatchCommand"]({
    type: "message.dispatch",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId,
    messageId: MessageId.make(NodeCrypto.randomUUID()),
    createdBy: "user",
    creationSource: "web",
    text: "Synthetic selection evidence: append, grow, then complete the same assistant message.",
    attachments: [],
    modelSelection: { instanceId, model: "default" },
    dispatchMode: { type: "start_immediately" },
  });
  yield* Effect.log(
    "Dispatched synthetic fixture. Await chunk-buffered and response-buffered in the gate directory.",
  );
}).pipe(Effect.scoped, Effect.provide(layerProtocol));
await Effect.runPromise(program);
