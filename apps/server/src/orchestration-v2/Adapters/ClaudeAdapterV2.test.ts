// @effect-diagnostics nodeBuiltinImport:off -- the fake Claude CLI uses Node streams
import * as NodeEvents from "node:events";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { beforeEach, vi } from "vite-plus/test";

import type {
  Query as ClaudeQuery,
  SDKMessage,
  SDKUserMessage,
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  CheckpointId,
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  type ProviderInstanceEnvironment,
  type ProviderApprovalDecision,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";
import { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import { ClaudeExecutableFileCheck } from "../../provider/Drivers/ClaudeExecutable.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  WAKE_NATIVE_SESSION,
  makeAssistantTextFrame,
  makeAssistantErrorFrame,
  makeResultFrame,
  makeWakeHarnessWithOptions,
} from "./ClaudeAdapterV2.unit.testkit.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof ClaudeSdk>()),
  resolveSettings: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(ClaudeSdk.resolveSettings).mockReset().mockResolvedValue({
    effective: {},
    provenance: {},
    sources: [],
  });
});

const AUTO_COMPACT_CLAUDE_SETTINGS = Schema.decodeSync(ClaudeSettings)({
  autoCompactWindow: "300000",
});

describe("ClaudeAdapterV2 runtime query policy", () => {
  it.each([
    ["--permission-mode acceptEdits", "acceptEdits"],
    ["--dangerously-skip-permissions", "bypassPermissions"],
    ["--dangerously-skip-permissions --permission-mode plan", "plan"],
  ])("folds %s into the SDK permission mode", (launchArgs, expected) => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      nativeThreadId: "native-permission-override",
      resume: false,
      cwd: "/workspace",
      permissionMode: "default",
      settings: { ...AUTO_COMPACT_CLAUDE_SETTINGS, launchArgs },
    });
    assert.equal(options.permissionMode, expected);
    assert.isUndefined(options.extraArgs?.["permission-mode"]);
    assert.isUndefined(options.extraArgs?.["dangerously-skip-permissions"]);
  });

  it("projects AskUserQuestion input with question text as the answer key", () => {
    const preview = "\n  **Proposed change**\n\n```ts\n\tconst enabled = true;\n```\n  ";
    assert.deepEqual(
      ClaudeAdapterV2.claudeUserInputQuestions({
        questions: [
          {
            header: "Approach",
            question: "Which approach?",
            options: [
              { label: "Simple", description: "Use fewer moving parts", preview },
              { label: "Safe", description: "Keep the current setup" },
            ],
            multiSelect: true,
          },
        ],
      }),
      [
        {
          id: "Which approach?",
          header: "Approach",
          question: "Which approach?",
          options: [
            { label: "Simple", description: "Use fewer moving parts", preview },
            { label: "Safe", description: "Keep the current setup" },
          ],
          multiSelect: true,
        },
      ],
    );
    const sdkAnswers: NonNullable<AskUserQuestionInput["answers"]> =
      ClaudeAdapterV2.claudeSdkUserInputAnswers({
        "Which approach?": ["Simple", "Safe"],
        "Deploy now?": "Yes",
      });
    assert.deepEqual(sdkAnswers, {
      "Which approach?": "Simple, Safe",
      "Deploy now?": "Yes",
    });
    assert.isTrue(
      ClaudeAdapterV2.ClaudeProviderCapabilitiesV2.planning.supportsStructuredQuestions,
    );
  });

  it("maps canonical read-only never policy to Claude dontAsk with read-only tools", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: { type: "fullAccess" },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      allowedTools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("does not auto-allow reads for canonical restricted read-only never policy", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
        approvalPolicy: "never",
        sandboxPolicy: {
          type: "readOnly",
          access: {
            type: "restricted",
            includePlatformDefaults: false,
            readableRoots: [],
          },
          networkAccess: false,
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "dontAsk",
      tools: ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
      installPermissionCallback: false,
    });
  });

  it("maps default full-access policy to Claude bypass permissions", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      installPermissionCallback: false,
    });
  });

  it("keeps approval checks when Full access must fall back to an allowed Claude mode", () => {
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
      approvalPolicy: "never",
    });

    assert.deepEqual(
      ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy, {
        bypassDisabled: true,
        autoDisabled: false,
      }),
      { permissionMode: "auto", installPermissionCallback: true },
    );
    assert.deepEqual(
      ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(runtimePolicy, {
        bypassDisabled: true,
        autoDisabled: true,
      }),
      { permissionMode: "default", installPermissionCallback: true },
    );
  });

  it("keeps approval-required mode interactive with danger-full-access sandboxing", () => {
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      }),
    );

    assert.deepEqual(queryPolicy, {
      permissionMode: "default",
      installPermissionCallback: true,
    });
  });
});

