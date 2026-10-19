import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type ExecutionEnvironmentDescriptor, OrchestratorMcpFailure } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PeerLinks from "./PeerLinks.ts";
import { descriptorOf, servePeer } from "./PeerLinks.testkit.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/** What B's probe saw: the calling client and the modes it may start work with. */
const Probe = Schema.Struct({ caller: Schema.String, modes: Schema.String });
const ProbeToolkit = Toolkit.make(
  Tool.make("probe", {
    description: "Reports the calling client and the modes it may start work with.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [McpInvocationContext.McpInvocationContext],
  }),
  Tool.make("refuse", {
    description: "Always refuses.",
    success: Probe,
    failure: OrchestratorMcpFailure,
    failureMode: "return",
  }),
);

const serveB = (initial: ExecutionEnvironmentDescriptor) =>
  servePeer(
    initial,
    McpHttpServer.toolkitRegistration(
      ProbeToolkit,
      McpToolAccess.toLayer(ProbeToolkit, {
        probe: McpToolAccess.reads(() =>
          McpInvocationContext.McpInvocationContext.pipe(
            Effect.map((scope) => {
              const modes = McpInvocationContext.clientModeCeiling(scope.client);
              return {
                caller: scope.client?.label ?? "none",
                modes: `${modes.runtimeMode}/${modes.interactionMode}`,
              };
            }),
          ),
        ),
        refuse: McpToolAccess.reads(() =>
          Effect.fail(
            new OrchestratorMcpFailure({
              code: "thread_not_found",
              message: "No such thread.",
            }),
          ),
        ),
      }),
    ),
  );

/** Environment A: its own database and secret store, reaching B over plain HTTP. */
const makeA = (
  descriptor: ExecutionEnvironmentDescriptor,
  afterSecretWrite: Effect.Effect<void> = Effect.void,
  beforeSecretRemove: Effect.Effect<void, ServerSecretStore.SecretStoreError> = Effect.void,
) =>
  Effect.gen(function* () {
    const secretReads = yield* Ref.make(0);
    const layerSecrets = Layer.effect(
      ServerSecretStore.ServerSecretStore,
      Effect.gen(function* () {
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        return ServerSecretStore.ServerSecretStore.of({
          ...secrets,
          set: (name, value) => secrets.set(name, value).pipe(Effect.andThen(afterSecretWrite)),
          remove: (name) => beforeSecretRemove.pipe(Effect.andThen(secrets.remove(name))),
          get: (name) =>
            Ref.update(secretReads, (count) => count + 1).pipe(Effect.andThen(secrets.get(name))),
        });
      }),
    ).pipe(Layer.provide(ServerSecretStore.layer));
    const context = yield* PeerMcpClient.layer.pipe(
      Layer.provideMerge(PeerLinks.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Sqlite.layerMemory,
          layerSecrets,
          FetchHttpClient.layer,
          Layer.succeed(ServerEnvironment.ServerEnvironment, {
            getEnvironmentId: Effect.succeed(descriptor.environmentId),
            getDescriptor: Effect.succeed(descriptor),
          }),
        ),
      ),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-peer-link-a-" })),
      Layer.provide(NodeServices.layer),
      Layer.fresh,
      Layer.build,
    );
    const secrets = Context.get(context, ServerSecretStore.ServerSecretStore);
    const fileSystem = yield* FileSystem.FileSystem;
    return {
      secretReads,
      sql: Context.get(context, SqlClient.SqlClient),
      secretNames: fileSystem
        .readDirectory(secrets.directory!)
        .pipe(Effect.map((names) => names.sort())),
      links: Context.get(context, PeerLinks.PeerLinks),
      peer: Context.get(context, PeerMcpClient.PeerMcpClient),
    };
  });

const laptop = descriptorOf("environment-laptop", "Laptop");
const box = descriptorOf("environment-box", "Box");
const probe = (
  a: Effect.Success<ReturnType<typeof makeA>>,
  limits: PeerMcpClient.PeerCallLimits = { runtimeMode: "full-access", interactionMode: "default" },
  tool = "probe",
) =>
  a.peer.call({
    environmentId: box.environmentId,
    tool,
    arguments: {},
    limits,
    success: Probe,
  });

