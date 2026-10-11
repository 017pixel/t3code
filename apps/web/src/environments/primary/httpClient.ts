import { makeEnvironmentHttpApiGroupClient } from "@t3tools/client-runtime/rpc";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";

type PrimaryEnvironmentHttpApiClient = Effect.Success<typeof make>;

export interface PrimaryEnvironmentHttpClient {
  readonly PrimaryEnvironmentHttpClient: unique symbol;
}

export const PrimaryEnvironmentHttpClient: Context.Service<
  PrimaryEnvironmentHttpClient,
  PrimaryEnvironmentHttpApiClient
> = Context.Service("@t3tools/web/environments/primary/httpClient/PrimaryEnvironmentHttpClient");

// Primary HTTP uses only these groups. Building the whole API compiles codecs
// for orchestration, projects, pull requests and webhooks during the auth check.
const make = Effect.suspend(() => {
  const url = resolvePrimaryEnvironmentHttpUrl("/");
  return Effect.all({
    auth: makeEnvironmentHttpApiGroupClient(url, "auth"),
    metadata: makeEnvironmentHttpApiGroupClient(url, "metadata"),
    mcpOAuth: makeEnvironmentHttpApiGroupClient(url, "mcpOAuth"),
  });
});

export const layer = Layer.effect(PrimaryEnvironmentHttpClient, make);
