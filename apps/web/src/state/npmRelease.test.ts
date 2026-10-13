import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { checkNpmReleasePublished } from "./npmRelease";

const VERSION = "0.0.46-nightly.20261013.3042";

// Acts like a browser talking to registry.npmjs.org: a simple GET succeeds,
// but any non-safelisted header forces a preflight the registry rejects.
const registryFetch: typeof globalThis.fetch = async (_url, init) => {
  const headers = new Headers(init?.headers);
  if (headers.has("traceparent") || headers.has("b3")) {
    throw new TypeError("Failed to fetch");
  }
  return Response.json({ version: VERSION });
};

const RegistryHttpClient = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.Fetch, registryFetch)),
);

describe("checkNpmReleasePublished", () => {
  it.effect("sends a request the registry accepts from a browser", () =>
    Effect.gen(function* () {
      expect(yield* checkNpmReleasePublished(VERSION)).toBe(true);
    }).pipe(Effect.provide(RegistryHttpClient)),
  );
});
