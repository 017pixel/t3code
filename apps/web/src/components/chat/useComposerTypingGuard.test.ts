import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { COMPOSER_TYPING_IDLE_MS } from "./composerTypingGuard";
import { composerTypingGuardHandlers, isRequestHeldByTypingGuard } from "./useComposerTypingGuard";

const pendingRequests = vi.hoisted(() => {
  const atoms = new Map<string, unknown>();
  return { atoms };
});

vi.mock("../../state/threads", () => ({
  environmentThreadDetails: {
    pendingRequestsAtom: (ref: ScopedThreadRef) => pendingRequestsAtomFor(ref),
  },
}));

function pendingRequestsAtomFor(ref: ScopedThreadRef) {
  const key = `${ref.environmentId}/${ref.threadId}`;
  let atom = pendingRequests.atoms.get(key) as
    | Atom.Writable<PendingThreadRequests | null>
    | undefined;
  if (!atom) {
    atom = Atom.make<PendingThreadRequests | null>(null).pipe(Atom.keepAlive);
    pendingRequests.atoms.set(key, atom);
  }
  return atom;
}

const environmentId = EnvironmentId.make("environment-1");
const threadA = { environmentId, threadId: ThreadId.make("thread-a") };
const threadB = { environmentId, threadId: ThreadId.make("thread-b") };

function askQuestion(threadRef: ScopedThreadRef, ...requestIds: string[]) {
  appAtomRegistry.set(pendingRequestsAtomFor(threadRef), {
    approvals: [],
    userInputs: requestIds.map((requestId) => ({
      requestId: RuntimeRequestId.make(requestId),
      createdAt: "2026-10-24T00:00:00.000Z",
      questions: [],
      responseCapability: "live" as const,
      dismissible: true,
    })),
  });
}

function setup(): Disposable {
  vi.useFakeTimers();
  for (const atom of pendingRequests.atoms.values()) {
    appAtomRegistry.set(atom as Atom.Writable<PendingThreadRequests | null>, null);
  }
  return {
    [Symbol.dispose]() {
      vi.useRealTimers();
    },
  };
}

describe("composer typing guard store", () => {
  it("holds a question that arrives mid-sentence until the user goes idle", () => {
    using _timers = setup();
    const guard = composerTypingGuardHandlers({}, "a", threadA);
    guard.onFocus();
    guard.onDraftChange();
    askQuestion(threadA, "question-1");
    expect(isRequestHeldByTypingGuard("question-1")).toBe(true);

    vi.advanceTimersByTime(COMPOSER_TYPING_IDLE_MS);
    expect(isRequestHeldByTypingGuard("question-1")).toBe(false);
    guard.onUnmount();
  });

  it("follows a focused composer that switches threads", () => {
    using _timers = setup();
    const owner = {};
    composerTypingGuardHandlers(owner, "a", threadA).onFocus();
    const onThreadB = composerTypingGuardHandlers(owner, "b", threadB);
    onThreadB.onDraftChange();

    askQuestion(threadA, "question-a");
    askQuestion(threadB, "question-b");
    expect(isRequestHeldByTypingGuard("question-a")).toBe(false);
    expect(isRequestHeldByTypingGuard("question-b")).toBe(true);
    onThreadB.onUnmount();
  });

  it("releases and stops watching when the focused composer unmounts", () => {
    using _timers = setup();
    const guard = composerTypingGuardHandlers({}, "a", threadA);
    const other = composerTypingGuardHandlers({}, "b", threadB);
    guard.onFocus();
    guard.onDraftChange();
    askQuestion(threadA, "question-1");

    // A composer that does not own the guard cannot release it.
    other.onUnmount();
    expect(isRequestHeldByTypingGuard("question-1")).toBe(true);

    guard.onUnmount();
    expect(isRequestHeldByTypingGuard("question-1")).toBe(false);
    guard.onDraftChange();
    askQuestion(threadA, "question-1", "question-2");
    expect(isRequestHeldByTypingGuard("question-2")).toBe(false);
  });
});
