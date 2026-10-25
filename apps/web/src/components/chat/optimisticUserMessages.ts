import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import type { SetStateAction } from "react";
import type { ChatMessage } from "../../types";
import { collectUserMessageBlobPreviewUrls } from "../ChatView.logic";

/**
 * Messages shown before the server echoes them. An acknowledged message leaves `messages` in the
 * render its ack arrives, so it never reappears even if the server later drops its row. Its blob
 * previews stay in `handoff` until the server's copies load (see useAttachmentPreviewHandoff).
 */
export interface OptimisticUserMessages {
  readonly threadId: ThreadId;
  readonly messages: ChatMessage[];
  readonly handoff: Readonly<Record<string, ReadonlyArray<string>>>;
}

export function emptyOptimisticUserMessages(threadId: ThreadId): OptimisticUserMessages {
  return { threadId, messages: [], handoff: {} };
}

/**
 * The view's state for `threadId`: the previous thread's messages are released when the thread
 * changes, and acknowledged messages are moved out of `messages`. Returns `state` when nothing changes.
 */
export function reconcileOptimisticUserMessages(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  acknowledgedIds: ReadonlySet<MessageId>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return emptyOptimisticUserMessages(threadId);
  if (!state.messages.some((message) => acknowledgedIds.has(message.id))) return state;
  const messages: ChatMessage[] = [];
  const handoff: Record<string, ReadonlyArray<string>> = { ...state.handoff };
  for (const message of state.messages) {
    if (!acknowledgedIds.has(message.id)) {
      messages.push(message);
      continue;
    }
    const previewUrls = collectUserMessageBlobPreviewUrls(message);
    if (previewUrls.length > 0) handoff[message.id] = previewUrls;
  }
  return { ...state, messages, handoff };
}

/** Applies a send-path update. An update for a thread the view has since left is dropped. */
export function applyOptimisticUserMessagesAction(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  action: SetStateAction<ChatMessage[]>,
): OptimisticUserMessages {
  if (state.threadId !== threadId) return state;
  const next = typeof action === "function" ? action(state.messages) : action;
  const unchanged =
    next.length === state.messages.length &&
    next.every((message, index) => message === state.messages[index]);
  return unchanged ? state : { ...state, messages: next };
}

export function dropOptimisticHandoff(
  state: OptimisticUserMessages,
  threadId: ThreadId,
  messageId: MessageId,
): OptimisticUserMessages {
  if (state.threadId !== threadId || !(messageId in state.handoff)) return state;
  const { [messageId]: _released, ...handoff } = state.handoff;
  return { ...state, handoff };
}

/**
 * The blob previews a chat view took from the composer for its optimistic messages, per thread.
 * Revocation cannot run inside a state updater, so the handlers that end a preview's use revoke it
 * here, and leaving the thread revokes whatever that thread still owns.
 */
export interface OptimisticBlobPreviews {
  readonly track: (threadId: ThreadId, message: ChatMessage) => void;
  readonly revoke: (threadId: ThreadId, previewUrls: ReadonlyArray<string>) => void;
  readonly release: (threadId: ThreadId, message: ChatMessage) => void;
  readonly revokeThread: (threadId: ThreadId) => void;
}

export function createOptimisticBlobPreviews(): OptimisticBlobPreviews {
  const ownedByThread = new Map<ThreadId, Set<string>>();
  const revoke = (threadId: ThreadId, previewUrls: ReadonlyArray<string>) => {
    const owned = ownedByThread.get(threadId);
    for (const previewUrl of previewUrls) {
      owned?.delete(previewUrl);
      if (typeof URL !== "undefined") URL.revokeObjectURL(previewUrl);
    }
  };
  return {
    track: (threadId, message) => {
      const previewUrls = collectUserMessageBlobPreviewUrls(message);
      if (previewUrls.length === 0) return;
      const owned = ownedByThread.get(threadId) ?? new Set<string>();
      for (const previewUrl of previewUrls) owned.add(previewUrl);
      ownedByThread.set(threadId, owned);
    },
    revoke,
    release: (threadId, message) => revoke(threadId, collectUserMessageBlobPreviewUrls(message)),
    revokeThread: (threadId) => {
      revoke(threadId, [...(ownedByThread.get(threadId) ?? [])]);
      ownedByThread.delete(threadId);
    },
  };
}

class ImagePreloadError extends Schema.TaggedError<ImagePreloadError>()("ImagePreloadError", {
  url: Schema.String,
}) {}

const preloadImage = (url: string) =>
  Effect.callback<void, ImagePreloadError>((resume) => {
    const image = new Image();
    image.addEventListener("load", () => resume(Effect.void), { once: true });
    image.addEventListener("error", () => resume(Effect.fail(new ImagePreloadError({ url }))), {
      once: true,
    });
    image.src = url;
    return Effect.sync(() => {
      image.src = "";
    });
  });

/**
 * Loads one handoff's server previews, keyed by `[serverUrls, blobUrls]`. Once they have all
 * loaded the blobs are no longer shown, so they are revoked here, once per load. A failed load
 * keeps the handoff, and its blobs, until the thread is left.
 */
const handoffPreloadAtom = Atom.family((key: string) => {
  const [serverUrls, blobUrls] = JSON.parse(key) as [string[], string[]];
  return Atom.make(
    typeof Image === "undefined"
      ? Effect.never
      : Effect.forEach(serverUrls, preloadImage, { concurrency: "unbounded", discard: true }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              for (const blobUrl of blobUrls) URL.revokeObjectURL(blobUrl);
            }),
          ),
        ),
  );
});

/**
 * The message ids, among `[messageId, serverUrls, blobUrls]` entries, whose server previews have
 * loaded. Each handoff preloads in its own atom, so a change to the set does not restart the rest.
 */
export const loadedHandoffMessageIdsAtom = Atom.family((key: string) => {
  const preloads = JSON.parse(key) as Array<[MessageId, string[], string[]]>;
  return Atom.make((get) =>
    preloads.flatMap(([messageId, serverUrls, blobUrls]) =>
      AsyncResult.isSuccess(get(handoffPreloadAtom(JSON.stringify([serverUrls, blobUrls]))))
        ? [messageId]
        : [],
    ),
  );
});
