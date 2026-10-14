import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadShell,
  OrchestrationV2AppThreadJson,
  ThreadPullRequestStack,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Keep badge, search and settlement fields; PR views read canonical snapshots. */
export const compactThreadPullRequests = (
  thread: OrchestrationV2AppThread,
): OrchestrationV2AppThread => {
  const links = thread.pullRequests;
  if (links === undefined) return thread;
  return {
    ...thread,
    pullRequests: links.map((link) => ({
      ...link,
      snapshot:
        link.snapshot === null
          ? null
          : {
              state: link.snapshot.state,
              title: link.snapshot.title,
              headBranch: link.snapshot.headBranch,
              baseBranch: link.snapshot.baseBranch,
              isDraft: link.snapshot.isDraft,
              updatedAt: link.snapshot.updatedAt,
              syncedAt: link.snapshot.syncedAt,
              ...(link.snapshot.mergedAt == null ? {} : { mergedAt: link.snapshot.mergedAt }),
              ...(link.snapshot.closedAt == null ? {} : { closedAt: link.snapshot.closedAt }),
            },
    })),
  };
};

// Store repeated stacks once without changing the public thread schema.
const ReadPayload = Schema.fromJsonString(
  Schema.Struct({
    thread: OrchestrationV2AppThreadJson,
    stacks: Schema.Array(ThreadPullRequestStack),
    stackIndices: Schema.Array(Schema.NullOr(Schema.Number)),
  }),
);

/** Preserve every stack vintage while sending identical layer lists only once. */
export const compactShellPullRequestStacks = (thread: OrchestrationV2ThreadShell) => {
  if (thread.pullRequests === undefined) return thread;
  const stacks = new Map<string, number>();
  return {
    ...thread,
    pullRequests: thread.pullRequests.map((link, index) => {
      if (link.stack === null) return link;
      const key = JSON.stringify(link.stack);
      const reference = stacks.get(key);
      if (reference !== undefined) return { ...link, stack: null, stackReference: reference };
      stacks.set(key, index);
      return link;
    }),
  };
};

/** HTTP clients opt in; whole-list equality preserves link dates, watches and stack vintages. */
export const deduplicateShellPullRequests = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
) => {
  const lists = new Map<string, number>();
  return threads.map((thread, index) => {
    if (!thread.pullRequests?.length) return thread;
    const key = JSON.stringify(thread.pullRequests);
    const reference = lists.get(key);
    if (reference === undefined) {
      lists.set(key, index);
      return thread;
    }
    const { pullRequests: _links, ...row } = thread;
    return { ...row, pullRequestReference: reference };
  });
};
const encode = Schema.encodeEffect(ReadPayload);
const decode = Schema.decodeUnknownEffect(ReadPayload);

export const encodeThreadReadPayload = (thread: OrchestrationV2AppThread) => {
  const stacks: Array<ThreadPullRequestStack> = [];
  const indices = new Map<string, number>();
  const stackIndices: Array<number | null> = [];
  const pullRequests = thread.pullRequests?.map((link) => {
    if (link.stack === null) {
      stackIndices.push(null);
      return link;
    }
    // Compare the whole stack, not its id: two links can have different sync vintages.
    const key = JSON.stringify(link.stack);
    let index = indices.get(key);
    if (index === undefined) {
      index = stacks.length;
      stacks.push(link.stack);
      indices.set(key, index);
    }
    stackIndices.push(index);
    return { ...link, stack: null };
  });
  return encode({
    thread: { ...thread, ...(pullRequests === undefined ? {} : { pullRequests }) },
    stacks,
    stackIndices,
  });
};

export const decodeThreadReadPayload = (payload: string) =>
  decode(payload).pipe(
    Effect.map(({ thread, stacks, stackIndices }) => ({
      ...thread,
      ...(thread.pullRequests === undefined
        ? {}
        : {
            pullRequests: thread.pullRequests.map((link, index) => ({
              ...link,
              stack: stackIndices[index] == null ? null : (stacks[stackIndices[index]!] ?? null),
            })),
          }),
    })),
  );
