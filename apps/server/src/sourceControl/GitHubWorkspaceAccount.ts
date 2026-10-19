import * as Effect from "effect/Effect";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const workspaceGitHubRepository = Effect.fn("GitHubWorkspaceAccount.repository")(function* (
  cwd: string,
) {
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const repository = yield* resolver.resolveGitHubRepository(cwd);
  return repository === null
    ? null
    : { host: repository.host, repository: `${repository.owner}/${repository.name}` };
});

export const workspaceGitHubCredential = Effect.fn("GitHubWorkspaceAccount.credential")(function* (
  cwd: string,
) {
  const workspace = yield* workspaceGitHubRepository(cwd);
  if (workspace === null) return null;
  const credentials = yield* GitHubCredentials.GitHubCredentials;
  return yield* credentials
    .get(workspace.host, workspace.repository)
    .pipe(Effect.orElseSucceed(() => null));
});
