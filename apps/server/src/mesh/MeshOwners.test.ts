import { EnvironmentId, type MeshMemberView, type MeshRoute } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Project from "../project/ProjectService.ts";
import * as MeshOwners from "./MeshOwners.ts";
import * as MeshTestkit from "./testkit.ts";

const SELF = EnvironmentId.make("env-self");
const MEMBER = EnvironmentId.make("env-member");
const DEAD_ROUTE: MeshRoute = { kind: "lan", httpBaseUrl: "http://192.0.2.1:3773/" };
const LIVE_ROUTE: MeshRoute = { kind: "tailnet", httpBaseUrl: "http://100.64.0.2:3773/" };

const memberView = (environmentId: EnvironmentId): MeshMemberView => ({
  environmentId,
  label: environmentId,
  machineKind: null,
  serverVersion: "1.0.0",
  online: true,
  capabilities: { meshMember: true, meshAgents: true },
  connectHostname: null,
  directEndpoints: [],
  captainEligible: false,
});

it.effect.each(["headers", "body"] as const)(
  "a member with stalled %s loses its route, so the next lookup walks again",
  (stalledAt) =>
    Effect.gen(function* () {
      const membership = yield* MeshTestkit.makeMembership({
        snapshot: {
          members: [memberView(SELF), memberView(MEMBER)],
          captain: null,
          pin: null,
          selfEnvironmentId: SELF,
        },
      });
      // The cached route, as MeshCredentials holds it: walking again finds the live one.
      const route = yield* Ref.make(DEAD_ROUTE);
      const asked = yield* Deferred.make<void>();
      const credentials = MeshTestkit.layerCredentials({
        session: (environmentId) =>
          Ref.get(route).pipe(
            Effect.map((current) => MeshTestkit.testSession(environmentId, current)),
          ),
        forgetRoute: () => Ref.set(route, LIVE_ROUTE),
        invalidate: () => Effect.die("the session still works"),
      });
      let requestSignal: AbortSignal | undefined;
      const httpClient = HttpClient.make((request, _url, signal) => {
        requestSignal = signal;
        return request.url.startsWith(DEAD_ROUTE.httpBaseUrl)
          ? stalledAt === "body"
            ? Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(new TextEncoder().encode('{"owns":'));
                        signal.addEventListener("abort", () =>
                          controller.error(new Error("aborted")),
                        );
                      },
                      pull() {
                        Deferred.doneUnsafe(asked, Effect.void);
                      },
                    }),
                  ),
                ),
              )
            : Deferred.succeed(asked, undefined).pipe(
                Effect.flatMap((first) =>
                  first ? Effect.never : Effect.die("asked on the dead route again"),
                ),
              )
          : Effect.succeed(
              HttpClientResponse.fromWeb(request, Response.json({ owns: true }, { status: 200 })),
            );
      });
      const owners = yield* MeshOwners.MeshOwners.pipe(
        Effect.provide(
          MeshOwners.layer.pipe(
            Layer.provide(membership.layer),
            Layer.provide(credentials),
            Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: () => Effect.succeed(null),
              }),
            ),
            Layer.provide(
              Layer.mock(Project.ProjectService)({ getById: () => Effect.succeedNone }),
            ),
          ),
        ),
      );
      const lookup = owners.resolve({ kind: "thread", id: "thread-1" });

      const first = yield* lookup.pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(asked);
      yield* TestClock.adjust("5 seconds");
      const missing = yield* Fiber.join(first);
      assert.isTrue(requestSignal?.aborted);
      assert.strictEqual(missing.code, "owner_not_found");
      assert.include(missing.message, `No answer from: ${MEMBER}.`);

      assert.deepStrictEqual(yield* lookup, {
        _tag: "remote",
        machine: { environmentId: MEMBER, label: MEMBER },
      });
    }),
);
