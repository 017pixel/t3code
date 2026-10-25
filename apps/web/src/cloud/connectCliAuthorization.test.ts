import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../env", () => ({ isElectron: false }));
vi.mock("./connectCliAuth", () => ({
  buildConnectCliClerkAuthorizeUrl: (request: { state: string }) =>
    `https://clerk.test/oauth/authorize?state=${request.state}`,
  connectCliSignInRedirectUrl: (_request: unknown, href: string) => href,
}));

import {
  stopConnectCliAuthorization,
  watchConnectCliAuthorization,
} from "./connectCliAuthorization";
import { type ManagedClerk, publishManagedClerk } from "./managedClerk";

type Resources = { user: { id: string } | null | undefined };

const clerk = {
  isSignedIn: false,
  listeners: new Set<(resources: Resources) => void>(),
  openSignIn: vi.fn(),
  addListener(listener: (resources: Resources) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  },
  emit(resources: Resources) {
    for (const listener of this.listeners) listener(resources);
  },
};
publishManagedClerk(clerk as unknown as ManagedClerk);

const assign = vi.fn();
vi.stubGlobal("window", { location: { href: "https://app.test/connect", assign } });

function setup() {
  stopConnectCliAuthorization();
  clerk.isSignedIn = false;
  clerk.openSignIn.mockClear();
  assign.mockClear();
}

const request = (state: string) => ({ state, challenge: "c", loopbackPort: 4321 });

describe("watchConnectCliAuthorization", () => {
  it("opens sign-in once per request, across emissions and route reloads", async () => {
    setup();
    watchConnectCliAuthorization(request("a"));
    await Promise.resolve();
    clerk.emit({ user: undefined });
    expect(clerk.openSignIn).not.toHaveBeenCalled();

    clerk.emit({ user: null });
    clerk.emit({ user: null });
    watchConnectCliAuthorization(request("a"));
    clerk.emit({ user: null });
    expect(clerk.openSignIn).toHaveBeenCalledTimes(1);
    expect(clerk.listeners.size).toBe(1);
  });

  it("redirects to the authorize URL once signed in, and only once", async () => {
    setup();
    watchConnectCliAuthorization(request("b"));
    await Promise.resolve();
    clerk.isSignedIn = true;
    clerk.emit({ user: { id: "u" } });
    clerk.emit({ user: { id: "u" } });
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("https://clerk.test/oauth/authorize?state=b");
  });

  it("stops listening when the route is left, even before Clerk is available", async () => {
    setup();
    watchConnectCliAuthorization(request("c"));
    stopConnectCliAuthorization();
    await Promise.resolve();
    expect(clerk.listeners.size).toBe(0);

    watchConnectCliAuthorization(request("d"));
    await Promise.resolve();
    stopConnectCliAuthorization();
    clerk.emit({ user: null });
    expect(clerk.listeners.size).toBe(0);
    expect(clerk.openSignIn).not.toHaveBeenCalled();
  });
});
