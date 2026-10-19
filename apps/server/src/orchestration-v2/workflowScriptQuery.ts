import {
  ClaudeSettings,
  OrchestrationGetWorkflowScriptError,
  OrchestrationWorkflowFileError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Settings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { readContainedWorkflowFile } from "./workflowFileRead.ts";

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

export const readWorkflowScript = Effect.fn("orchestration.readWorkflowScript")(function* (input: {
  readonly scriptPath: string;
}) {
  const settings = yield* Settings.ServerSettingsService;
  const environment = yield* HostProcess.Environment;
  const roots = yield* Effect.gen(function* () {
    const instances = deriveProviderInstanceConfigMap(yield* settings.getSettings);
    const roots: string[] = [];
    for (const instance of Object.values(instances)) {
      if (instance.driver !== "claudeAgent") continue;
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      const env = yield* mergeProviderInstanceEnvironment(instance.environment, environment);
      roots.push(yield* resolveClaudeHomePath(config.value, env));
    }
    return roots;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationGetWorkflowScriptError({
          reason: "read-failed",
          scriptPath: input.scriptPath,
          cause,
        }),
    ),
  );
  let unavailable: OrchestrationWorkflowFileError | undefined;
  const file = yield* Effect.gen(function* () {
    for (const configDir of new Set(roots)) {
      const result = yield* readContainedWorkflowFile({
        path: input.scriptPath,
        extension: ".js",
        byteCap: 256 * 1024,
        configDir,
      }).pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      if (
        result.failure.reason !== "outside-root" &&
        result.failure.reason !== "root-unavailable"
      ) {
        return yield* result.failure;
      }
      if (unavailable?.reason !== "outside-root") unavailable = result.failure;
    }
    return yield* (
      unavailable ??
        new OrchestrationWorkflowFileError({
          reason: "root-unavailable",
          path: input.scriptPath,
        })
    );
  }).pipe(
    Effect.mapError(
      (error) =>
        new OrchestrationGetWorkflowScriptError({
          reason: error.reason === "wrong-extension" ? "not-js" : error.reason,
          scriptPath: error.path,
          cause: error,
        }),
    ),
  );
  return { scriptPath: file.path, contents: file.contents, truncated: file.truncated };
});
