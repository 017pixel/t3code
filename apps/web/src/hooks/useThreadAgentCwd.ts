import { AuthFilesystemReadScope, type EnvironmentId } from "@t3tools/contracts";
import { threadAgentCwd } from "@t3tools/shared/projectScripts";

import { projectEnvironment } from "../state/projects";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";

/**
 * The thread agent's cwd. Like the server, a worktree whose branch has no
 * directory at the project's subdirectory falls back to the worktree root.
 */
export function useThreadAgentCwd(
  environmentId: EnvironmentId | null,
  project: {
    readonly workspaceRoot: string;
    readonly repositoryRoot?: string | null | undefined;
  } | null,
  worktreePath: string | null,
): string | null {
  const canRead = useEnvironmentScope(environmentId, AuthFilesystemReadScope);
  const candidate = project
    ? threadAgentCwd({
        projectRoot: project.workspaceRoot,
        repositoryRoot: project.repositoryRoot,
        worktreePath,
      })
    : null;
  const nested = worktreePath !== null && candidate !== null && candidate !== worktreePath;
  const entry = useEnvironmentQuery(
    nested && environmentId !== null && canRead
      ? projectEnvironment.fileMetadata({ environmentId, input: { path: candidate } })
      : null,
  ).data;
  if (!nested) return candidate;
  return entry === null || (entry !== undefined && entry.kind !== "directory")
    ? worktreePath
    : candidate;
}
