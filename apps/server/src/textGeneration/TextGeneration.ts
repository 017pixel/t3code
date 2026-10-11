import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import { TextGenerationError } from "@t3tools/contracts";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderMaintenanceCoordinator from "@t3tools/provider-core/server/maintenance";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as ThreadTitleLinks from "./ThreadTitleLinks.ts";
import * as HostLock from "../provider/ProviderMaintenanceHostLock.ts";

export type {
  BranchNameGenerationInput,
  BranchNameGenerationResult,
  CommitMessageGenerationInput,
  CommitMessageGenerationResult,
  PrContentGenerationInput,
  PrContentGenerationResult,
  ThreadTitleGenerationInput,
  ThreadTitleGenerationResult,
} from "@t3tools/provider-core/server/textGeneration";

/**
 * TextGeneration - Service tag for commit and change request text generation.
 */
export class TextGeneration extends Context.Service<TextGeneration, ProviderTextGeneration>()(
  "t3/textGeneration/TextGeneration",
) {}

type TextGenerationOp =
  | "generateCommitMessage"
  | "generatePrContent"
  | "generateBranchName"
  | "generateThreadTitle";

const resolveInstance = (
  registry: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
  operation: TextGenerationOp,
  instanceId: ProviderInstanceId,
): Effect.Effect<ProviderInstance["textGeneration"], TextGenerationError> =>
  registry.getInstance(instanceId).pipe(
    Effect.flatMap((instance) =>
      instance
        ? Effect.succeed(instance.textGeneration)
        : Effect.fail(
            new TextGenerationError({
              operation,
              detail: `No provider instance registered for id '${instanceId}'.`,
            }),
          ),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const sourceControl = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
  const admission = yield* ProviderMaintenanceCoordinator.ProviderMaintenanceAdmission;
  const hostLock = yield* HostLock.ProviderMaintenanceHostLock;
  // The host lease is taken first: an install drains leases before it closes admission.
  const launch = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    hostLock.withRead(admission.withLaunchPermit(effect));
  const instanceFor = (operation: TextGenerationOp, instanceId: ProviderInstanceId) =>
    resolveInstance(registry, operation, instanceId);
  return TextGeneration.of({
    generateCommitMessage: (input) =>
      instanceFor("generateCommitMessage", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => launch(textGeneration.generateCommitMessage(input))),
      ),
    generatePrContent: (input) =>
      instanceFor("generatePrContent", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => launch(textGeneration.generatePrContent(input))),
      ),
    generateBranchName: (input) =>
      instanceFor("generateBranchName", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) => launch(textGeneration.generateBranchName(input))),
      ),
    generateThreadTitle: (input) =>
      instanceFor("generateThreadTitle", input.modelSelection.instanceId).pipe(
        Effect.flatMap((textGeneration) =>
          Effect.gen(function* () {
            const linkedContext =
              input.linkedContext ??
              (yield* ThreadTitleLinks.resolveThreadTitleLinks(input).pipe(
                Effect.provideService(
                  SourceControlProviderRegistry.SourceControlProviderRegistry,
                  sourceControl,
                ),
              ));
            return yield* launch(textGeneration.generateThreadTitle({ ...input, linkedContext }));
          }),
        ),
      ),
  });
});

export const layer = Layer.effect(TextGeneration, make);
