import type { ForkSessionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  ClaudeAgentSdkQueryRunnerError,
  ClaudeAgentSdkQueryOpenInput,
  ClaudeAgentSdkQuerySession,
  ClaudeAgentSdkSessionForkInput,
  ClaudeAgentSdkSubagentLookupInput,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import type * as Crypto from "effect/Crypto";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";

export class ClaudeAgentSdkQueryRunner extends Context.Service<
  ClaudeAgentSdkQueryRunner,
  {
    readonly allocateSessionId: Effect.Effect<string, ClaudeAgentSdkQueryRunnerError>;
    readonly open: (
      input: ClaudeAgentSdkQueryOpenInput,
    ) => Effect.Effect<ClaudeAgentSdkQuerySession, ClaudeAgentSdkQueryRunnerError>;
    readonly forkSession: (
      input: ClaudeAgentSdkSessionForkInput,
    ) => Effect.Effect<ForkSessionResult, ClaudeAgentSdkQueryRunnerError>;
    /** The tool call that launched a subagent, read from the CLI's session storage. */
    readonly subagentLaunchToolUseId: (
      input: ClaudeAgentSdkSubagentLookupInput,
    ) => Effect.Effect<string | null, ClaudeAgentSdkQueryRunnerError>;
    readonly assertComplete: Effect.Effect<void, ClaudeAgentSdkQueryRunnerError>;
  }
>()("t3/provider/ClaudeAgentSdkQueryRunner") {}

export const layer: Layer.Layer<
  ClaudeAgentSdkQueryRunner,
  never,
  Crypto.Crypto | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Services<typeof layer> | Scope.Scope>();
    // A failed load is not kept, so the next session retries it.
    const service = yield* Effect.cachedWithTTL(
      Effect.promise(() => import("../orchestration-v2/Adapters/ClaudeAdapterV2.ts")).pipe(
        Effect.flatMap((adapter) => Layer.build(adapter.layerQueryRunner)),
        Effect.map((services) => Context.get(services, ClaudeAgentSdkQueryRunner)),
        Effect.provideContext(context),
      ),
      (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    );
    return ClaudeAgentSdkQueryRunner.of({
      allocateSessionId: service.pipe(Effect.flatMap((value) => value.allocateSessionId)),
      open: (input) => service.pipe(Effect.flatMap((value) => value.open(input))),
      forkSession: (input) => service.pipe(Effect.flatMap((value) => value.forkSession(input))),
      subagentLaunchToolUseId: (input) =>
        service.pipe(Effect.flatMap((value) => value.subagentLaunchToolUseId(input))),
      assertComplete: service.pipe(Effect.flatMap((value) => value.assertComplete)),
    });
  }),
);
