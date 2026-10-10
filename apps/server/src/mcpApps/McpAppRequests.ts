import type {
  McpAppCallToolInput,
  McpAppCallToolResult,
  McpAppToolInfoInput,
  McpAppToolInfo,
  McpAppReadResourceInput,
  McpAppReadResourceResult,
  McpAppUpdateModelContextInput,
  McpAppRequestError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";

export class McpAppRequests extends Context.Service<
  McpAppRequests,
  {
    readonly callTool: (
      input: McpAppCallToolInput,
    ) => Effect.Effect<McpAppCallToolResult, McpAppRequestError>;
    readonly toolInfo: (
      input: McpAppToolInfoInput,
    ) => Effect.Effect<McpAppToolInfo, McpAppRequestError>;
    readonly readResource: (
      input: McpAppReadResourceInput,
    ) => Effect.Effect<McpAppReadResourceResult, McpAppRequestError>;
    readonly updateModelContext: (
      input: McpAppUpdateModelContextInput,
    ) => Effect.Effect<void, McpAppRequestError>;
  }
>()("t3/mcpApps/McpAppRequests") {}

const make = Effect.gen(function* () {
  const service = yield* cacheInOwnerScope(
    Effect.promise(() => import("./McpAppRequestsLive.ts")).pipe(
      Effect.flatMap((live) => live.make),
    ),
  );
  return McpAppRequests.of({
    callTool: (input) => service.pipe(Effect.flatMap((value) => value.callTool(input))),
    toolInfo: (input) => service.pipe(Effect.flatMap((value) => value.toolInfo(input))),
    readResource: (input) => service.pipe(Effect.flatMap((value) => value.readResource(input))),
    updateModelContext: (input) =>
      service.pipe(Effect.flatMap((value) => value.updateModelContext(input))),
  });
});
export const layer = Layer.effect(McpAppRequests, make);
