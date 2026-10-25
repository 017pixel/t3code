import { useProjects } from "../../state/entities";
import { useWorkspaceEnvironments } from "../../state/workspace";
import {
  pullRequestFallbackEnvironment,
  type PullRequestEnvironmentTarget,
} from "./pullRequestEnvironmentFallback";

/**
 * The params to read a pull request through: its own environment, or a connected one with a
 * copy of the repository while its own is offline.
 */
export function usePullRequestEnvironmentFallback<Params extends PullRequestEnvironmentTarget>(
  params: Params,
): Params {
  const projects = useProjects();
  const connected = new Set(
    useWorkspaceEnvironments()
      .filter((environment) => environment.connectionState === "connected")
      .map((environment) => String(environment.environmentId)),
  );
  const fallback = pullRequestFallbackEnvironment(params, projects, connected);
  return fallback ? { ...params, ...fallback } : params;
}
