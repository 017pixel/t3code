import * as Effect from "effect/Effect";

import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import { gitHubApiHostForRemote } from "@t3tools/source-control-github/server/gitHubRepositoryResolution";

import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";

const workspaceGitHubRepository = Effect.fn("GitHubWorkspaceAccount.repository")(function* (
  cwd: string,
) {
  const resolver = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const identity = yield* resolver.resolve(cwd);
  if (identity === null) return null;
  const host = gitHubApiHostForRemote(identity.locator.remoteUrl);
  const owner = identity.owner?.trim();
  const name = identity.name?.trim();
  return host === null || !owner || !name ? null : { host, repository: `${owner}/${name}` };
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
