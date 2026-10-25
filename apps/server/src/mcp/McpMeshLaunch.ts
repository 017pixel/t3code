// EXPERIMENTAL mesh v1. What a launch on another member needs: its project for this repository,
// and the caller's model when it has it. Remote t3_thread_launch and remote delegate_task both use
// these; a leaf module, so mesh services can import it.
import { type ModelSelection, type Project, type ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

const MAX_MEMBER_PROJECT_PAGES = 10;
const MEMBER_PROJECT_PAGE_LIMIT = 100;

export const projectRepositoryKey = (project: Pick<Project, "repositoryIdentity">) =>
  project.repositoryIdentity == null
    ? null
    : sourceControlDefinitions.canonicalRepositoryKey(project.repositoryIdentity.canonicalKey);

/** Every project on a member, read page by page through its own `t3_project_list`. */
interface MemberProjectPage {
  readonly projects?: ReadonlyArray<Project>;
  readonly nextCursor?: number | null;
}

export const listMemberProjects = Effect.fn("McpMeshLaunch.listMemberProjects")(function* <E, R>(
  listPage: (page: {
    readonly cursor: number;
    readonly limit: number;
  }) => Effect.Effect<MemberProjectPage, E, R>,
) {
  const projects: Array<Project> = [];
  let cursor: number | null = 0;
  for (let page = 0; cursor !== null && page < MAX_MEMBER_PROJECT_PAGES; page++) {
    const result: MemberProjectPage = yield* listPage({
      cursor,
      limit: MEMBER_PROJECT_PAGE_LIMIT,
    });
    projects.push(...(result.projects ?? []));
    cursor = result.nextCursor ?? null;
  }
  return projects.filter((project) => project.deletedAt === null);
});

const describeMemberProject = (project: Project) =>
  `${project.title} (${project.id} at ${project.workspaceRoot}${
    project.repositoryIdentity == null ? "" : `, ${project.repositoryIdentity.canonicalKey}`
  })`;

const describeMemberProjects = (projects: ReadonlyArray<Project>) =>
  projects.slice(0, 10).map(describeMemberProject).join("; ");

/** Names a member's projects, for a refusal the agent can act on. */
export const memberProjectsSummary = (projects: ReadonlyArray<Project>) =>
  projects.length === 0
    ? "It has no projects."
    : `Its projects: ${describeMemberProjects(projects)}.`;

export type RepositoryProjectMatch =
  | { readonly _tag: "found"; readonly projectId: ProjectId }
  /** No project, or more than one, is a checkout of the repository; `reason` names candidates. */
  | { readonly _tag: "refused"; readonly reason: string };

/** The one project on `machineLabel` for repository `key`. Two or more is a refusal, never a pick. */
export function matchRepositoryProject(
  machineLabel: string,
  key: string,
  projects: ReadonlyArray<Project>,
): RepositoryProjectMatch {
  const matches = projects.filter((project) => projectRepositoryKey(project) === key);
  const [match] = matches;
  if (match !== undefined && matches.length === 1) return { _tag: "found", projectId: match.id };
  return {
    _tag: "refused",
    reason:
      matches.length > 1
        ? `${machineLabel} has more than one project for ${key}: ${describeMemberProjects(matches)}.`
        : `${machineLabel} has no project for ${key}. ${memberProjectsSummary(projects)}`,
  };
}

/** The caller's model when the member lists it; otherwise undefined, and the member's project default applies. */
export const modelOnMember = <E, R>(
  model: ModelSelection | undefined,
  capabilities: (search: string) => Effect.Effect<
    {
      readonly providers: ReadonlyArray<{
        readonly providerInstanceId: string;
        readonly models: ReadonlyArray<{ readonly id: string }>;
      }>;
    },
    E,
    R
  >,
): Effect.Effect<ModelSelection | undefined, E, R> =>
  model === undefined
    ? Effect.succeed(undefined)
    : capabilities(model.model).pipe(
        Effect.map((found) =>
          found.providers.some(
            (provider) =>
              provider.providerInstanceId === model.instanceId &&
              provider.models.some((candidate) => candidate.id === model.model),
          )
            ? model
            : undefined,
        ),
      );
