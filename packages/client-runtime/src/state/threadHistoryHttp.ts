import {
  EnvironmentHttpApi,
  OrchestrationV2ThreadHistoryPage,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";

const DEFAULT_THREAD_HISTORY_TIMEOUT_MS = 6_000;

const HistoryEnvelope = OrchestrationV2ThreadHistoryPage.mapFields((fields) => ({
  ...fields,
  items: Schema.Array(Schema.Unknown),
}));
const decodeItems = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadHistoryPage.fields.items),
);

// Keep generated status/error decoding; only the success body defers item validation.
const historyEndpoint =
  EnvironmentHttpApi.groups.orchestration.endpoints.threadHistoryPage.annotateMerge(
    Context.empty(),
  );
Object.assign(historyEndpoint, { success: new Set([HistoryEnvelope]) });
const historyApi = EnvironmentHttpApi.add(
  EnvironmentHttpApi.groups.orchestration.add(historyEndpoint),
);

const yieldToHost = Effect.suspend(() =>
  typeof MessageChannel === "undefined"
    ? Effect.sleep("1 millis")
    : Effect.callback<void>((resume) => {
        const channel = new MessageChannel();
        const close = () => {
          channel.port1.close();
          channel.port2.close();
        };
        channel.port1.addEventListener(
          "message",
          () => {
            close();
            resume(Effect.void);
          },
          { once: true },
        );
        channel.port1.start();
        channel.port2.postMessage(null);
        return Effect.sync(close);
      }),
);

const decodeHistoryPage = Effect.fnUntraced(function* (page: typeof HistoryEnvelope.Type) {
  const items: OrchestrationV2ThreadHistoryPage["items"][number][] = [];
  let sliceStarted = performance.now();
  for (let offset = 0; offset < page.items.length; offset += 16) {
    if (performance.now() - sliceStarted >= 4) {
      yield* yieldToHost;
      sliceStarted = performance.now();
    }
    items.push(...(yield* decodeItems(page.items.slice(offset, offset + 16))));
  }
  return { ...page, items };
});

export const fetchEnvironmentThreadHistoryPage = Effect.fn(
  "clientRuntime.state.fetchEnvironmentThreadHistoryPage",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly cursor: string;
  readonly throughEntryId?: string | undefined;
  readonly view?: "conversation" | "activity" | undefined;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<RemoteEnvironmentAuthorization["Service"]>;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: {
      cursor: input.cursor,
      ...(input.view === undefined ? {} : { view: input.view }),
      ...(input.throughEntryId === undefined ? {} : { throughEntryId: input.throughEntryId }),
    },
  };
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    api: historyApi,
    method: "GET",
    url: (urls) => urls.threadHistoryPage(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_THREAD_HISTORY_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client
        .threadHistoryPage({ ...endpoint, headers: withOrchestrationProtocolHeader(headers) })
        .pipe(Effect.flatMap(decodeHistoryPage)),
  });
});
