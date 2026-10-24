import type { useClerk } from "@clerk/react";
import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";

type ClerkAuth = {
  status: ReturnType<typeof useClerk>["status"];
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
};

const testState = vi.hoisted(() => {
  const statusListeners = new Set<() => void>();
  return {
    auth: { status: "loading", isLoaded: false, isSignedIn: false, userId: null } as ClerkAuth,
    statusListeners,
    clerk: {
      get status() {
        return testState.auth.status;
      },
      on: (_event: "status", listener: () => void) => void statusListeners.add(listener),
      off: (_event: "status", listener: () => void) => void statusListeners.delete(listener),
    },
    getToken: async () => "clerk-token",
    removeRelayEnvironments: vi.fn(),
  };
});

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ ...testState.auth, getToken: testState.getToken })) as never,
  useClerk: (() => testState.clerk) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => testState.removeRelayEnvironments) as never,
}));
vi.mock(import("../lib/runtime"), async (original) => ({
  ...(await original()),
  runtime: { runPromiseExit: async () => Exit.void } as never,
}));
// The Clerk JWT template is build-time config the test environment does not set.
vi.mock(import("./publicConfig"), async (original) => ({
  ...(await original()),
  resolveRelayClerkTokenOptions: () => ({}) as never,
}));

import { ManagedRelayAuthProvider } from "./managedAuth";

const loading: ClerkAuth = { status: "loading", isLoaded: false, isSignedIn: false, userId: null };
const signedOut = (status: "ready" | "degraded"): ClerkAuth => ({
  status,
  isLoaded: true,
  isSignedIn: false,
  userId: null,
});
const signedInAs = (userId: string): ClerkAuth => ({
  status: "ready",
  isLoaded: true,
  isSignedIn: true,
  userId,
});

async function mountAuth(
  states: ReadonlyArray<ClerkAuth>,
  cleanup: Promise<AsyncResult.AsyncResult<void, never>> = Promise.resolve(
    AsyncResult.success(undefined),
  ),
) {
  testState.removeRelayEnvironments.mockReset().mockReturnValue(cleanup);
  const [first = loading, ...rest] = states;
  testState.auth = first;
  const screen = await render(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>, {
    router: false,
  });
  try {
    for (const state of rest) {
      testState.auth = state;
      // Clerk announces status through its status event and auth state through a render.
      await act(() => {
        for (const listener of testState.statusListeners) listener();
      });
      await screen.rerender(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>);
    }
  } catch (error) {
    await screen[Symbol.asyncDispose]();
    throw error;
  }
  // Account cleanup is queued behind a promise, so let it start before asserting.
  await act(() => Promise.resolve());
  return screen;
}

const activeAccount = () => appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null;

describe("ManagedRelayAuthProvider", () => {
  it("keeps saved relay environments when Clerk cannot reach its API at launch", async () => {
    await using _screen = await mountAuth([loading, signedOut("degraded")]);

    expect(testState.removeRelayEnvironments).not.toHaveBeenCalled();
    expect(activeAccount()).toBeNull();
  });

  it("removes relay environments once Clerk's API confirms there is no session", async () => {
    await using _screen = await mountAuth([loading, signedOut("degraded"), signedOut("ready")]);

    await vi.waitFor(() => expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1));
    expect(activeAccount()).toBeNull();
  });

  it("removes relay environments when the signed-in account signs out", async () => {
    await using _screen = await mountAuth([signedInAs("account-1"), signedOut("ready")]);

    await vi.waitFor(() => expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1));
    expect(activeAccount()).toBeNull();
  });

  it("removes the previous account's relay environments before activating the next account", async () => {
    let releaseCleanup = () => {};
    const cleanup = new Promise<AsyncResult.AsyncResult<void, never>>((resolve) => {
      releaseCleanup = () => resolve(AsyncResult.success(undefined));
    });
    await using _screen = await mountAuth(
      [signedInAs("account-1"), signedInAs("account-2")],
      cleanup,
    );

    expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1);
    expect(activeAccount()).toBeNull();

    await act(releaseCleanup);
    await vi.waitFor(() => expect(activeAccount()).toBe("account-2"));
  });
});
