import {
  NavigationContext,
  type NavigationProp,
  type ParamListBase,
} from "@react-navigation/native";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  enabled: true,
  query: {
    data: null as { run: { _tag: "Running" | "Completed" } } | null,
    isPending: false,
    refresh: vi.fn<() => void>(),
  },
}));

vi.mock("@react-navigation/native", async () => {
  const { createRequire } = await import("node:module");
  const { realpathSync } = await import("node:fs");
  const require = createRequire(import.meta.url);
  const nativeRequire = createRequire(
    realpathSync(require.resolve("@react-navigation/native/package.json")),
  );
  // Use the shipped focus hook without importing the React Native view layer.
  const { NavigationContext, useFocusEffect }: typeof import("@react-navigation/native") =
    nativeRequire("@react-navigation/core");
  return { NavigationContext, useFocusEffect };
});
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "settings" ? { reviewGuidesEnabled: mocks.enabled } : true,
}));
vi.mock("../../../state/server", () => ({
  serverEnvironment: { settingsValueAtom: () => "settings" },
}));
vi.mock("../../../state/pull-requests", () => ({
  composerPullRequests: {
    reviewGuide: () => "guide",
    generateReviewGuide: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => ({ ...mocks.query }) }));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../usePullRequestConnected", () => ({ usePullRequestConnected: () => true }));
vi.mock("../usePullRequestDiff", () => ({
  pullRequestTarget: (params: unknown) => params,
}));

import { useReviewGuide } from "./useReviewGuide";

function createNavigation() {
  const listeners = { focus: new Set<() => void>(), blur: new Set<() => void>() };
  let focused = true;
  return {
    value: {
      isFocused: () => focused,
      addListener: (event: keyof typeof listeners, listener: () => void) => {
        listeners[event].add(listener);
        return () => listeners[event].delete(listener);
      },
    } as unknown as NavigationProp<ParamListBase>,
    focus(next: boolean) {
      focused = next;
      act(() => {
        for (const listener of listeners[next ? "focus" : "blur"]) listener();
      });
    },
  };
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.enabled = true;
  mocks.query = { data: null, isPending: false, refresh: vi.fn() };
  const root = createRoot(document.createElement("div"));
  const navigation = createNavigation();
  const params = {
    environmentId: "environment",
    projectId: "project",
    repository: "repo",
    number: 1,
  };
  function Probe() {
    useReviewGuide(params);
    return null;
  }
  return {
    render() {
      act(() =>
        root.render(
          <NavigationContext.Provider value={navigation.value}>
            <Probe />
          </NavigationContext.Provider>,
        ),
      );
    },
    focus: navigation.focus,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

it("refreshes once per focus across pending and result rerenders", () => {
  using screen = setup();
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  mocks.query.isPending = true;
  screen.render();
  mocks.query = { ...mocks.query, isPending: false, data: { run: { _tag: "Completed" } } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  screen.focus(false);
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  screen.focus(true);
  screen.focus(true);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);

  mocks.query.refresh = vi.fn();
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
});

it("keeps running-guide polling through result rerenders and stops on blur or completion", () => {
  vi.useFakeTimers();
  using _timers = { [Symbol.dispose]: () => vi.useRealTimers() };
  using screen = setup();
  mocks.query.data = { run: { _tag: "Running" } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);

  act(() => vi.advanceTimersByTime(4_000));
  mocks.query = { ...mocks.query, isPending: true, data: { run: { _tag: "Running" } } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(1);
  act(() => vi.advanceTimersByTime(1_000));
  expect(mocks.query.refresh).toHaveBeenCalledTimes(2);

  screen.focus(false);
  expect(vi.getTimerCount()).toBe(0);
  screen.focus(true);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(3);
  expect(vi.getTimerCount()).toBe(1);

  mocks.query = { ...mocks.query, isPending: false, data: { run: { _tag: "Completed" } } };
  screen.render();
  expect(mocks.query.refresh).toHaveBeenCalledTimes(4);
  expect(vi.getTimerCount()).toBe(0);

  mocks.enabled = false;
  screen.render();
  screen.focus(false);
  screen.focus(true);
  expect(mocks.query.refresh).toHaveBeenCalledTimes(4);
});
