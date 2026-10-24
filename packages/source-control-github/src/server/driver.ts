import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { definition } from "../shared/definition.ts";

import * as GitHubMediaFetch from "./gitHubMediaFetch.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

// `GitHubRest.layerWithDependencies` carries the quota reserve every GitHub reader shares, so it
// must be built once; the driver is.
const services = GitHubPullRequestApi.layer.pipe(
  Layer.provideMerge(GitHubRest.layerWithDependencies),
);

const makeInstance = Effect.all({
  sourceControl: GitHubSourceControlProvider.make,
  discovery: GitHubSourceControlProvider.makeDiscovery,
  pullRequests: GitHubPullRequestProvider.make,
  fetchMedia: GitHubMediaFetch.make,
});

const isRateLimit = Schema.is(GitHubRequestPolicy.GitHubApiRateLimitError);

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
  rateLimitRefusal: (error) =>
    isRateLimit(error)
      ? error.retryAt === undefined
        ? {}
        : { retryAt: error.retryAt }
      : undefined,
});
