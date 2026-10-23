import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessionAtom: {},
  searchEntries: vi.fn(() => null),
}));

vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => mocks.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("./pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./vcs", () => ({ vcsEnvironment: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.sessionAtom
        ? { authenticated: true, scopes: [AuthFilesystemReadScope] }
        : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

import { useComposerPathSearch, type ComposerPathSearchTarget } from "./queries";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.searchEntries.mockClear();
  const root = createRoot(document.createElement("div"));
  let commits = 0;
  let isPending = false;

  function Probe({ target }: { readonly target: ComposerPathSearchTarget }) {
    const result = useComposerPathSearch(target);
    useLayoutEffect(() => {
      commits += 1;
      isPending = result.isPending;
    });
    return null;
  }

  return {
    render(query: string | null) {
      act(() =>
        root.render(
          <Probe
            target={{ environmentId: EnvironmentId.make("test-environment"), cwd: "/repo", query }}
          />,
        ),
      );
    },
    get commits() {
      return commits;
    },
    get isPending() {
      return isPending;
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.useRealTimers();
    },
  };
}

it.each([null, "src"])("stops rendering after the path target settles (%s)", (query) => {
  using harness = setup();
  harness.render(query);
  // A parent render before the debounce fires used to start a self-sustaining loop.
  harness.render(query);
  act(() => vi.advanceTimersByTime(200));
  const settledCommits = harness.commits;

  act(() => vi.advanceTimersByTime(200));
  expect(harness.commits).toBe(settledCommits);
  act(() => vi.advanceTimersByTime(2_000));
  expect(harness.commits).toBe(settledCommits);
  expect(harness.isPending).toBe(false);
  if (query === null) expect(mocks.searchEntries).not.toHaveBeenCalled();
});

it("still debounces a changed path query before searching", () => {
  using harness = setup();
  harness.render(null);
  harness.render(" src ");
  expect(harness.isPending).toBe(true);
  act(() => vi.advanceTimersByTime(100));
  harness.render("src");
  act(() => vi.advanceTimersByTime(99));
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(mocks.searchEntries).toHaveBeenLastCalledWith({
    environmentId: EnvironmentId.make("test-environment"),
    input: { cwd: "/repo", query: "src", limit: 20 },
  });
  expect(harness.isPending).toBe(false);
});
