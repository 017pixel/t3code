import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  EnvironmentId,
  RuntimeRequestId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { isRequestHeldByTypingGuard, useComposerTypingGuard } from "./useComposerTypingGuard";

const pendingRequests = vi.hoisted(() => ({ atoms: new Map<string, unknown>() }));

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

function askQuestion(threadRef: ScopedThreadRef, requestId: string) {
  appAtomRegistry.set(pendingRequestsAtomFor(threadRef), {
    approvals: [],
    userInputs: [
      {
        requestId: RuntimeRequestId.make(requestId),
        createdAt: "2026-10-24T00:00:00.000Z",
        questions: [],
        responseCapability: "live" as const,
        dismissible: true,
      },
    ],
  });
}

type Guard = ReturnType<typeof useComposerTypingGuard>;

// Mirrors ChatComposer: the form's ref cleanup releases the guard.
function Composer({
  threadRef,
  expose,
}: {
  threadRef: ScopedThreadRef;
  expose: (g: Guard) => void;
}) {
  const guard = useComposerTypingGuard(threadRef.threadId, threadRef);
  expose(guard);
  const { onUnmount } = guard;
  return <form ref={() => onUnmount} />;
}

describe("useComposerTypingGuard", () => {
  it("keeps holding requests when a focused composer switches threads", async () => {
    let guard: Guard | null = null;
    const expose = (next: Guard) => {
      guard = next;
    };
    await using screen = await render(<Composer threadRef={threadA} expose={expose} />);
    await act(() => {
      guard!.onFocus();
      guard!.onDraftChange();
    });

    await screen.rerender(<Composer threadRef={threadB} expose={expose} />);
    await act(() => {
      guard!.onDraftChange();
      askQuestion(threadB, "question-b");
    });

    expect(isRequestHeldByTypingGuard("question-b")).toBe(true);
    await act(() => guard!.onBlur());
  });
});
