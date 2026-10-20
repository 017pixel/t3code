import {
  OrchestratorMcpFailure,
  ProjectScriptMcpFailure,
  ProjectScriptMcpListInput,
  ProjectScriptMcpListResult,
  ProjectScriptMcpRunInput,
  ProjectScriptMcpRunResult,
  ProjectScriptMcpStopInput,
  ProjectScriptMcpStopResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { ProjectScriptMcpService } from "../../ProjectScriptMcpService.ts";

const dependencies = [
  McpInvocationContext,
  ProjectScriptMcpService,
  ThreadManagement.ThreadManagementService,
];
const ToolFailure = Schema.Union([ProjectScriptMcpFailure, OrchestratorMcpFailure]);

const ProjectScriptListTool = Tool.make("t3_project_script_list", {
  description:
    "List a bounded page of saved scripts for the target thread's current project. Omit threadId for the calling thread. Commands are bounded previews with explicit truncation; this read does not open a terminal or run a script.",
  parameters: ProjectScriptMcpListInput,
  success: ProjectScriptMcpListResult,
  failure: ToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List saved project scripts")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ProjectScriptRunTool = Tool.make("t3_project_script_run", {
  description:
    "Run one saved project script by scriptId in a new dedicated managed terminal using the explicit terminalId. Loaded, persisted, and previously closed terminal identifiers are rejected atomically. Arbitrary command text, cwd, environment, and preview launch are not accepted. Success means the PTY accepted the saved command, not that the command succeeded. The operation is non-idempotent and requires the caller and target thread to use full-access runtime mode and default interaction mode.",
  parameters: ProjectScriptMcpRunInput,
  success: ProjectScriptMcpRunResult,
  failure: ToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Run a saved project script")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const ProjectScriptStopTool = Tool.make("t3_project_script_stop", {
  description:
    "Stop one dedicated script run using its saved scriptId and the terminalId returned by t3_project_script_run. This never searches for or kills a process by name and cannot stop an unrelated terminal. Both calling and target threads must use full-access runtime mode and default interaction mode.",
  parameters: ProjectScriptMcpStopInput,
  success: ProjectScriptMcpStopResult,
  failure: ToolFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a saved project script")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const ProjectScriptToolkit = Toolkit.make(
  ProjectScriptListTool,
  ProjectScriptRunTool,
  ProjectScriptStopTool,
);
