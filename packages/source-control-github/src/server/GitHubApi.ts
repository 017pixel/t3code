import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";

/**
 * A credential already verified for one host. Every request made under it must target that
 * host, so a page cannot read one account's data with another's token mid-flight. Server-local:
 * never put its value in RPC payloads or cache keys.
 */
export const PinnedGitHubCredential = Context.Reference<{
  readonly host: string;
  readonly token: Redacted.Redacted<string>;
  readonly credentialFingerprint: string;
} | null>("@t3tools/source-control-github/server/GitHubApi/PinnedGitHubCredential", {
  defaultValue: () => null,
});

export class GitHubApiRequestError extends Schema.TaggedError<GitHubApiRequestError>()(
  "GitHubApiRequestError",
  { host: Schema.String, operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not reach GitHub at ${this.host}.`;
  }
}

export class GitHubApiAuthenticationError extends Schema.TaggedError<GitHubApiAuthenticationError>()(
  "GitHubApiAuthenticationError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return `GitHub refused the credential for ${this.host}. Run \`gh auth login --hostname ${this.host}\` and retry.`;
  }
}

export class GitHubApiRateLimitError extends Schema.TaggedError<GitHubApiRateLimitError>()(
  "GitHubApiRateLimitError",
  {
    host: Schema.String,
    operation: Schema.String,
    retryAt: Schema.optionalKey(Schema.Finite),
  },
) {
  override get message(): string {
    return "GitHub API rate limit exceeded.";
  }
}

export class GitHubApiNotFoundError extends Schema.TaggedError<GitHubApiNotFoundError>()(
  "GitHubApiNotFoundError",
  { host: Schema.String, operation: Schema.String },
) {
  override get message(): string {
    return "GitHub could not find the requested resource, or the credential cannot see it.";
  }
}

/**
 * GitHub answered with a failure that is none of the above. `githubErrors` carries GitHub's own
 * error messages, from a GraphQL `errors` list or a REST `message`/`errors` body: they name the
 * field and the reason ("A pull request already exists for acme:feature"), never a token.
 */
export class GitHubApiResponseError extends Schema.TaggedError<GitHubApiResponseError>()(
  "GitHubApiResponseError",
  {
    host: Schema.String,
    operation: Schema.String,
    status: Schema.Int,
    githubErrors: Schema.optionalKey(Schema.Array(Schema.String)),
  },
) {
  override get message(): string {
    return this.githubErrors !== undefined && this.githubErrors.length > 0
      ? `GitHub returned an error: ${this.githubErrors.join("; ")}`
      : `GitHub returned HTTP ${this.status}.`;
  }
}

export type GitHubApiError =
  | GitHubCredentials.GitHubCredentialUnavailableError
  | GitHubApiRequestError
  | GitHubApiAuthenticationError
  | GitHubApiRateLimitError
  | GitHubApiNotFoundError
  | GitHubApiResponseError
  | SourceControlRateLimit.SourceControlRateLimitPausedError;

export interface GitHubRestResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
  readonly truncated: boolean;
  /** The body was not valid UTF-8, which a raw file read takes to mean binary. */
  readonly invalidUtf8: boolean;
}

export interface GitHubRestInput {
  readonly host: string;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Relative to the API root, e.g. `repos/acme/web/pulls/7`; query string included. */
  readonly path: string;
  readonly body?: unknown;
  /** Defaults to `application/vnd.github+json`. */
  readonly accept?: string;
  /** Revalidates a cached answer. A 304 is returned rather than failed, and is free. */
  readonly ifNoneMatch?: string;
  readonly maxResponseBytes?: number;
  /** Defaults to 30 seconds; a whole pull request's patch may need longer. */
  readonly timeout?: Duration.Input;
  /** Overrides `SourceControlRateLimit.Interactive` for this one request. */
  readonly allowReserve?: boolean;
}

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly allowReserve?: boolean;
  readonly maxResponseBytes?: number;
}

export class GitHubApi extends Context.Service<
  GitHubApi,
  {
    /** The raw JSON body of a successful GraphQL answer, with `rateLimit` recorded. */
    readonly graphql: (input: GitHubGraphQlInput) => Effect.Effect<string, GitHubApiError>;
    readonly rest: (input: GitHubRestInput) => Effect.Effect<GitHubRestResponse, GitHubApiError>;
    /** The credential a request to `host` would carry right now. */
    readonly credential: (
      host: string,
    ) => Effect.Effect<
      { readonly token: Redacted.Redacted<string>; readonly fingerprint: string },
      GitHubApiError
    >;
  }
>()("@t3tools/source-control-github/server/GitHubApi") {}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * Where the API for a host lives. github.com and GHE.com data residency serve it from an `api.`
 * subdomain; GitHub Enterprise Server serves it under `/api` on the instance itself.
 */
export function gitHubApiUrls(host: string): { readonly rest: string; readonly graphql: string } {
  const normalized = normalizeHost(host);
  if (normalized === "github.com") {
    return { rest: "https://api.github.com", graphql: "https://api.github.com/graphql" };
  }
  if (normalized.endsWith(".ghe.com")) {
    return {
      rest: `https://api.${normalized}`,
      graphql: `https://api.${normalized}/graphql`,
    };
  }
  return { rest: `https://${normalized}/api/v3`, graphql: `https://${normalized}/api/graphql` };
}

export const make = Effect.gen(function* () {
  const live = yield* cacheInOwnerScope(
    Effect.promise(() => import("./GitHubApiLive.ts")).pipe(
      Effect.flatMap((module) => module.make),
    ),
  );
  return GitHubApi.of({
    graphql: (input) => live.pipe(Effect.flatMap((value) => value.graphql(input))),
    rest: (input) => live.pipe(Effect.flatMap((value) => value.rest(input))),
    credential: (host) => live.pipe(Effect.flatMap((value) => value.credential(host))),
  });
});
export const layer = Layer.effect(GitHubApi, make);
/**
 * The transport with the credential, quota reserve and rate-limit pause it reads through. An
 * application builds this once so every GitHub reader shares one view of each quota per host.
 */
export const layerWithDependencies = layer.pipe(
  Layer.provideMerge(GitHubCredentials.layer),
  Layer.provideMerge(GitHubQuota.layer),
  Layer.provideMerge(SourceControlRateLimit.layer),
);
