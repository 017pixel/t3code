import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import type { EnvironmentConnectionSummary } from "@t3tools/client-runtime/state/presentation";

export type PullRequestEnvironmentTarget = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly host?: string;
};

export function pullRequestFallbackEnvironment(
  target: PullRequestEnvironmentTarget,
  projects: ReadonlyArray<EnvironmentProject>,
  environments: ReadonlyArray<
    Pick<EnvironmentConnectionSummary, "environmentId" | "connectionState" | "isEnabled">
  >,
) {
  const requested = environments.find(
    (environment) => environment.environmentId === target.environmentId,
  );
  // Available is also the initial state before the connection supervisor starts.
  if (
    requested?.isEnabled &&
    (requested.connectionState === "available" ||
      requested.connectionState === "connecting" ||
      requested.connectionState === "reconnecting")
  )
    return null;
  const connectedEnvironmentIds = new Set<string>(
    environments
      .filter((environment) => environment.isEnabled && environment.connectionState === "connected")
      .map((environment) => environment.environmentId),
  );
  if (connectedEnvironmentIds.has(target.environmentId)) return null;
  const own = projects.find(
    (project) => project.environmentId === target.environmentId && project.id === target.projectId,
  );
  const host = target.host ?? own?.repositoryIdentity?.canonicalKey.split("/")[0];
  if (!host) return null;
  const key = `${host}/${target.repository}`.toLowerCase();
  const copy = projects.find(
    (project) =>
      project.environmentId !== target.environmentId &&
      connectedEnvironmentIds.has(project.environmentId) &&
      project.repositoryIdentity?.canonicalKey.toLowerCase() === key,
  );
  return copy ? { environmentId: String(copy.environmentId), projectId: String(copy.id) } : null;
}