describe("ClaudeAdapterV2 MCP query overrides", () => {
  const T3_MCP_SERVERS = {
    "t3-code": {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;

  const mcpSessionFor = (
    threadId: ThreadId,
    authorizationHeader = "Bearer secret-claude-token",
  ): McpProviderSession.McpProviderSessionConfig => ({
    environmentId: EnvironmentId.make(`environment-${threadId}`),
    threadId,
    providerSessionId: `mcp-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:43123/mcp",
    authorizationHeader,
    browserToolsAvailable: true,
  });

  it("pre-approves only read-only t3-code tools in a read-only sandbox", () => {
    const threadId = ThreadId.make("thread-claude-mcp-read-only");
    const mcpSession = mcpSessionFor(threadId);
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: true,
      allowedTools: [...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS],
    });

    assert.deepEqual(overrides, {
      allowedTools: [
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_ALLOWED_TOOLS,
        ...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS,
      ],
      mcpServers: T3_MCP_SERVERS,
    });
    assert.isFalse(overrides.allowedTools?.includes(ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD));
  });

  it("invalidates live-query reuse when MCP credentials rotate", () => {
    const threadId = ThreadId.make("thread-claude-mcp-credential-rotation");
    const mcpSession = mcpSessionFor(threadId);
    const queryPolicy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );
    const initialKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession, readOnlySandbox: false }),
    );

    const rotatedKey = ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
      queryPolicy,
      ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession: mcpSessionFor(threadId, "Bearer rotated-claude-token"),
        readOnlySandbox: false,
      }),
    );
    assert.notEqual(rotatedKey, initialKey);
  });

  it("matches the read-only allowlist to the orchestrator toolkit annotations", () => {
    const readOnlyToolNames = [
      ...Object.values(OrchestratorToolkit.tools),
      ...Object.values(ThreadToolkit.tools),
      ...Object.values(WorktreeToolkit.tools),
      ...Object.values(ProjectToolkit.tools),
      ...Object.values(EnvironmentToolkit.tools),
      ...Object.values(PreviewControlsToolkit.tools),
      ...Object.values(HtmlToolkit.tools),
    ]
      .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
      .map((tool) => `mcp__t3-code__${tool.name}`)
      .sort();

    assert.deepEqual(
      [...ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS].sort(),
      readOnlyToolNames,
    );
  });
});

describe("ClaudeAdapterV2 native protocol logging", () => {
  it("injects thread-scoped MCP configuration without logging the credential", () => {
    const threadId = ThreadId.make("thread-claude-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-claude-mcp"),
      threadId,
      providerSessionId: "mcp-session-claude",
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-claude-token",
      browserToolsAvailable: true,
    };

    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession,
      readOnlySandbox: false,
      allowedTools: ["Read"],
    });
    assert.deepEqual(overrides, {
      allowedTools: ["Read", "mcp__t3-code__*"],
      mcpServers: {
        "t3-code": {
          type: "http",
          url: "http://127.0.0.1:43123/mcp",
          headers: {
            Authorization: "Bearer secret-claude-token",
          },
          timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
        },
      },
    });

    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      nativeThreadId: "native-thread-claude-mcp",
      resume: false,
      cwd: "/workspace",
      allowedTools: overrides.allowedTools ?? [],
      mcpServers: overrides.mcpServers ?? {},
      environment: {},
    });
    assert.isObject(options.systemPrompt);
    const systemPrompt = options.systemPrompt as {
      readonly type: string;
      readonly preset: string;
      readonly append?: string;
    };
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.include(systemPrompt.append ?? "", "Use `delegate_task`");
    const logged = ClaudeAdapterV2.loggedClaudeQueryOptions(options);
    assert.equal(logged.hasMcpServers, true);
    assert.notInclude(JSON.stringify(logged), "secret-claude-token");
  });
});

describe("ClaudeAdapterV2 context usage", () => {
  it("dates cache expiry from the request start, not the response end", () => {
    const usage = ClaudeAdapterV2.claudeProviderTurnTokenUsage(
      {
        input_tokens: 1,
        output_tokens: 1,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 300 },
      },
      CLAUDE_TEST_MODEL_SELECTION,
      "2026-08-29T00:03:00.000Z",
      "",
      DateTime.makeUnsafe("2026-08-29T00:00:00.000Z"),
    );
    assert.strictEqual(usage.promptCacheExpiresAt, "2026-08-29T00:05:00.000Z");
  });
});

describe("ClaudeAdapterV2 session permissions", () => {
  // regression: #15892 an explicit user refusal must stay user_reject, not a tool failure
  it("keeps explicit user refusals classified as user_reject", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "decline",
      toolInput: { command: "make" },
      toolUseID: "denied-build",
    });
    assert.equal(result.behavior, "deny");
    if (result.behavior !== "deny") return;
    assert.equal(result.decisionClassification, "user_reject");
    assert.equal(result.message, "User declined tool execution.");
    assert.equal(result.interrupt, undefined);
  });

  it("forces suggested permission updates to session scope", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "Bash",
      decision: "acceptForSession",
      toolInput: { command: "git status" },
      toolUseID: "tool-1",
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "git status" }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "git status" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });

  it("adds a whole-tool session rule when Claude offers no suggestion", () => {
    const result = ClaudeAdapterV2.permissionResultFromDecision({
      toolName: "mcp__t3__custom_tool",
      decision: "acceptForSession",
      toolInput: {},
      toolUseID: "tool-2",
    });

    assert.equal(result.behavior, "allow");
    if (result.behavior !== "allow") {
      return;
    }
    assert.deepEqual(result.updatedPermissions, [
      {
        type: "addRules",
        rules: [{ toolName: "mcp__t3__custom_tool" }],
        behavior: "allow",
        destination: "session",
      },
    ]);
  });
});

describe("ClaudeAdapterV2 Auto-accept edits", () => {
  it.effect("asks before a command instead of allowing it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-accept-edits-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-accept-edits"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const threadId = ThreadId.make("thread-claude-accept-edits");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-accept-edits"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-accept-edits"),
            text: "Run node.",
            attachments: [],
            runtimePolicy,
          }),
        );
        assert.equal(openedOptions?.permissionMode, "acceptEdits");
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);

        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const command = { command: "node -e 'console.log(42)'" };
        const decision = yield* Effect.promise(() =>
          canUseTool!("Bash", command, {
            signal: new AbortController().signal,
            toolUseID: "tool-bash-accept-edits",
            requestId: "request-bash-accept-edits",
          }),
        ).pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Fiber.join(requestEvent).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(first.type, "request", "the command ran without asking");
        if (first.type !== "request") return;
        const event = first.event;
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        assert.equal(event.value.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 append-system-prompt-file launch argument", () => {
  const startTurnWithLaunchArgs = Effect.fnUntraced(function* (launchArgs: string, cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const opened: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOptions> = [];
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: { ...DEFAULT_CLAUDE_SETTINGS, launchArgs },
      environment: {},
      attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-" }),
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed("native-thread-claude-append-file"),
        open: (input) =>
          Effect.sync(() => {
            opened.push(input.options);
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd,
    });
    const threadId = ThreadId.make("thread-claude-append-file");
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("provider-session-claude-append-file"),
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CLAUDE_TEST_MODEL_SELECTION,
      runtimePolicy,
    });
    const exit = yield* runtime
      .startTurn(
        makeClaudeTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-claude-append-file"),
          text: "What is the sentinel?",
          attachments: [],
          runtimePolicy,
        }),
      )
      .pipe(Effect.exit);
    return { exit, opened };
  });

  const appendSystemPrompt = (options: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined) =>
    (options?.systemPrompt as { readonly append?: string } | undefined)?.append;

  it.effect("sends append launch arguments to Claude after the T3 instructions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-cwd-" });
        yield* fileSystem.writeFileString(NodePath.join(cwd, "rules.md"), "File sentinel\n");
        const plain = yield* startTurnWithLaunchArgs("", cwd);
        const { exit, opened } = yield* startTurnWithLaunchArgs(
          '--append-system-prompt "Inline sentinel" --append-system-prompt-file rules.md --system-prompt Replacement',
          cwd,
        );
        assert.isTrue(Exit.isSuccess(exit));
        assert.lengthOf(opened, 1);
        assert.equal(
          appendSystemPrompt(opened[0]),
          `${appendSystemPrompt(plain.opened[0])}\n\nFile sentinel\n\nInline sentinel`,
        );
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt"]);
        assert.isUndefined(opened[0]!.extraArgs?.["append-system-prompt-file"]);
        assert.equal(opened[0]!.extraArgs?.["system-prompt"], "Replacement");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );

  // regression: #20413 malformed append-system-prompt launch args fail before a query opens
  it.effect.each([
    [
      "--append-system-prompt-file missing.md",
      (cwd: string) =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptFileError({
          path: NodePath.join(cwd, "missing.md"),
        }).message,
    ],
    [
      "--append-system-prompt-file",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt-file=",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt-file",
        }).message,
    ],
    [
      "--append-system-prompt",
      () =>
        new ClaudeAdapterV2.ClaudeAppendSystemPromptMissingValueError({
          flag: "--append-system-prompt",
        }).message,
    ],
  ] as const)("fails the turn before opening Claude for %s", ([launchArgs, expectedMessage]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-append-cwd-" });
        const { exit, opened } = yield* startTurnWithLaunchArgs(launchArgs, cwd);
        assert.lengthOf(opened, 0);
        assert.isTrue(Exit.isFailure(exit));
        if (!Exit.isFailure(exit)) return;
        assert.equal(
          makeProviderFailure({ cause: exit.cause, class: "provider_error" }).message,
          expectedMessage(cwd),
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 approval cancellation", () => {
  it.effect("observes an approval signal that was already aborted", () =>
    Effect.gen(function* () {
      const decision = yield* Deferred.make<ProviderApprovalDecision>();
      const controller = new AbortController();
      controller.abort();

      const result = yield* ClaudeAdapterV2.awaitClaudeApprovalDecision(
        decision,
        controller.signal,
      );

      assert.equal(result, "cancel");
    }),
  );
});

const captureSdkExecutablePaths = Effect.fn("captureSdkExecutablePaths")(function* (
  binaryPath: string,
  environment: ProviderInstanceEnvironment = [],
) {
  const executablePaths: Array<string | undefined> = [];
  const taskToolEnvironment: Array<string | undefined> = [];
  const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
    {
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      displayName: undefined,
      environment,
      enabled: true,
      config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath },
    },
    {},
  ).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-claude-binary-path-",
      }),
    ),
    Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      allocateSessionId: Effect.succeed("native-thread-claude-binary-path"),
      open: (input) =>
        Effect.sync(() => {
          executablePaths.push(input.options.pathToClaudeCodeExecutable);
          taskToolEnvironment.push(input.options.env?.CLAUDE_CODE_ENABLE_TODO_TOOLS);
          return {
            messages: Stream.never,
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    }),
  );
  const threadId = ThreadId.make("thread-claude-binary-path");
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-claude-binary-path"),
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection: CLAUDE_TEST_MODEL_SELECTION,
    runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
  });
  yield* runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId,
      providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("attempt-claude-binary-path"),
      text: "hello",
      attachments: [],
    }),
  );
  return { executablePaths, taskToolEnvironment };
});

describe("ClaudeAdapterV2 executable path", () => {
  it.effect("follows a bare claude on Windows to the npm package executable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const npmDir = "C:\\Users\\dev\\AppData\\Roaming\\npm";
        const packageExe = `${npmDir}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
        const { executablePaths } = yield* captureSdkExecutablePaths("claude").pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => `${npmDir}\\claude.cmd`),
          Effect.provideService(ClaudeExecutableFileCheck, (filePath) => filePath === packageExe),
        );

        assert.deepEqual(executablePaths, [packageExe]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 resumeThread", () => {
  it.effect("fails for a transcript without messages so a fresh session replaces it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const configDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-empty-session-",
        });
        const projectDir = path.join(configDir, "projects", "-workspace");
        yield* fileSystem.makeDirectory(projectDir, { recursive: true });
        // What a CLI stopped before it saved the first prompt leaves behind.
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-empty.jsonl"),
          [
            `{"type":"last-prompt","lastPrompt":"hello","sessionId":"native-thread-empty"}`,
            `{"type":"atis-latch","atis":"","sessionId":"native-thread-empty"}`,
            `{"type":"cost-state","sessionId":"native-thread-empty","totalCostUSD":0}`,
            "",
          ].join("\n"),
        );
        yield* fileSystem.writeFileString(
          path.join(projectDir, "native-thread-saved.jsonl"),
          `{"type":"user","message":{"role":"user","content":"hello"},"sessionId":"native-thread-saved"}\n`,
        );
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: configDir },
          attachmentsDir: configDir,
          fileSystem,
          path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-empty"),
            open: () => Effect.die("unused"),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-empty-session");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-empty-session"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });

        const error = yield* Effect.flip(runtime.resumeThread({ providerThread }));
        assert.equal(error._tag, "ProviderAdapterResumeThreadError");

        const saved = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-saved",
              strength: "strong",
            },
          },
        });
        assert.equal(saved.nativeThreadRef?.nativeId, "native-thread-saved");

        const missing = yield* runtime.resumeThread({
          providerThread: {
            ...providerThread,
            nativeThreadRef: {
              driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
              nativeId: "native-thread-missing",
              strength: "strong",
            },
          },
        });
        assert.equal(missing.nativeThreadRef?.nativeId, "native-thread-missing");
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 resume compaction", () => {
  it.effect("resolves and cancels the SDK resume dialog through structured runtime input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-resume-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-resume"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-resume");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-resume"),
            text: "continue",
            attachments: [],
          }),
        );
        const callback = openedOptions?.onUserDialog;
        assert.isFunction(callback);
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);
        const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
        const questionRequestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const questionResult = yield* Effect.promise(() =>
          canUseTool!(
            "AskUserQuestion",
            {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
            },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-question-full-access",
              requestId: "request-question-full-access",
            },
          ),
        ).pipe(Effect.forkScoped);
        const questionEvent = yield* Fiber.join(questionRequestEvent);
        assert.isTrue(Option.isSome(questionEvent));
        if (
          Option.isNone(questionEvent) ||
          questionEvent.value.type !== "runtime_request.updated"
        ) {
          return;
        }
        yield* runtime.respondToRuntimeRequest({
          requestId: questionEvent.value.runtimeRequest.id,
          answers: { [longQuestion]: ["Production", "Staging"] },
        });
        assert.deepEqual(yield* Fiber.join(questionResult), {
          behavior: "allow",
          updatedInput: {
            questions: [
              {
                header: "Target",
                question: longQuestion,
                options: [
                  { label: "Production", description: "Deploy to production." },
                  { label: "Staging", description: "Deploy to staging." },
                ],
                multiSelect: true,
              },
            ],
            answers: { [longQuestion]: "Production, Staging" },
          },
          toolUseID: "tool-question-full-access",
        });
        const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
        const proposedPlanEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "plan.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const exitPlanResult = yield* Effect.promise(() =>
          canUseTool!(
            "ExitPlanMode",
            { plan: longPlan },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-exit-plan-full-access",
              requestId: "request-exit-plan-full-access",
            },
          ),
        );
        assert.deepEqual(exitPlanResult, {
          behavior: "deny",
          message:
            "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
          toolUseID: "tool-exit-plan-full-access",
        });
        const planEvent = yield* Fiber.join(proposedPlanEvent);
        assert.isTrue(Option.isSome(planEvent));
        if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
          assert.equal(planEvent.value.plan.kind, "proposed_plan");
          if (planEvent.value.plan.kind === "proposed_plan") {
            assert.equal(planEvent.value.plan.markdown, longPlan.trim());
          }
        }
        const requestEvent = yield* runtime.events
          .pipe(
            Stream.filter((event) => event.type === "runtime_request.updated"),
            Stream.runHead,
          )
          .pipe(Effect.forkScoped);
        const controller = new AbortController();
        const dialog = yield* Effect.promise(() =>
          callback!(
            {
              dialogKind: "resume_return",
              payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
            },
            { signal: controller.signal, requestId: "dialog-resume-1" },
          ),
        ).pipe(Effect.forkScoped);
        const event = yield* Fiber.join(requestEvent);
        assert.isTrue(Option.isSome(event));
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        const question = formatClaudeResumeCompactionQuestion({
          ageMinutes: 90,
          estimatedTokens: 120000,
        });
        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          answers: { [question]: "Compact and continue" },
        });
        assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

        const cancelledController = new AbortController();
        cancelledController.abort();
        assert.deepEqual(
          yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: cancelledController.signal, requestId: "dialog-resume-2" },
            ),
          ),
          { behavior: "cancelled" },
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 attachments", () => {
  it.effect.each([
    {
      name: "ordinary text",
      prompt: "What’s in this image?",
      expectedText: "Ultrathink:\nWhat’s in this image?",
      command: undefined,
      ultrathink: true,
    },
    {
      name: "mid-sentence skill",
      prompt: "please $implement fixes\n\nThen report the result",
      expectedText: "Ultrathink:\nplease /implement fixes\n\nThen report the result",
      command: "/implement fixes\n\nThen report the result",
      ultrathink: true,
    },
    {
      name: "prompt-leading skill",
      prompt: "$implement fixes",
      expectedText: "/implement fixes",
      command: undefined,
      ultrathink: false,
    },
  ])(
    "preserves $name with images and files on sends and steering",
    ({ prompt, expectedText, command, ultrathink }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const path = yield* Path.Path;
          const claudeHome = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-skills-home-",
          });
          yield* fileSystem.makeDirectory(path.join(claudeHome, "skills", "implement"), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(
            path.join(claudeHome, "skills", "implement", "SKILL.md"),
            "---\ndescription: Implement the requested change\n---\nImplement it.\n",
          );
          const modelSelection = {
            ...CLAUDE_TEST_MODEL_SELECTION,
            options: ultrathink ? CLAUDE_TEST_MODEL_SELECTION.options : [],
          };
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-v2-attachments-",
          });
          const offeredMessages: Array<SDKUserMessage> = [];
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: { ...DEFAULT_CLAUDE_SETTINGS, homePath: claudeHome },
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            crypto: yield* Crypto.Crypto,
            idAllocator,
            queryRunner: {
              allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
              open: () =>
                Effect.succeed({
                  messages: Stream.never,
                  offer: (message) =>
                    Effect.sync(() => {
                      offeredMessages.push(message);
                    }),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                }),
              forkSession: () => Effect.die("unused forkSession"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-attachments");
          const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const attachment = ChatImageAttachment.make({
            type: "image",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
            ),
            name: "diagram.png",
            mimeType: "image/png",
            sizeBytes: 4,
          });
          const document = ChatFileAttachment.make({
            type: "file",
            id: ChatAttachmentId.make(
              "thread-claude-attachments-abcdefab-1234-1234-1234-123456789abc",
            ),
            name: "requirements.pdf",
            mimeType: "application/pdf",
            sizeBytes: 4,
          });
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(attachment)!),
            Uint8Array.from([1, 2, 3, 4]),
          );
          yield* fileSystem.writeFile(
            path.join(attachmentsDir, attachmentRelativePath(document)!),
            Uint8Array.from([5, 6, 7, 8]),
          );
          const attemptId = RunAttemptId.make("attempt-claude-attachments");
          const now = yield* DateTime.now;

          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId,
              modelSelection,
              text: prompt,
              attachments: [attachment, document],
            }),
          );

          const expectedImageBlock = {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "AQIDBA==",
            },
          } as const;
          const expectedAttachmentPath = path.join(
            attachmentsDir,
            attachmentRelativePath(attachment)!,
          );
          const expectedDocumentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
          const attachmentNotes = `\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`;
          const requestBlock = { type: "text" as const, text: expectedText + attachmentNotes };
          const expectedContent = command
            ? [
                requestBlock,
                expectedImageBlock,
                { type: "text" as const, text: command + attachmentNotes },
              ]
            : [expectedImageBlock, requestBlock];
          assert.deepEqual(offeredMessages[0]?.message.content, expectedContent);

          const providerTurnId = idAllocator.derive.providerTurn({
            driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
            nativeTurnId: `turn:${attemptId}`,
          });
          yield* runtime.steerTurn({
            threadId,
            runId: RunId.make("run-claude-attachments"),
            providerThread,
            providerTurnId,
            message: {
              createdBy: "user",
              creationSource: "web",
              messageId: MessageId.make("message-claude-attachments-steer"),
              text: prompt,
              attachments: [attachment, document],
            },
          });

          assert.equal(offeredMessages[1]?.priority, "now");
          assert.deepEqual(offeredMessages[1]?.message.content, expectedContent);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
          ),
        ),
      ),
  );
});

