import { WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Each pong is a frame, so an idle but working socket shows a received
// frame inside every quick connection probe window. A server busy for a few
// seconds stops answering pings, so allow 15 seconds without any frame before
// dropping the socket.
export const PING_INTERVAL = "3 seconds";
export const PING_TIMEOUT = "15 seconds";
