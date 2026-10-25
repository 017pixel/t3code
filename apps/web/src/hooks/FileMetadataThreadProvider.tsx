import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { Atom } from "effect/reactivity";
import { createContext, type ReactNode } from "react";

import { projectEnvironment } from "../state/projects";
import { environmentThreadDetails } from "../state/threads";

export const FileMetadataThreadContext = createContext<ScopedThreadRef | null>(null);
const EMPTY_RETENTION = Atom.make(undefined);

type Checkpoints = OrchestrationV2ThreadProjection["checkpoints"];
interface CheckpointFiles {
  readonly id: string;
  readonly status: string;
  readonly files: ReadonlyArray<{ readonly path: string }>;
}

/** Workspace paths whose metadata a checkpoint change may have made stale. */
export function changedCheckpointPaths(
  before: ReadonlyArray<CheckpointFiles>,
  after: ReadonlyArray<CheckpointFiles>,
  cwd: string,
): string[] {
  const oldById = new Map(before.map((checkpoint) => [checkpoint.id, checkpoint]));
  const paths = new Set<string>();
  for (const checkpoint of after) {
    const old = oldById.get(checkpoint.id);
    oldById.delete(checkpoint.id);
    if (old?.files === checkpoint.files && old?.status === checkpoint.status) continue;
    for (const file of checkpoint.files) paths.add(resolveWorkspaceFilePath(file.path, cwd));
    for (const file of old?.files ?? []) paths.add(resolveWorkspaceFilePath(file.path, cwd));
  }
  for (const checkpoint of oldById.values())
    for (const file of checkpoint.files) paths.add(resolveWorkspaceFilePath(file.path, cwd));
  return [...paths];
}

// Retains the thread's metadata and invalidates the paths each checkpoint change
// touches. The first projection seen is a baseline, not a change.
const checkpointMetadataFamily = Atom.family((key: string) => {
  const [environmentId, threadId, cwd] = JSON.parse(key) as [EnvironmentId, ThreadId, string];
  const ref = { environmentId, threadId };
  return Atom.make((get) => {
    get(projectEnvironment.fileMetadataThread(ref));
    const registry = get.registry;
    let previous: Checkpoints | undefined;
    get.subscribe(
      environmentThreadDetails.quietThreadAtom(ref),
      (structure) => {
        const before = previous;
        previous = structure?.projection.checkpoints;
        if (!before || !previous || before === previous) return;
        const paths = changedCheckpointPaths(before, previous, cwd);
        if (paths.length === 0) return;
        void runAtomCommand(
          registry,
          projectEnvironment.invalidateFileMetadata,
          { environmentId, input: { paths } },
          { reportFailure: false },
        );
      },
      { immediate: true },
    );
  }).pipe(Atom.withLabel(`file-metadata-thread-checkpoints:${key}`));
});

/** Owned by the chat view so virtualized rows can unmount without losing metadata.
 * Checkpoints are followed only through `detailRef` (null for drafts and until the
 * shell exists): subscribing a thread the server does not know retries "not found"
 * in a loop. */
export function FileMetadataThreadProvider(props: {
  threadRef: ScopedThreadRef | null;
  detailRef: ScopedThreadRef | null;
  cwd: string | undefined;
  children?: ReactNode;
}) {
  const { threadRef, detailRef, cwd, children } = props;
  const followsCheckpoints =
    threadRef !== null &&
    detailRef !== null &&
    cwd !== undefined &&
    cwd !== "" &&
    detailRef.environmentId === threadRef.environmentId &&
    detailRef.threadId === threadRef.threadId;
  useAtomValue(
    threadRef === null
      ? EMPTY_RETENTION
      : followsCheckpoints
        ? checkpointMetadataFamily(
            JSON.stringify([threadRef.environmentId, threadRef.threadId, cwd]),
          )
        : projectEnvironment.fileMetadataThread(threadRef),
  );
  return <FileMetadataThreadContext value={threadRef}>{children}</FileMetadataThreadContext>;
}
