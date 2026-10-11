import type { OpenCodeClient } from "@opencode/client/effect";
import type { OpenCodeEvent } from "@opencode/protocol/groups/event";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Sse from "effect/encoding/Sse";
import type * as HttpClientError from "effect/http/HttpClientError";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
export interface OpenCode2UnreadableTerminal {
  readonly type: "unreadable.execution.ended";
  readonly executionType:
    | "session.execution.succeeded"
    | "session.execution.failed"
    | "session.execution.interrupted";
  readonly sessionID: string;
}

/**
 * A session's execution started, but this build could not decode the event.
 * It marks where a new execution begins and never ends a turn.
 */
export interface OpenCode2UnreadableStart {
  readonly type: "unreadable.execution.started";
  readonly sessionID: string;
}

export class OpenCode2SilentStreamError extends Schema.TaggedError<OpenCode2SilentStreamError>()(
  "OpenCode2SilentStreamError",
  {},
) {
  override get message(): string {
    return "The OpenCode server stopped sending events.";
  }
}

export type OpenCode2StreamEvent =
  | OpenCodeEvent
  | OpenCode2UnreadableTerminal
  | OpenCode2UnreadableStart;

export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  readonly events: Effect.Effect<
    Stream.Stream<
      OpenCode2StreamEvent,
      HttpClientError.HttpClientError | Sse.Retry | Sse.SseError | OpenCode2SilentStreamError
    >,
    HttpClientError.HttpClientError
  >;
}

export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: string | Redacted.Redacted;
    }) => Effect.Effect<OpenCode2Api>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Client") {}
export const make = Effect.gen(function* () {
  const context = yield* Effect.context<
    Effect.Services<typeof import("./OpenCode2ClientLive.ts").make> | Scope.Scope
  >();
  // A failed load is not kept, so the next connect retries it.
  const live = yield* Effect.cachedWithTTL(
    Effect.promise(() => import("./OpenCode2ClientLive.ts")).pipe(
      Effect.flatMap((module) => module.make),
      Effect.provideContext(context),
    ),
    (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
  );
  return OpenCode2Client.of({
    connect: (input) => live.pipe(Effect.flatMap((value) => value.connect(input))),
  });
});
export const layer = Layer.effect(OpenCode2Client, make);

/**
 * Streams every item of a cursor-paged OpenCode 2 list. The first request
 * carries the caller's input (including `order`); later requests send only
 * the cursor, because OpenCode rejects a cursor combined with `order`.
 */
export const paginate = <Input extends { readonly cursor?: unknown }, Item, E, R>(
  input: Input,
  list: (
    input: Input,
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<Item>; readonly cursor: { readonly next?: Input["cursor"] } },
    E,
    R
  >,
): Stream.Stream<Item, E, R> =>
  Stream.paginate(input, (request) =>
    list(request).pipe(
      Effect.map(
        (page) =>
          [
            page.data,
            page.data.length === 0 || page.cursor.next === undefined
              ? Option.none()
              : Option.some({ ...request, order: undefined, cursor: page.cursor.next }),
          ] as const,
      ),
    ),
  );
