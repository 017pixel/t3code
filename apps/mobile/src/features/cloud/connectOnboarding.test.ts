import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({ navigate: vi.fn() }));
const optOut = vi.hoisted(() => ({ optedOut: new Set<string>() }));

vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: navigation,
  whenRootNavigationReady: (navigate: () => void) => navigate(),
}));
vi.mock("./connectOnboardingOptOut", () => ({
  isConnectOnboardingOptedOut: (accountId: string) =>
    Promise.resolve(optOut.optedOut.has(accountId)),
}));

import { clearConnectOnboardingRequest, requestConnectOnboarding } from "./connectOnboarding";

afterEach(() => {
  clearConnectOnboardingRequest();
  optOut.optedOut.clear();
  navigation.navigate.mockReset();
  vi.useRealTimers();
});

describe("requestConnectOnboarding", () => {
  it("presents the sheet after the settle delay", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    await vi.advanceTimersByTimeAsync(599);
    expect(navigation.navigate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(navigation.navigate).toHaveBeenCalledExactlyOnceWith("ConnectOnboarding");
  });

  it("drops a request cleared by sign-out before it fires", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    clearConnectOnboardingRequest();
    await vi.runAllTimersAsync();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("skips accounts that opted out", async () => {
    vi.useFakeTimers();
    optOut.optedOut.add("account-1");
    requestConnectOnboarding("account-1");
    await vi.runAllTimersAsync();
    expect(navigation.navigate).not.toHaveBeenCalled();
  });

  it("presents once when a newer request replaces a pending one", async () => {
    vi.useFakeTimers();
    requestConnectOnboarding("account-1");
    requestConnectOnboarding("account-2");
    await vi.runAllTimersAsync();
    expect(navigation.navigate).toHaveBeenCalledOnce();
  });
});
