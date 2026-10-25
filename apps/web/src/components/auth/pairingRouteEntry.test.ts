import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  url: "https://app.test/pair",
  submit: vi.fn<(credential: string) => Promise<void>>(),
  runAtomCommand: vi.fn(),
}));

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: () => new URL(mocks.url).searchParams.get("token"),
  stripPairingTokenFromUrl: () => {
    const url = new URL(mocks.url);
    url.searchParams.delete("token");
    mocks.url = url.toString();
  },
  submitServerAuthCredential: mocks.submit,
}));
vi.mock("../../hostedPairing", () => ({
  readHostedPairingRequest: () => {
    const url = new URL(mocks.url);
    const host = url.searchParams.get("host");
    const token = url.searchParams.get("token");
    return host && token ? { host, token, label: "" } : null;
  },
}));
vi.mock("../../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../../env", () => ({ isElectron: false }));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: mocks.runAtomCommand,
  squashAtomCommandFailure: (result: { readonly error: unknown }) => result.error,
}));

import {
  enterHostedPairRoute,
  enterPairRoute,
  hasHostedPairingAttempt,
  leavePairRoute,
} from "./pairingRouteEntry";

function visit(url: string) {
  mocks.url = url;
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { replace, pathname: "/pair", search: "" } });
  return { replace };
}

describe("pairingRouteEntry", () => {
  afterEach(() => {
    leavePairRoute();
    mocks.submit.mockReset();
    mocks.runAtomCommand.mockReset();
    vi.unstubAllGlobals();
  });

  it("submits a pairing link's token once and keeps the attempt across the stripped reload", async () => {
    visit("https://app.test/pair?token=abc");
    mocks.submit.mockRejectedValue(new Error("Token expired."));

    const first = enterPairRoute();
    expect(mocks.url).toBe("https://app.test/pair");
    const second = enterPairRoute();

    expect(second).toBe(first);
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    expect(first?.credential).toBe("abc");
    await expect(first?.failure).resolves.toBe("Token expired.");
  });

  it("reloads into the app once the token is accepted", async () => {
    const { replace } = visit("https://app.test/pair?token=abc");
    mocks.submit.mockResolvedValue();

    enterPairRoute();
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("forgets the attempt when the route is left", () => {
    visit("https://app.test/pair?token=abc");
    mocks.submit.mockReturnValue(new Promise(() => {}));
    enterPairRoute();

    leavePairRoute();

    expect(enterPairRoute()).toBeNull();
  });

  it("holds the hosted attempt after the token leaves the address", async () => {
    visit("https://app.test/pair?host=backend.test&token=abc");
    mocks.runAtomCommand.mockResolvedValue({ _tag: "Failure", error: new Error("Unreachable.") });

    const attempt = enterHostedPairRoute();

    expect(hasHostedPairingAttempt()).toBe(true);
    expect(enterHostedPairRoute()).toBe(attempt);
    expect(mocks.runAtomCommand).toHaveBeenCalledTimes(1);
    await expect(attempt?.outcome).resolves.toEqual({
      status: "failed",
      message:
        "Unreachable. If the backend accepted this one-time token, request a new pairing link before retrying.",
    });

    leavePairRoute();
    expect(hasHostedPairingAttempt()).toBe(false);
  });
});