describe("ClaudeAdapterV2 native fork", () => {
  it.effect("forks at the source assistant cursor and resumes the forked session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-fork-attachments-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const forkCalls: Array<ClaudeAdapterV2.ClaudeAgentSdkSessionForkInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("source-native-session"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: (input) =>
              Effect.sync(() => {
                forkCalls.push(input);
                return { sessionId: "forked-native-session" };
              }),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const providerSessionId = ProviderSessionId.make("provider-session-claude-fork");
        const sourceThreadId = ThreadId.make("thread-claude-fork-source");
        const targetThreadId = ThreadId.make("thread-claude-fork-target");
        const runtime = yield* adapter.openSession({
          threadId: sourceThreadId,
          providerSessionId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const sourceProviderThread = yield* runtime.ensureThread({
          threadId: sourceThreadId,
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
        const now = yield* DateTime.now;
        const providerTurnId = ProviderTurnId.make("provider-turn-claude-source");
        const forkedProviderThread = yield* runtime.forkThread({
          sourceProviderThread,
          sourceProviderTurns: [
            {
              id: providerTurnId,
              providerThreadId: sourceProviderThread.id,
              nodeId: NodeId.make("node-claude-source"),
              runAttemptId: RunAttemptId.make("run-attempt-claude-source"),
              nativeTurnRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "assistant-message-cursor",
                strength: "weak",
              },
              ordinal: 1,
              status: "completed",
              startedAt: now,
              completedAt: now,
            },
          ],
          providerTurnId,
          targetThreadId,
        });

        assert.deepEqual(forkCalls, [
          {
            sessionId: "source-native-session",
            options: {
              dir: "/workspace",
              upToMessageId: "assistant-message-cursor",
            },
            environment: { CLAUDE_CONFIG_DIR: "/custom/claude-home" },
            threadId: targetThreadId,
            providerSessionId,
          },
        ]);
        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, "forked-native-session");
        assert.equal(forkedProviderThread.forkedFrom?.providerThreadId, sourceProviderThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, providerTurnId);

        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: targetThreadId,
            projectId: ProjectId.make("project-claude-fork-target"),
            title: "Claude fork target",
            providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            modelSelection: {
              instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
              model: "claude-sonnet-4-6",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: forkedProviderThread.id,
            lineage: {
              parentThreadId: sourceThreadId,
              relationshipToParent: "fork",
              rootThreadId: sourceThreadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId: targetThreadId,
          runId: RunId.make("run-claude-fork-target"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt-claude-fork-target"),
          rootNodeId: NodeId.make("node-claude-fork-target-root"),
          providerThread: forkedProviderThread,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-fork-target"),
            text: "Respond with fork ok",
            attachments: [],
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
            model: "claude-sonnet-4-6",
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });

        assert.equal(openedQueries[0]?.options.resume, "forked-native-session");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    ),
  );
});

function makeFakeClaudeCli(answerSetServers = true) {
  const spawns: Array<SpawnOptions> = [];
  const controlRequests: Array<object> = [];
  const stdins: Array<NodeStream.PassThrough> = [];
  const spawn = (options: SpawnOptions): SpawnedProcess => {
    spawns.push(options);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    stdins.push(stdin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdin,
      stdout,
      killed: false,
      exitCode: null as number | null,
      kill: () => {
        stdout.end();
        child.emit("exit", null, "SIGTERM");
        return true;
      },
    });
    let pending = "";
    stdin.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        if (frame.type !== "control_request") continue;
        controlRequests.push(frame.request);
        const setServers = frame.request.subtype === "mcp_set_servers";
        if (setServers && !answerSetServers) continue;
        const response = {
          subtype: "success",
          request_id: frame.request_id,
          response: setServers ? { added: [], removed: [], errors: {} } : {},
        };
        stdout.write(`${JSON.stringify({ type: "control_response", response })}\n`);
      }
    });
    stdin.on("end", () => {
      stdout.end();
      child.emit("exit", 0, null);
    });
    return child;
  };
  // The SDK closes the CLI by ending its stdin.
  const closed = () => stdins.length > 0 && stdins.every((stdin) => stdin.writableEnded);
  return { spawn, spawns, controlRequests, closed };
}

