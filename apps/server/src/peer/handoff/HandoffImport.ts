import {
  OrchestratorMcpThreadImportInput,
  type OrchestratorMcpThreadImportResult,
  type OrchestrationV2LinkOrigin,
  type ProviderInteractionMode,
  ProjectId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { deletePendingAttachment } from "../../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import * as HandoffGit from "./HandoffGit.ts";

export class HandoffImportRefusedError extends Schema.TaggedError<HandoffImportRefusedError>()(
  "HandoffImportRefusedError",
  {
    reason: Schema.Literals([
      "invalid-bundle",
      "missing-upload",
      "project",
      "repository",
      "worktree-location",
    ]),
    notAccepted: Schema.optional(
      Schema.Struct({
        source: OrchestratorMcpThreadImportInput.fields.source,
        projectId: ProjectId,
      }),
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "invalid-bundle":
        return "Pass a valid handoff bundle and omit worktreePath and branch.";
      case "missing-upload":
        return "The bundle upload was not found. Upload it again.";
      case "project":
        return "The destination project was not found.";
      case "repository":
        return "The bundle belongs to a different repository than this project.";
      case "worktree-location":
        return "The worktree location is not usable. Fix it in Settings → Storage.";
    }
  }
}
export class HandoffImportOperationError extends Schema.TaggedError<HandoffImportOperationError>()(
  "HandoffImportOperationError",
  {
    operation: Schema.Literals(["read-project", "prepare-worktree"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The handoff failed during ${this.operation}.`;
  }
}
type Input = OrchestratorMcpThreadImportInput & {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly linkOrigin: OrchestrationV2LinkOrigin | undefined;
};
type ImportError = Effect.Error<
  ReturnType<ThreadImportService.ThreadImportService["Service"]["importThread"]>
>;
export class HandoffImportProviderDisabledError extends Schema.TaggedError<HandoffImportProviderDisabledError>()(
  "HandoffImportProviderDisabledError",
  {
    projectId: ThreadManagement.ThreadManagementProviderInstanceDisabledError.fields.projectId,
    instanceId: ThreadManagement.ThreadManagementProviderInstanceDisabledError.fields.instanceId,
    source: OrchestratorMcpThreadImportInput.fields.source,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Provider instance "${this.instanceId}" is disabled for project ${this.projectId}.`;
  }
}
export class HandoffImportGitRefusedError extends Schema.TaggedError<HandoffImportGitRefusedError>()(
  "HandoffImportGitRefusedError",
  {
    source: OrchestratorMcpThreadImportInput.fields.source,
    projectId: ProjectId,
    cause: Schema.Union([
      HandoffGit.HandoffNotARepositoryError,
      HandoffGit.HandoffTooLargeError,
      HandoffGit.HandoffMissingBaseError,
      HandoffGit.HandoffBranchCheckedOutError,
      HandoffGit.HandoffBranchDivergedError,
      HandoffGit.HandoffGitStepError,
    ]),
  },
) {
  override get message(): string {
    return "The destination refused the handoff Git setup.";
  }
}
export class HandoffImport extends Context.Service<
  HandoffImport,
  {
    readonly importThread: (
      input: Input,
    ) => Effect.Effect<
      OrchestratorMcpThreadImportResult,
      | ImportError
      | HandoffImportRefusedError
      | HandoffImportOperationError
      | HandoffImportProviderDisabledError
      | HandoffImportGitRefusedError
    >;
  }
>()("t3/peer/handoff/HandoffImport") {}

const decode = Schema.decodeUnknownEffect(OrchestratorMcpThreadImportInput);
const make = Effect.gen(function* () {
  const imports = yield* ThreadImportService.ThreadImportService;
  const projects = yield* ProjectService.ProjectService;
  const identities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const fs = yield* FileSystem.FileSystem;
  const git = yield* HandoffGit.HandoffGit;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const processes = yield* VcsProcess.VcsProcess;

  const importThread: HandoffImport["Service"]["importThread"] = Effect.fn(
    "HandoffImport.importThread",
  )(function* (input) {
    yield* decode(input).pipe(
      Effect.mapError(() => new HandoffImportRefusedError({ reason: "invalid-bundle" })),
    );
    return yield* imports.withAcceptanceLock(
      input.source,
      Effect.scoped(
        Effect.gen(function* () {
          // Accepted identity wins before either the upload or a now-edited destination workspace is read.
          const accepted = yield* imports.lookup(input);
          if (accepted !== null) return accepted;
          const bundle = input.bundle;
          if (bundle === undefined) return yield* imports.importThread(input);
          if (
            input.worktreePath !== undefined ||
            input.branch !== undefined ||
            parseThreadSegmentFromAttachmentId(bundle.attachmentId) !== "pending"
          )
            return yield* new HandoffImportRefusedError({ reason: "invalid-bundle" });
          if (bundle.branch !== null) {
            const validBranch = yield* processes
              .run({
                operation: "HandoffImport.validateBranch",
                command: "git",
                cwd: config.cwd,
                args: ["check-ref-format", `refs/heads/${bundle.branch}`],
                allowNonZeroExit: true,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new HandoffImportOperationError({ operation: "prepare-worktree", cause }),
                ),
              );
            if (validBranch.exitCode !== 0)
              return yield* new HandoffImportRefusedError({ reason: "invalid-bundle" });
          }
          const project = yield* projects
            .getById(input.projectId)
            .pipe(
              Effect.mapError(
                (cause) => new HandoffImportOperationError({ operation: "read-project", cause }),
              ),
            );
          if (Option.isNone(project))
            return yield* new HandoffImportRefusedError({ reason: "project" });
          const repository = bundle.repository;
          if (repository === undefined)
            return yield* new HandoffImportRefusedError({ reason: "repository" });
          const actual = yield* identities.resolve(project.value.workspaceRoot, { refresh: true });
          if (repository.canonicalKey !== null) {
            if (actual?.canonicalKey !== repository.canonicalKey)
              return yield* new HandoffImportRefusedError({ reason: "repository" });
          } else {
            // A local clone has no canonical remote identity. Only its actual local origin can establish the match.
            let root = project.value.workspaceRoot;
            let matched = false;
            for (let depth = 0; depth < 8 && !matched; depth++) {
              root = yield* fs.realPath(root).pipe(Effect.orElseSucceed(() => root));
              if (root === repository.sourceRoot) {
                matched = true;
                break;
              }
              const origin = yield* processes
                .run({
                  operation: "HandoffImport.localOrigin",
                  command: "git",
                  cwd: root,
                  args: ["remote", "get-url", "origin"],
                  allowNonZeroExit: true,
                  env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new HandoffImportOperationError({ operation: "read-project", cause }),
                  ),
                );
              if (origin.exitCode !== 0) break;
              const raw = origin.stdout.trim();
              if (raw.startsWith("file://")) {
                const localUrl = yield* Effect.try(() => new URL(raw)).pipe(
                  Effect.mapError(() => new HandoffImportRefusedError({ reason: "repository" })),
                );
                if (localUrl.hostname !== "" && localUrl.hostname !== "localhost") break;
                root = yield* Effect.try(() => decodeURIComponent(localUrl.pathname)).pipe(
                  Effect.mapError(() => new HandoffImportRefusedError({ reason: "repository" })),
                );
              } else if (path.isAbsolute(raw) || !/^[a-z][a-z0-9+.-]*:|^[^/]+:/i.test(raw))
                root = path.resolve(root, raw);
              else break;
            }
            if (actual !== null || !matched)
              return yield* new HandoffImportRefusedError({ reason: "repository" });
          }
          const bundlePath = resolveAttachmentPathById({
            attachmentsDir: config.attachmentsDir,
            attachmentId: bundle.attachmentId,
          });
          if (
            bundlePath === null ||
            !(yield* fs
              .exists(bundlePath)
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new HandoffImportOperationError({ operation: "prepare-worktree", cause }),
                ),
              ))
          )
            return yield* new HandoffImportRefusedError({ reason: "missing-upload" });
          const current = yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) => new HandoffImportOperationError({ operation: "prepare-worktree", cause }),
            ),
          );
          const parent = resolveWorktreesDirectory(
            current.worktreesDirectory,
            config.worktreesDir,
            path,
            home,
          );
          if (parent === null)
            return yield* new HandoffImportRefusedError({ reason: "worktree-location" });
          const directory = path.join(parent, path.basename(project.value.workspaceRoot));
          yield* fs
            .makeDirectory(directory, { recursive: true })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HandoffImportOperationError({ operation: "prepare-worktree", cause }),
              ),
            );
          // The import digest includes the source environment, so equally named moves cannot share a path.
          const importId = yield* imports.identity(input.source);
          const worktreePath = path.join(
            directory,
            `handoff-${importId.slice("thread:import:".length)}`,
          );
          const lease = yield* git
            .apply({
              repoRoot: project.value.workspaceRoot,
              worktreePath,
              handoffId: input.source.handoffId,
              bundlePath,
              branch: bundle.branch,
              tip: bundle.tip,
              snapshot: bundle.snapshot,
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HandoffImportGitRefusedError({
                    source: input.source,
                    projectId: input.projectId,
                    cause,
                  }),
              ),
            );
          yield* driver
            .initializeSubmodules(worktreePath, { submodules: current.worktreeSubmodules })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new HandoffImportOperationError({ operation: "prepare-worktree", cause }),
              ),
            );
          // Cancellation must never undo a workspace whose conversation already committed.
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const raced = yield* imports.lookup(input).pipe(Effect.exit);
              if (Exit.isFailure(raced)) {
                yield* lease.commit;
                return yield* Effect.failCause(raced.cause);
              }
              if (raced.value !== null) {
                yield* lease.commit;
                return raced.value;
              }
              const result = yield* imports
                .importThread({
                  ...input,
                  branch: lease.branch ?? undefined,
                  worktreePath,
                })
                .pipe(Effect.exit);
              if (Exit.isFailure(result)) {
                const persisted = yield* imports.lookup(input).pipe(Effect.exit);
                if (Exit.isSuccess(persisted) && persisted.value !== null) {
                  yield* lease.commit;
                  return persisted.value;
                }
                // A failed read cannot establish absence after a potentially committed transaction.
                if (Exit.isFailure(persisted)) {
                  yield* lease.commit;
                  return yield* Effect.failCause(persisted.cause);
                }
                return yield* Effect.failCause(result.cause);
              }
              yield* lease.commit;
              yield* deletePendingAttachment(bundle.attachmentId).pipe(
                Effect.provideService(ServerConfig.ServerConfig, config),
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.ignore,
              );
              return result.value;
            }),
          );
        }),
      ).pipe(
        Effect.catchTags({
          // Native refusals follow the absence lookup; scoped Git rollback finishes before proof escapes.
          HandoffImportRefusedError: (cause) =>
            Effect.fail(
              new HandoffImportRefusedError({
                reason: cause.reason,
                notAccepted: { source: input.source, projectId: input.projectId },
                cause,
              }),
            ),
          ThreadManagementProviderInstanceDisabledError: (cause) =>
            Effect.fail(
              new HandoffImportProviderDisabledError({
                source: input.source,
                projectId: cause.projectId,
                instanceId: cause.instanceId,
                cause,
              }),
            ),
        }),
      ),
    );
  });
  return HandoffImport.of({ importThread });
});
export const layer = Layer.effect(HandoffImport, make);
