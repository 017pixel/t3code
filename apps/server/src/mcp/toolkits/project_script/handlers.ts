import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ProjectScript from "../../ProjectScriptMcpService.ts";
import { ProjectScriptToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProjectScriptToolkit, {
  t3_project_script_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const scripts = yield* ProjectScript.ProjectScriptMcpService;
      return yield* scripts.list(scope, input);
    }),
  ),
  t3_project_script_run: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const scripts = yield* ProjectScript.ProjectScriptMcpService;
      return yield* scripts.run(scope, input);
    }),
  ),
  t3_project_script_stop: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const scripts = yield* ProjectScript.ProjectScriptMcpService;
      return yield* scripts.stop(scope, input);
    }),
  ),
});
