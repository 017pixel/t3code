import { assert, it } from "@effect/vitest";
import { Session } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import * as OpenCode2Client from "./OpenCode2Client.ts";

const INFO_BODY = '{"version":"2.0.18","pid":4242,"urls":[],"paths":{"tmp":"/tmp"}}';

const authorizationFor = (password: string | Redacted.Redacted) => {
  const seen: Array<string | undefined> = [];
  const layerCapturing = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        seen.push(request.headers.authorization);
        return HttpClientResponse.fromWeb(
          request,
          new Response(INFO_BODY, { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  return Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({ baseUrl: "http://127.0.0.1:4096", password });
    yield* client.server.info();
    return seen[0];
  }).pipe(Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerCapturing))));
};

const utf8Basic = (password: string) =>
  `Basic ${Buffer.from(`opencode:${password}`, "utf8").toString("base64")}`;

describe("OpenCode2Client authorization", () => {
  // OpenCode decodes Basic credentials as UTF-8. Latin-1 (`btoa`) encoding gets
  // `pässwörd` rejected with a 401 and throws on characters such as `€`.
  it.effect("encodes non-ASCII passwords as UTF-8", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* authorizationFor("pässwörd"), utf8Basic("pässwörd"));
      assert.strictEqual(yield* authorizationFor("pass€word"), utf8Basic("pass€word"));
      assert.strictEqual(yield* authorizationFor(Redacted.make("pässwörd")), utf8Basic("pässwörd"));
    }),
  );
});

describe("OpenCode2Client message history", () => {
  it.effect.each([
    { status: "running", recentLocation: "metadata" },
    { status: "completed", recentLocation: "metadata" },
    { status: "running", recentLocation: "top-level" },
    { status: "completed", recentLocation: "top-level" },
  ] as const)(
    "decodes $status compaction with $recentLocation recent",
    ({ status, recentLocation }) =>
      Effect.gen(function* () {
        const previous = {
          id: "msg_repro088",
          type: "synthetic",
          text: "Fixture message 88",
          time: { created: 1088 },
        };
        const compaction = {
          type: "compaction",
          id: "msg_repro089",
          time: { created: 1089 },
          status,
          reason: "manual",
          summary: "Fixture compaction",
          ...(recentLocation === "metadata"
            ? { metadata: { recent: previous.id } }
            : { recent: previous.id }),
        };
        const transport = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              assert.include(request.url, "/api/session/ses_repro/message");
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify({ data: [previous, compaction], cursor: {} }), {
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        );
        const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
          Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
        );
        const { client } = yield* opencode.connect({
          baseUrl: "http://127.0.0.1:4096",
          password: "test-password",
        });
        const history = yield* client.message.list({
          sessionID: Session.ID.make("ses_repro"),
          order: "asc",
        });

        assert.deepStrictEqual(
          history.data.map((message) => message.id),
          [previous.id, compaction.id],
        );
        assert.deepInclude(history.data[1], {
          type: "compaction",
          status,
          summary: compaction.summary,
        });
      }),
  );

  it.effect("keeps a compaction without any recent an error", () =>
    Effect.gen(function* () {
      const compaction = {
        type: "compaction",
        id: "msg_repro089",
        time: { created: 1089 },
        status: "completed",
        reason: "manual",
        summary: "Fixture compaction",
        metadata: {},
      };
      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ data: [compaction], cursor: {} }), {
                headers: { "content-type": "application/json" },
              }),
            ),
          ),
        ),
      );
      const opencode = yield* OpenCode2Client.OpenCode2Client.pipe(
        Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(transport))),
      );
      const { client } = yield* opencode.connect({
        baseUrl: "http://127.0.0.1:4096",
        password: "test-password",
      });
      const error = yield* client.message
        .list({ sessionID: Session.ID.make("ses_repro"), order: "asc" })
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "ClientError");
      assert.isTrue(Schema.isSchemaError(error.cause));
      assert.include(String(error.cause), "recent");
    }),
  );
});