describe("ClaudeAdapterV2 MCP credential channel", () => {
  const t3McpServer = {
    type: "http" as const,
    url: "http://127.0.0.1:43123/mcp",
    headers: { Authorization: "Bearer dummy-mcp-credential" },
  };
  const openWith = (cli: ReturnType<typeof makeFakeClaudeCli>) =>
    Effect.gen(function* () {
      const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
      return yield* runner.open({
        threadId: ThreadId.make("thread-claude-mcp-channel"),
        providerSessionId: ProviderSessionId.make("provider-session-claude-mcp-channel"),
        options: {
          ...ClaudeAdapterV2.makeClaudeQueryOptions({
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            nativeThreadId: "native-thread-claude-mcp-channel",
            resume: false,
            cwd: null,
            environment: { PATH: "/usr/bin" },
            mcpServers: { "t3-code": t3McpServer },
          }),
          pathToClaudeCodeExecutable: "/opt/claude/cli.js",
          spawnClaudeCodeProcess: cli.spawn,
        },
      });
    }).pipe(
      Effect.provide(ClaudeAdapterV2.layerQueryRunner),
      Effect.provideService(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
      Effect.provide(NodeServices.layer),
    );

  it.effect("sends MCP servers over stdin, not argv or the environment", () =>
    Effect.gen(function* () {
      const cli = makeFakeClaudeCli();
      const session = yield* openWith(cli);
      yield* session.close;

      assert.deepInclude(cli.controlRequests, {
        subtype: "mcp_set_servers",
        servers: { "t3-code": t3McpServer },
      });
      const spawned = JSON.stringify(cli.spawns);
      assert.notInclude(spawned, "--mcp-config");
      assert.notInclude(spawned, "dummy-mcp-credential");
    }),
  );
});

describe("ClaudeAdapterV2 native session identity", () => {
  const openTurnWithOrdinal = (providerTurnOrdinal: number, nativeThreadHasTurns?: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-session-identity-",
        });
        const openedQueries: Array<ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-session-identity"),
            open: (input) =>
              Effect.sync(() => {
                openedQueries.push(input);
                return {
                  messages: Stream.empty,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-session-identity");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-identity");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("run-attempt-claude-session-identity"),
            text: "Respond with identity ok",
            attachments: [],
            providerTurnOrdinal,
            ...(nativeThreadHasTurns === undefined ? {} : { nativeThreadHasTurns }),
          }),
        );
        return openedQueries;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
    );

  it.effect(
    "resumes the native session on a fresh session instance when prior provider turns exist",
    () =>
      Effect.gen(function* () {
        const openedQueries = yield* openTurnWithOrdinal(2);
        assert.equal(openedQueries.length, 1);
        assert.equal(openedQueries[0]?.options.resume, "native-session-identity");
        assert.equal(openedQueries[0]?.options.sessionId, undefined);
      }),
  );

  it.effect("creates a fresh native session despite earlier provider-thread turns", () =>
    Effect.gen(function* () {
      const openedQueries = yield* openTurnWithOrdinal(4, false);
      assert.equal(openedQueries[0]?.options.sessionId, "native-session-identity");
      assert.equal(openedQueries[0]?.options.resume, undefined);
    }),
  );
});

