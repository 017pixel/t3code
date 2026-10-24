import { managedRelaySessionAtom } from "@t3tools/client-runtime/relay";
import * as Exit from "effect/Exit";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import { appAtomRegistry } from "../rpc/atomRegistry";

type ClerkAuth = { isLoaded: boolean; isSignedIn: boolean; userId: string | null };

const testState = vi.hoisted(() => ({
  auth: { isLoaded: false, isSignedIn: false, userId: null } as ClerkAuth,
  getToken: async () => "clerk-token",
  removeRelayEnvironments: vi.fn(),
}));

vi.mock(import("@clerk/react"), async (original) => ({
  ...(await original()),
  useAuth: (() => ({ ...testState.auth, getToken: testState.getToken })) as never,
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

const loading: ClerkAuth = { isLoaded: false, isSignedIn: false, userId: null };
const signedOut: ClerkAuth = { isLoaded: true, isSignedIn: false, userId: null };
const signedInAs = (userId: string): ClerkAuth => ({ isLoaded: true, isSignedIn: true, userId });

async function mountAuth(...states: ReadonlyArray<ClerkAuth>) {
  testState.removeRelayEnvironments.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  const [first = loading, ...rest] = states;
  testState.auth = first;
  const screen = await render(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>, {
    router: false,
  });
  for (const state of rest) {
    testState.auth = state;
    await screen.rerender(<ManagedRelayAuthProvider>{null}</ManagedRelayAuthProvider>);
  }
  // Account cleanup is queued behind a promise, so let it start before asserting.
  await act(() => Promise.resolve());
  return screen;
}

const activeAccount = () => appAtomRegistry.get(managedRelaySessionAtom)?.accountId ?? null;

describe("ManagedRelayAuthProvider", () => {
  it("keeps saved relay environments when launching offline and Clerk loads signed out", async () => {
    using _offline = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await using _screen = await mountAuth(loading, signedOut);

    expect(testState.removeRelayEnvironments).not.toHaveBeenCalled();
    expect(activeAccount()).toBeNull();
  });

  it("removes relay environments when the signed-in account signs out", async () => {
    await using _screen = await mountAuth(signedInAs("account-1"), signedOut);

    await vi.waitFor(() => expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1));
    expect(activeAccount()).toBeNull();
  });

  it("removes the previous account's relay environments before activating the next account", async () => {
    await using _screen = await mountAuth(signedInAs("account-1"), signedInAs("account-2"));

    await vi.waitFor(() => expect(activeAccount()).toBe("account-2"));
    expect(testState.removeRelayEnvironments).toHaveBeenCalledTimes(1);
  });
});
