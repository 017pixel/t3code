// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  OrchestrationWorkflowFileError,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterAll, assert } from "vite-plus/test";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import { readWorkflowScript } from "./workflowScriptQuery.ts";
import * as Settings from "../serverSettings.ts";
import * as Layer from "effect/Layer";

const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-script-"));
const home = NodePath.join(sandbox, "home");
const root = NodePath.join(home, ".claude", "projects", "test");
NodeFS.mkdirSync(root, { recursive: true });
const scriptPath = NodePath.join(root, "run.js");
NodeFS.writeFileSync(scriptPath, "export const meta = {};\n");
const outside = NodePath.join(sandbox, "outside.js");
NodeFS.writeFileSync(outside, "evil\n");
const link = NodePath.join(root, "sneaky.js");
if (symlinksSupported) {
  NodeFS.rmSync(link, { force: true });
  NodeFS.symlinkSync(outside, link);
  if (!NodeFS.lstatSync(link).isSymbolicLink()) {
    throw new Error("test setup: sneaky.js must be a symlink");
  }
}

afterAll(() => {
  NodeFS.rmSync(sandbox, { recursive: true, force: true });
});

const customHome = NodePath.join(sandbox, "custom");
const envHome = NodePath.join(sandbox, "environment");
const customScript = NodePath.join(customHome, "projects", "test", "run.js");
const envScript = NodePath.join(envHome, "projects", "test", "run.js");
NodeFS.mkdirSync(NodePath.dirname(customScript), { recursive: true });
NodeFS.mkdirSync(NodePath.dirname(envScript), { recursive: true });
NodeFS.writeFileSync(customScript, "custom home");
NodeFS.writeFileSync(envScript, "environment home");
const customLink = NodePath.join(NodePath.dirname(customScript), "escape.js");
if (symlinksSupported) NodeFS.symlinkSync(outside, customLink);

effectIt.layer(
  Settings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("claude-missing")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: NodePath.join(sandbox, "missing") },
      },
      [ProviderInstanceId.make("claude-custom")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { homePath: customHome },
      },
      [ProviderInstanceId.make("claude-env")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: envHome }],
      },
    },
  }).pipe(Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, home))),
)("workflow script containment", (effectIt) => {
  effectIt.effect("reads configured Claude homes while rejecting escapes", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* readWorkflowScript({ scriptPath: customScript })).contents,
        "custom home",
      );
      assert.equal(
        (yield* readWorkflowScript({ scriptPath: envScript })).contents,
        "environment home",
      );
      const escaped = yield* readWorkflowScript({ scriptPath: outside }).pipe(Effect.flip);
      assert.equal(escaped.reason, "outside-root");
      if (symlinksSupported) {
        const linked = yield* readWorkflowScript({ scriptPath: customLink }).pipe(Effect.flip);
        assert.equal(linked.reason, "outside-root");
      }
    }),
  );

  effectIt.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "rejects a FIFO without waiting for a writer",
    () =>
      Effect.gen(function* () {
        const fifo = NodePath.join(root, "pipe.js");
        NodeChildProcess.execFileSync("mkfifo", [fifo]);
        const error = yield* Effect.flip(readWorkflowScript({ scriptPath: fifo }));
        assert.equal(error.reason, "not-regular-file");
      }),
  );

  effectIt.effect("serves a real script under the projects root", () =>
    Effect.gen(function* () {
      const result = yield* readWorkflowScript({ scriptPath });
      assert.include(result.contents, "export const meta");
      assert.equal(result.truncated, false);
    }),
  );

  effectIt.effect("rejects relative and non-js paths", () =>
    Effect.gen(function* () {
      const relative = yield* Effect.exit(readWorkflowScript({ scriptPath: "run.js" }));
      assert.equal(relative._tag, "Failure");
      const nonJs = yield* Effect.exit(
        readWorkflowScript({ scriptPath: scriptPath.replace(".js", ".ts") }),
      );
      assert.equal(nonJs._tag, "Failure");
      const error = yield* Effect.flip(readWorkflowScript({ scriptPath: "run.js" }));
      assert.equal(error._tag, "OrchestrationGetWorkflowScriptError");
      assert.equal(error.scriptPath, "run.js");
      assert.equal(error.reason, "invalid-path");
      assert.equal(error.message, "Workflow scripts must be absolute .js paths.");
      assert.instanceOf(error.cause, OrchestrationWorkflowFileError);
    }),
  );

  effectIt.effect.skipIf(!symlinksSupported)(
    "rejects paths outside the root and symlink escapes",
    () =>
      Effect.gen(function* () {
        const escaped = yield* Effect.exit(readWorkflowScript({ scriptPath: outside }));
        assert.equal(escaped._tag, "Failure");
        const sneaky = yield* Effect.exit(
          readWorkflowScript({ scriptPath: link }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        );
        assert.equal(sneaky._tag, "Success");
        if (sneaky._tag === "Success") {
          assert.equal(sneaky.value, "outside-root");
        }
      }),
  );
});