describe("ClaudeAdapterV2 rollback", () => {
  const lastProviderTurn = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) => {
    const event = events.findLast((candidate) => candidate.type === "provider_turn.updated");
    if (event?.type !== "provider_turn.updated") {
      throw new Error("Expected a provider turn update.");
    }
    return event.providerTurn;
  };
  // Rollback closes the live query and waits for its message stream to end.
  const makeRollbackHarness = makeWakeHarnessWithOptions({
    close: (sdkMessages) => Queue.shutdown(sdkMessages),
  });

  it.effect.each([
    { kind: "fork with inherited head", fork: true, headMessageId: "remapped-inherited-head" },
    { kind: "fork without recorded head", fork: true, headMessageId: undefined },
    { kind: "ordinary thread", fork: false, headMessageId: undefined },
  ])("rolls back the first run of a $kind", ({ fork, headMessageId }) =>
    Effect.gen(function* () {
      let allocations = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
        allocateSessionId: Effect.sync(() =>
          allocations++ === 0 ? WAKE_NATIVE_SESSION : "fresh-native-session",
        ),
        forkSession: () =>
          Effect.succeed({
            sessionId: WAKE_NATIVE_SESSION,
            ...(headMessageId === undefined ? {} : { headMessageId }),
          }),
      });
      const providerThread = fork
        ? yield* harness.runtime.forkThread({
            sourceProviderThread: {
              ...harness.providerThread,
              nativeThreadRef: {
                driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
                nativeId: "source-native-session",
                strength: "strong",
              },
            },
            targetThreadId: harness.threadId,
          })
        : harness.providerThread;
      const turnInput = makeClaudeTestTurnInput({
        threadId: harness.threadId,
        providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("first-run"),
        text: "This run will be rolled back.",
        attachments: [],
        nativeThreadHasTurns: false,
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.offerAndWait(
        makeAssistantTextFrame({ uuid: "own-run-message", text: "Discard this answer." }),
      );
      yield* harness.offerAndWait(
        makeResultFrame({ uuid: "own-run-result", result: "Discard this answer." }),
      );
      assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
      const completed = harness.events.findLast(
        (event) => event.type === "provider_thread.updated",
      );
      assert.equal(completed?.type, "provider_thread.updated");
      if (completed?.type !== "provider_thread.updated") return;
      assert.equal(completed.providerThread.firstRunOrdinal, 1);

      const rolledBack = yield* harness.runtime.rollbackThread({
        providerThread: completed.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-before-first-run"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [lastProviderTurn(harness.events)],
      });
      assert.equal(
        rolledBack.providerThread.forkedFrom?.providerThreadId,
        providerThread.forkedFrom?.providerThreadId,
      );
      yield* harness.runtime.startTurn({
        ...turnInput,
        attemptId: RunAttemptId.make("after-rollback"),
        providerThread: rolledBack.providerThread,
        providerTurnOrdinal: 2,
        nativeThreadHasTurns: false,
      });
      const options = harness.getOpenedOptions();
      assert.equal(harness.processQueues.length, 2);
      if (headMessageId !== undefined) {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, WAKE_NATIVE_SESSION);
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, headMessageId);
        assert.equal(options?.resume, WAKE_NATIVE_SESSION);
        assert.equal(options?.resumeSessionAt, headMessageId);
        assert.isUndefined(options?.sessionId);
      } else {
        assert.equal(rolledBack.providerThread.nativeThreadRef?.nativeId, "fresh-native-session");
        assert.isNull(rolledBack.providerThread.nativeConversationHeadRef);
        assert.equal(options?.sessionId, "fresh-native-session");
        assert.isUndefined(options?.resume);
        assert.isUndefined(options?.resumeSessionAt);
      }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );

  it.effect(
    "rolls back to the main-thread assistant message when a subagent frame comes last",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeRollbackHarness;
        const now = yield* DateTime.now;
        const mainUuid = "00000000-0000-4000-8000-000000000641";
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-cursor-main"),
            text: "Continue.",
            attachments: [],
          }),
        );
        yield* Queue.offerAll(harness.sdkMessages, [
          makeAssistantTextFrame({ uuid: mainUuid, text: "Delegating." }),
          makeAssistantErrorFrame({
            uuid: "00000000-0000-4000-8000-000000000642",
            error: undefined,
            parentToolUseId: "toolu_subagent",
          }),
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000643", result: "Done." }),
        ]);
        yield* Queue.take(harness.terminalReceipts);

        const providerTurn = lastProviderTurn(harness.events);
        assert.equal(providerTurn.nativeTurnRef?.nativeId, mainUuid);
        const rolledBack = yield* harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-main"),
            appRunOrdinal: 1,
            providerTurn,
          },
          providerThreadTurns: [
            providerTurn,
            {
              ...providerTurn,
              id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
              ordinal: 2,
            },
          ],
        });
        assert.equal(rolledBack.providerThread.nativeConversationHeadRef?.nativeId, mainUuid);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
        ),
      ),
  );

  it.effect("never records a subagent uuid for a turn with no main-thread assistant message", () =>
    Effect.gen(function* () {
      // The continuation turn reopens the query, and rollback shut the first queue down.
      const harness = yield* makeWakeHarnessWithOptions({
        close: (sdkMessages) => Queue.shutdown(sdkMessages),
        freshQueueOnReopen: true,
      });
      const now = yield* DateTime.now;
      const subagentUuid = "00000000-0000-4000-8000-000000000644";
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only"),
          text: "Background task completed.",
          attachments: [],
        }),
      );
      yield* Queue.offerAll(harness.sdkMessages, [
        makeAssistantErrorFrame({
          uuid: subagentUuid,
          error: undefined,
          parentToolUseId: "toolu_subagent",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000645", result: "Done." }),
      ]);
      yield* Queue.take(harness.terminalReceipts);

      const providerTurn = lastProviderTurn(harness.events);
      assert.notEqual(providerTurn.nativeTurnRef?.nativeId, subagentUuid);
      const rollbackTo = (providerThreadTurns: ReadonlyArray<typeof providerTurn>) =>
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-claude-cursor-subagent-only"),
            appRunOrdinal: 1,
            providerTurn,
          },
          providerThreadTurns,
        });

      const latest = yield* rollbackTo([providerTurn]);
      assert.isNull(latest.providerThread.nativeConversationHeadRef);
      const error = yield* rollbackTo([
        providerTurn,
        {
          ...providerTurn,
          id: ProviderTurnId.make("provider-turn-claude-cursor-next"),
          ordinal: 2,
        },
      ]).pipe(Effect.flip);
      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(String(error.cause), "no SDK assistant message cursor");

      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: latest.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-claude-cursor-subagent-only-next"),
          text: "Continue.",
          attachments: [],
          providerTurnOrdinal: 2,
        }),
      );
      const reopenedQueue = harness.processQueues[1];
      assert.isDefined(reopenedQueue);
      if (reopenedQueue === undefined) return;
      yield* Queue.offerAll(reopenedQueue, [
        makeAssistantTextFrame({
          uuid: "00000000-0000-4000-8000-000000000646",
          text: "Continuing.",
        }),
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000647", result: "Done." }),
      ]);
      const next = yield* Queue.take(harness.terminalReceipts);
      assert.equal(next.status, "completed");
      // The reopened query must resume from the whole transcript, not pin a subagent uuid.
      assert.isUndefined(harness.getOpenedOptions()?.resumeSessionAt);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 query message stream", () => {
  it.effect("closes the query when the message stream is interrupted mid-read", () =>
    Effect.gen(function* () {
      let closed = false;
      let releaseRead = () => {};
      const readStarted = Promise.withResolvers<void>();
      // Never yields a message — the read stays pending until close() flips
      // `closed` and releases the in-flight await.
      // oxlint-disable-next-line require-yield
      async function* sdkMessages(): AsyncGenerator<SDKMessage, void> {
        for (;;) {
          if (closed) return;
          await new Promise<void>((resolve) => {
            releaseRead = resolve;
            readStarted.resolve();
          });
        }
      }
      const generator = sdkMessages();
      const close = () => {
        closed = true;
        releaseRead();
      };
      const query = {
        next: () => generator.next(),
        return: async (value?: void) => {
          close();
          return generator.return(value);
        },
        throw: (error?: unknown) => generator.throw(error),
        [Symbol.asyncIterator]: () => generator,
        close,
      } as unknown as ClaudeQuery;

      const scope = yield* Scope.make();
      yield* Stream.fromAsyncIterable(
        ClaudeAdapterV2.claudeQueryMessages(query),
        (cause) => cause,
      ).pipe(
        Stream.runForEach(() => Effect.void),
        Effect.forkIn(scope),
      );
      yield* Effect.promise(() => readStarted.promise);

      // Iterating query[Symbol.asyncIterator]() directly deadlocks here:
      // the raw generator's return() queues behind the in-flight read and
      // scope close never completes.
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(closed);
    }),
  );
});