const linkedSessions = (b: Effect.Success<ReturnType<typeof serveB>>) =>
  b.auth
    .listSessions()
    .pipe(
      Effect.map((sessions) =>
        sessions.filter((session) => session.client.label?.startsWith("T3 Code · ")),
      ),
    );

it.effect("links, reads and forgets a peer while preserving access limits and refusals", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const removal = yield* Ref.make<"fail" | "pause" | null>(null);
      const removalEntered = yield* Deferred.make<void>();
      const allowRemoval = yield* Deferred.make<void>();
      const a = yield* makeA(
        laptop,
        Effect.void,
        Ref.get(removal).pipe(
          Effect.flatMap((action) =>
            action === "fail"
              ? Effect.fail(
                  new ServerSecretStore.SecretStoreRemoveError({
                    resource: "test credential",
                    cause: new Error("removal failed"),
                  }),
                )
              : action === "pause"
                ? Deferred.succeed(removalEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(allowRemoval)),
                  )
                : Effect.void,
          ),
        ),
      );

      const refused = yield* a.links
        .link({ url: b.url, pairingCode: "not-a-code", access: "auto" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("pairing_rejected");
      expect(yield* linkedSessions(b)).toEqual([]);

      const pairing = yield* b.auth.issuePairingCredential();
      const linked = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        access: "auto",
      });
      expect(linked).toMatchObject({
        environmentId: box.environmentId,
        label: "Box",
        urls: [b.url],
        access: "auto",
      });
      // B lists the link under A's name, where it can be revoked.
      expect((yield* linkedSessions(b)).map((session) => session.client.label)).toEqual([
        "T3 Code · Laptop",
      ]);
      expect(
        (yield* a.links.list).map(({ environmentId, status }) => [environmentId, status]),
      ).toEqual([[box.environmentId, "reachable"]]);

      yield* Ref.set(b.probes, 0);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.some(linked));
      expect(Option.isNone(yield* a.links.get(laptop.environmentId))).toBe(true);
      expect(yield* Ref.get(b.probes)).toBe(0);

      // The caller's limits narrow the link's access; they never widen it.
      expect(
        yield* probe(a, { runtimeMode: "approval-required", interactionMode: "plan" }),
      ).toEqual({ caller: "T3 Code · Laptop", modes: "approval-required/plan" });
      expect(yield* probe(a)).toEqual({ caller: "T3 Code · Laptop", modes: "auto/default" });

      // A refusal keeps the peer's reason.
      const notFound = yield* probe(a, undefined, "refuse").pipe(Effect.flip);
      expect(notFound).toMatchObject({ code: "thread_not_found", message: "No such thread." });

      const names = yield* a.secretNames;
      const beforeUnlink = yield* a.links.get(box.environmentId);
      yield* Ref.set(removal, "fail");
      expect((yield* a.links.unlink(box.environmentId).pipe(Effect.flip)).reason).toBe("storage");
      expect(yield* a.links.get(box.environmentId)).toEqual(beforeUnlink);
      expect(yield* a.secretNames).toEqual(names);
      expect(yield* probe(a)).toEqual({ caller: "T3 Code · Laptop", modes: "auto/default" });

      yield* Ref.set(removal, "pause");
      const unlinking = yield* a.links.unlink(box.environmentId).pipe(Effect.forkScoped);
      yield* Deferred.await(removalEntered);
      yield* Ref.set(removal, null);
      const newPairing = yield* b.auth.issuePairingCredential();
      const relinked = yield* a.links.link({
        url: b.url,
        pairingCode: newPairing.credential,
        access: "approval-required",
      });
      yield* Deferred.succeed(allowRemoval, undefined);
      expect(yield* Fiber.join(unlinking)).toBe(false);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.some(relinked));
      expect(yield* probe(a)).toEqual({
        caller: "T3 Code · Laptop",
        modes: "approval-required/default",
      });
      expect(yield* a.links.unlink(box.environmentId)).toBe(true);
      expect(yield* a.links.unlink(box.environmentId)).toBe(false);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.none());
      expect(yield* a.links.list).toEqual([]);
      expect(yield* a.secretNames).toEqual([]);
      yield* Ref.set(b.bearers, []);
      expect((yield* probe(a).pipe(Effect.flip)).code).toBe("invalid_request");
      expect(yield* Ref.get(b.bearers)).toHaveLength(0);
      expect(yield* linkedSessions(b)).toHaveLength(2);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("two links racing to one peer leave the stored access matching the token", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const firstStored = yield* Deferred.make<void>();
      const finishFirst = yield* Deferred.make<void>();
      const writes = yield* Ref.make(0);
      const a = yield* makeA(
        laptop,
        Effect.gen(function* () {
          const write = yield* Ref.updateAndGet(writes, (count) => count + 1);
          if (write === 1) {
            yield* Deferred.succeed(firstStored, undefined);
            yield* Deferred.await(finishFirst);
          }
        }),
      );
      const first = yield* b.auth.issuePairingCredential();
      const second = yield* b.auth.issuePairingCredential();
      const pending = yield* a.links
        .link({
          url: b.url,
          pairingCode: first.credential,
          access: "read-only",
        })
        .pipe(Effect.forkChild);
      // Let the full-access link commit between the other token write and row write.
      yield* Deferred.await(firstStored);
      yield* a.links.link({ url: b.url, pairingCode: second.credential, access: "full-access" });
      yield* Deferred.succeed(finishFirst, undefined);
      yield* Fiber.join(pending);
      const stored = yield* a.links.get(box.environmentId);
      expect(Option.map(stored, (link) => link.access)).toEqual(Option.some("read-only"));
      expect((yield* probe(a)).modes).toBe("approval-required/default");
      expect(yield* a.secretNames).toHaveLength(1);
      expect(yield* a.links.unlink(box.environmentId)).toBe(true);
      expect(yield* a.secretNames).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("never sends a bearer after the peer identity or mode capability changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      const alternateUrl = b.url.replace("127.0.0.1", "localhost");
      yield* a.links.link({
        url: b.url,
        alternateUrls: [alternateUrl],
        pairingCode: pairing.credential,
        access: "auto",
      });
      yield* probe(a);
      expect((yield* Ref.get(b.bearers)).length).toBeGreaterThan(0);

      const readsBefore = yield* Ref.get(a.secretReads);
      // The address now answers as another environment, as a reused LAN address would.
      yield* Ref.set(b.descriptor, descriptorOf("environment-impostor", "Impostor"));
      yield* Ref.set(b.alternateDescriptor, descriptorOf("environment-impostor", "Impostor"));
      yield* Ref.set(b.bearers, []);
      const failed = yield* probe(a).pipe(Effect.flip);
      expect(failed.message).toContain("Box did not answer");
      expect(yield* Ref.get(b.bearers)).toHaveLength(0);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["unreachable"]);

      yield* Ref.set(
        b.descriptor,
        descriptorOf("environment-box", "Box", { mcpModeLimitHeader: false }),
      );
      yield* Ref.set(b.alternateDescriptor, yield* Ref.get(b.descriptor));
      const probesBefore = yield* Ref.get(b.probes);
      const downgraded = yield* probe(a, {
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }).pipe(Effect.exit);
      expect(yield* Ref.get(b.bearers)).toHaveLength(0);
      expect(Exit.isFailure(downgraded)).toBe(true);
      expect(yield* Ref.get(a.secretReads)).toBe(readsBefore);
      expect(yield* Ref.get(b.probes)).toBe(probesBefore + 2);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["incompatible"]);
      expect((yield* a.links.get(box.environmentId)).pipe(Option.getOrThrow).lastError).toContain(
        "limits",
      );

      yield* Ref.set(b.alternateDescriptor, box);
      const beforeFallback = yield* Ref.get(b.probes);
      expect((yield* a.links.resolve(box.environmentId)).url).toBe(alternateUrl);
      expect(yield* Ref.get(b.probes)).toBe(beforeFallback + 2);
      expect(yield* Ref.get(a.secretReads)).toBe(readsBefore + 1);
      expect(
        yield* probe(a, { runtimeMode: "approval-required", interactionMode: "plan" }),
      ).toEqual({ caller: "T3 Code · Laptop", modes: "approval-required/plan" });
      expect(yield* Ref.get(b.probes)).toBe(beforeFallback + 4);
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["reachable"]);
      expect(yield* Ref.get(b.probes)).toBe(beforeFallback + 6);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("tells the agent to link again once the peer revokes the link or it expires", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
      yield* probe(a);

      const [session] = yield* linkedSessions(b);
      yield* b.auth.revokeSession(session!.sessionId);
      const revoked = yield* probe(a).pipe(Effect.flip);
      expect(revoked.code).toBe("capability_denied");
      expect(revoked.message).toContain("revoked there");

      yield* TestClock.adjust(Duration.days(31));
      expect((yield* a.links.list).map((link) => link.status)).toEqual(["expired"]);
      yield* Ref.set(b.bearers, []);
      const expired = yield* probe(a).pipe(Effect.flip);
      expect(expired.code).toBe("capability_denied");
      expect(expired.message).toContain("expired");
      expect(yield* Ref.get(b.bearers)).toHaveLength(0);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect(
  "refuses to link itself, plain http off this machine and the tailnet, or a peer that cannot hold a linked agent to its limits",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(
          descriptorOf("environment-box", "Box", { mcpModeLimitHeader: false }),
        );
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        const older = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential, access: "auto" })
          .pipe(Effect.flip);
        expect(older.reason).toBe("incompatible");

        // Plain http to a LAN address would carry the code and token in clear.
        const lan = yield* a.links
          .link({
            url: "http://192.168.1.20:3773",
            pairingCode: pairing.credential,
            access: "auto",
          })
          .pipe(Effect.flip);
        expect(lan.message).toContain("plain http");
        const lanAlternate = yield* a.links
          .link({
            url: b.url,
            alternateUrls: ["http://192.168.1.20:3773"],
            pairingCode: pairing.credential,
            access: "auto",
          })
          .pipe(Effect.flip);
        expect(lanAlternate.message).toContain("plain http");

        for (const url of [
          "file://username:password@example.test/path?token=private",
          "http://username:password@192.168.1.20:3773/path?token=private",
        ]) {
          const invalid = yield* a.links
            .link({ url, pairingCode: "unused", access: "auto" })
            .pipe(Effect.flip);
          expect(invalid.message).not.toMatch(/username|password|private|example\.test/);
        }
        yield* Ref.set(b.descriptor, box);
        const peerText = "PRIVATE-PEER-RESPONSE\n".repeat(200);
        for (const [path, body, message] of [
          [
            "/oauth/mcp/register",
            { error: "invalid_client_metadata", error_description: peerText },
            "The peer refused to register this environment. Check its connection settings.",
          ],
          [
            "/oauth/mcp/decision",
            { _tag: "AuthMcpApprovalError", message: peerText },
            "The peer refused link approval. Check the pairing code and try again.",
          ],
          [
            "/oauth/mcp/token",
            { error: "invalid_grant", error_description: peerText },
            "The peer refused the sign-in token. Create a new pairing code and try again.",
          ],
          [
            "/oauth/mcp/decision",
            { redirectTo: "http://localhost/?error_description=" + encodeURIComponent(peerText) },
            "The peer did not approve the link. Check the pairing code and try again.",
          ],
        ] as const) {
          yield* Ref.set(
            b.replies,
            new Map([[path, { status: "redirectTo" in body ? 200 : 400, body }]]),
          );
          const code = yield* b.auth.issuePairingCredential();
          const failed = yield* a.links
            .link({ url: b.url, pairingCode: code.credential, access: "auto" })
            .pipe(Effect.flip);
          expect(failed.reason).toBe("pairing_rejected");
          expect(failed.message).toBe(message);
        }
        yield* Ref.set(b.replies, new Map());
        yield* Ref.set(b.descriptor, laptop);
        const self = yield* a.links
          .link({ url: b.url, pairingCode: pairing.credential, access: "auto" })
          .pipe(Effect.flip);
        expect(self.reason).toBe("self");
        // Neither attempt spent the pairing code on a session.
        expect(yield* linkedSessions(b)).toEqual([]);
      }),
    ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect(
  "decodes structured MCP results with display text and rejects invalid result shapes",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const b = yield* serveB(box);
        const a = yield* makeA(laptop);
        const pairing = yield* b.auth.issuePairingCredential();
        yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
        const result = { caller: "T3 Code · Laptop", modes: "auto/default" };
        yield* Ref.set(
          b.toolResult,
          new McpSchema.CallToolResult({
            content: [{ type: "text", text: JSON.stringify(result) }],
          }),
        );
        expect(yield* probe(a)).toEqual(result);
        yield* Ref.set(
          b.toolResult,
          new McpSchema.CallToolResult({
            structuredContent: result,
            content: [
              { type: "text", text: JSON.stringify({ url: "https://example.com" }) },
              { type: "text", text: "Snapshot text for the user." },
            ],
          }),
        );
        expect(yield* probe(a)).toEqual(result);
        yield* Ref.set(b.sse, true);
        expect(yield* probe(a)).toEqual(result);

        yield* Ref.set(
          b.toolResult,
          new McpSchema.CallToolResult({
            structuredContent: { caller: 123, modes: "auto/default" },
            content: [{ type: "text", text: JSON.stringify(result) }],
          }),
        );
        expect((yield* probe(a).pipe(Effect.flip)).code).toBe("orchestration_error");
        yield* Ref.set(
          b.toolResult,
          new McpSchema.CallToolResult({
            isError: true,
            structuredContent: { code: "thread_not_found", message: "No such thread." },
            content: [{ type: "text", text: "Display-only refusal text." }],
          }),
        );
        expect((yield* probe(a).pipe(Effect.flip)).code).toBe("thread_not_found");
      }),
    ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("failed and cancelled relinks preserve the previous link and credential", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const written = yield* Deferred.make<void>();
      let pause = false;
      const a = yield* makeA(
        laptop,
        Effect.suspend(() =>
          pause
            ? Deferred.succeed(written, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
        ),
      );
      const pairing = yield* b.auth.issuePairingCredential();
      const linked = yield* a.links.link({
        url: b.url,
        pairingCode: pairing.credential,
        access: "read-only",
      });
      const secretsBefore = yield* a.secretNames;
      pause = true;
      const cancelledPairing = yield* b.auth.issuePairingCredential();
      const pending = yield* a.links
        .link({
          url: b.url,
          pairingCode: cancelledPairing.credential,
          access: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(written);
      yield* Fiber.interrupt(pending);
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.some(linked));
      expect(yield* a.secretNames).toEqual(secretsBefore);
      pause = false;
      yield* a.sql`CREATE TRIGGER reject_peer_link BEFORE INSERT ON peer_environment_links
      BEGIN SELECT RAISE(FAIL, 'test persistence failure'); END`;
      const replacement = yield* b.auth.issuePairingCredential();
      const failed = yield* a.links
        .link({ url: b.url, pairingCode: replacement.credential, access: "full-access" })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("storage");
      expect(yield* a.links.get(box.environmentId)).toEqual(Option.some(linked));
      expect((yield* probe(a)).modes).toBe("approval-required/default");
      expect(yield* a.secretNames).toEqual(secretsBefore);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);

it.effect("does not follow descriptor, OAuth or authenticated MCP redirects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const b = yield* serveB(box);
      const a = yield* makeA(laptop);
      const pairing = yield* b.auth.issuePairingCredential();
      const target = b.url.replace("127.0.0.1", "localhost") + "/redirect-target";
      yield* Ref.set(b.redirects, new Map([["/oauth/mcp/decision", target]]));
      const linked = yield* a.links
        .link({
          url: b.url,
          pairingCode: pairing.credential,
          access: "auto",
        })
        .pipe(Effect.exit);
      expect(Exit.isFailure(linked)).toBe(true);
      expect(
        (yield* Ref.get(b.redirectedBodies)).some((body) => body.includes(pairing.credential)),
      ).toBe(false);
      expect(yield* a.links.list).toEqual([]);
      expect(yield* Ref.get(b.redirectedBodies)).toEqual([]);
      yield* Ref.set(b.redirects, new Map([["/.well-known/t3/environment", target]]));
      expect(
        (yield* a.links
          .link({
            url: b.url,
            pairingCode: pairing.credential,
            access: "auto",
          })
          .pipe(Effect.flip)).reason,
      ).toBe("not_a_t3_environment");
      expect(yield* Ref.get(b.redirectedBodies)).toEqual([]);
      yield* Ref.set(b.redirects, new Map());
      yield* a.links.link({ url: b.url, pairingCode: pairing.credential, access: "auto" });
      yield* Ref.set(b.redirects, new Map([["/mcp", target]]));
      expect((yield* probe(a).pipe(Effect.flip)).code).toBe("orchestration_error");
      expect(yield* Ref.get(b.redirectedBodies)).toEqual([]);
    }),
  ).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);
