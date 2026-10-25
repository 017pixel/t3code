// EXPERIMENTAL mesh v1: how one member reaches another. Same order and head start as the client
// route walk (packages/client-runtime/src/connection/driver.ts), minus its fallback of trying a
// route that never answered: a credential only goes to an address that answered as the member.
import {
  EnvironmentId,
  type MeshMemberView,
  type MeshRoute,
  type MeshRouteKind,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

const ROUTE_CHECK_TIMEOUT = Duration.millis(2_500);
/** Shared by every route, so a LAN address the machine has left does not hold up the tunnel. */
export const ROUTE_CHECK_HEAD_START = Duration.millis(500);

const ROUTE_KIND_ORDER: Record<MeshRouteKind, number> = { lan: 0, tailnet: 1, tunnel: 2 };

/** The member's routes in the order tried: LAN, then tailnet, then its Connect tunnel. */
export const meshRouteCandidates = (member: MeshMemberView): ReadonlyArray<MeshRoute> =>
  [
    ...member.directEndpoints.map((endpoint): MeshRoute => ({
      kind: endpoint.kind,
      httpBaseUrl: endpoint.httpBaseUrl,
    })),
    ...(member.connectHostname === null
      ? []
      : [{ kind: "tunnel", httpBaseUrl: `https://${member.connectHostname}/` } as const]),
  ].toSorted((left, right) => ROUTE_KIND_ORDER[left.kind] - ROUTE_KIND_ORDER[right.kind]);

/** Resolves `path` against a route's base URL. */
export const meshRouteUrl = (route: MeshRoute, path: string): string =>
  new URL(path, route.httpBaseUrl).href;

/**
 * Picks the first route that answers as the member. Every check starts at once; a route counts
 * only if it answered within the shared head start, else it waits behind the others. Routes that
 * answer late are taken in order once the rest are done; a route that never answers is skipped.
 */
export const walkMeshRoutes = Effect.fn("MeshRoutes.walk")(function* (
  routes: ReadonlyArray<MeshRoute>,
  check: (route: MeshRoute) => Effect.Effect<boolean>,
) {
  const checks = yield* Effect.forEach(routes, (route) => Effect.forkChild(check(route)));
  const headStart = yield* Effect.forkChild(Effect.sleep(ROUTE_CHECK_HEAD_START));
  // Once the head start is over, the race can pick it over a check that already answered.
  const answeredAlready = (fiber: Fiber.Fiber<boolean>) =>
    Effect.sync(() => {
      const exit = fiber.pollUnsafe();
      return exit !== undefined && Exit.isSuccess(exit) && exit.value;
    });
  const late: Array<number> = [];
  for (const [index, route] of routes.entries()) {
    const fiber = checks[index]!;
    const answered =
      (yield* Effect.raceFirst(Fiber.join(fiber), Fiber.join(headStart).pipe(Effect.as(null)))) ??
      (yield* answeredAlready(fiber));
    if (answered) return Option.some(route);
    late.push(index);
  }
  for (const index of late) {
    if (yield* Fiber.join(checks[index]!)) return Option.some(routes[index]!);
  }
  return Option.none<MeshRoute>();
});

const DescriptorIdentity = Schema.Struct({ environmentId: EnvironmentId });

// A 3xx could send the next request, and its credential, somewhere else.
export const withoutRedirects = Effect.provideService(FetchHttpClient.RequestInit, {
  redirect: "manual",
});

/**
 * Whether `route` answers as `environmentId`. The descriptor is public, so the check sends no
 * credential to whatever listens at an address on a network this machine has left.
 */
export const checkMeshRoute = Effect.fn("MeshRoutes.check")(function* (
  route: MeshRoute,
  environmentId: EnvironmentId,
) {
  const httpClient = yield* HttpClient.HttpClient;
  yield* Effect.annotateCurrentSpan({ "mesh.route.kind": route.kind });
  return yield* httpClient.get(meshRouteUrl(route, "/.well-known/t3/environment")).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(DescriptorIdentity)),
    Effect.map((descriptor) => descriptor.environmentId === environmentId),
    Effect.timeoutOption(ROUTE_CHECK_TIMEOUT),
    Effect.map(Option.getOrElse(() => false)),
    Effect.orElseSucceed(() => false),
    withoutRedirects,
  );
});
