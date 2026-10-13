import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Whether `t3@<version>` is published on npm. A 404 is false; network and
 * registry errors fail, and callers treat that as unknown.
 *
 * Trace propagation stays off: its `b3` and `traceparent` headers turn this
 * into a CORS preflight, which the registry rejects, so browsers could never
 * complete the check.
 */
export const checkNpmReleasePublished = (version: string) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(
      `https://registry.npmjs.org/t3/${encodeURIComponent(version)}`,
    );
    if (response.status === 404) return false;
    const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
      Effect.flatMap((ok) => ok.json),
    );
    return typeof body === "object" && body !== null && "version" in body
      ? body.version === version
      : false;
  }).pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));

/** Re-checks every few minutes, so a release that lands later shows up
    without a reload. */
const npmReleasePublishedAtom = Atom.family((version: string) =>
  Atom.make(checkNpmReleasePublished(version).pipe(Effect.provide(FetchHttpClient.layer))).pipe(
    Atom.withRefresh("5 minutes"),
    Atom.keepAlive,
    Atom.withLabel(`npm-release-published:${version}`),
  ),
);

const NO_VERSION_ATOM = Atom.make(AsyncResult.success(false)).pipe(
  Atom.withLabel("npm-release-published:none"),
);

/** True only once npm confirms the version, so callers can hide work that
    would download it until then. */
export function useNpmReleasePublished(version: string | null): boolean {
  const result = useAtomValue(version ? npmReleasePublishedAtom(version) : NO_VERSION_ATOM);
  return AsyncResult.getOrElse(result, () => false);
}
