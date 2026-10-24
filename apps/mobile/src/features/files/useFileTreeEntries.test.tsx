// @effect-diagnostics nodeBuiltinImport:off - exercises the hook with Metro's release transform.
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import {
  EnvironmentId,
  type ProjectEntry,
  type ProjectListEntriesResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as React from "react";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Hook = typeof import("./useFileTreeEntries").useFileTreeEntries;
type Input = Parameters<Hook>[0];
type Query = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string; readonly directoryPath?: string };
};
type Result =
  | { readonly _tag: "Success"; readonly value: ProjectListEntriesResult }
  | { readonly _tag: "Failure"; readonly cause: Cause.Cause<Error> };

const require = NodeModule.createRequire(import.meta.url);
const babel: {
  transformFileSync(file: string, options: Record<string, unknown>): { code: string };
} = require("@babel/core");
const sourcePath = require.resolve("./useFileTreeEntries.ts");
const rootEntries: ProjectEntry[] = [{ kind: "directory", path: "src" }];
const firstTarget = { cwd: "/first", environmentId: EnvironmentId.make("first") };

function compileHook() {
  const { code } = babel.transformFileSync(sourcePath, {
    babelrc: false,
    configFile: false,
    presets: [[require.resolve("babel-preset-expo"), { unstable_transformImportMeta: true }]],
    caller: {
      name: "metro",
      bundler: "metro",
      platform: "ios",
      isDev: false,
      isServer: false,
      isNodeModule: false,
      supportsStaticESM: false,
      supportsReactCompiler: true,
    },
  });
  expect(code).toContain("react/compiler-runtime");
  return NodeVM.compileFunction(code, ["require", "exports"], { filename: sourcePath });
}

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const requests: {
    readonly query: Query;
    readonly signal?: AbortSignal;
    readonly resolve: (result: Result) => void;
  }[] = [];
  const rootQuery = {
    data: { entries: rootEntries, truncated: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  };
  const modules: Record<string, unknown> = {
    react: React,
    "react/compiler-runtime": require("react/compiler-runtime"),
    "effect/Cause": Cause,
    "@t3tools/client-runtime/state/runtime": {
      executeAtomQuery: (_registry: unknown, query: Query, options: { signal?: AbortSignal }) =>
        new Promise<Result>((resolve) => requests.push({ query, signal: options.signal, resolve })),
    },
    "../../state/atom-registry": { appAtomRegistry: { refresh: vi.fn() } },
    "../../state/projects": {
      projectEnvironment: {
        listEntries: (query: Query) => query,
        searchEntries: (query: Query) => query,
      },
    },
    "../../state/queries": { useDebouncedValue: (value: string) => value },
    "../../state/query": { useEnvironmentQuery: () => rootQuery },
  };
  const exports = {} as { useFileTreeEntries: Hook };
  compileHook()((name: string) => {
    if (name.startsWith("@babel/runtime/"))
      return NodeModule.createRequire(require.resolve("babel-preset-expo"))(name);
    if (!(name in modules)) throw new Error(`Unexpected hook dependency: ${name}`);
    return modules[name];
  }, exports);
  const useFileTreeEntries = exports.useFileTreeEntries;
  const root = createRoot(document.createElement("div"));
  let current: ReturnType<Hook>;
  function Probe(input: Input) {
    const result = useFileTreeEntries(input);
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  const unmount = () => act(() => root.unmount());
  return {
    requests,
    rootQuery,
    updateView(expanded: string[], selected: string) {
      act(() => {
        current.setExpandedPaths(() => new Set(expanded));
        current.selectPath(selected);
      });
    },
    unmount,
    get current() {
      return current;
    },
    render(target: Partial<Input> = {}) {
      const probe = <Probe {...firstTarget} searchQuery="" {...target} />;
      act(() => root.render(probe));
    },
    load(path = "src") {
      act(() => {
        void current.loadDirectory(path);
      });
    },
    async succeed(index: number, entries: ProjectEntry[] = []) {
      await act(async () => {
        requests[index]!.resolve({ _tag: "Success", value: { entries, truncated: false } });
      });
    },
    async fail(index: number, message = "Directory unavailable") {
      await act(async () => {
        requests[index]!.resolve({ _tag: "Failure", cause: Cause.fail(new Error(message)) });
      });
    },
    [Symbol.dispose]: unmount,
  };
}

describe("file tree workspace state", () => {
  it("publishes immutable loading and loaded snapshots", async () => {
    using screen = setup();
    screen.render();
    const initial = screen.current;
    screen.load();
    const loading = screen.current;
    expect(loading.isPending).toBe(true);
    expect([...loading.loadingDirectories]).toEqual(["src"]);
    expect([...initial.loadingDirectories]).toEqual([]);
    await screen.succeed(0, [{ kind: "file", path: "src/first.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/first.ts"]);
    expect([...screen.current.loadedDirectories]).toEqual(["src"]);
    expect(screen.current.isPending).toBe(false);
    expect([...screen.current.loadingDirectories]).toEqual([]);
    expect(loading.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect([...loading.loadedDirectories]).toEqual([]);
    expect([...loading.loadingDirectories]).toEqual(["src"]);
  });

  it.each([{ cwd: "/second" }, { environmentId: EnvironmentId.make("second") }])(
    "isolates directory state and restores it on return from %j",
    async (target) => {
      using screen = setup();
      screen.render();
      screen.load();
      await screen.succeed(0, [{ kind: "file", path: "src/first.ts" }]);

      screen.updateView(["src"], "src/first.ts");
      const firstView = screen.current;
      screen.render(target);
      expect([...screen.current.expandedPaths]).toEqual([]);
      expect(screen.current.selectedPath).toBeNull();
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
      expect([...screen.current.loadedDirectories]).toEqual([]);
      expect([...screen.current.loadingDirectories]).toEqual([]);
      screen.load();
      expect(screen.requests[1]!.query).toEqual({
        environmentId: target.environmentId ?? firstTarget.environmentId,
        input: { cwd: target.cwd ?? firstTarget.cwd, directoryPath: "src" },
      });
      await screen.succeed(1, [{ kind: "file", path: "src/second.ts" }]);

      screen.updateView([], "src/second.ts");
      expect([...firstView.expandedPaths]).toEqual(["src"]);
      expect(firstView.selectedPath).toBe("src/first.ts");
      screen.render();
      expect([...screen.current.expandedPaths]).toEqual(["src"]);
      expect(screen.current.selectedPath).toBe("src/first.ts");
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/first.ts"]);
      expect([...screen.current.loadedDirectories]).toEqual(["src"]);
      screen.load();
      expect(screen.requests).toHaveLength(2);

      screen.render(target);
      expect([...screen.current.expandedPaths]).toEqual([]);
      expect(screen.current.selectedPath).toBe("src/second.ts");
      expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/second.ts"]);
      expect([...screen.current.loadedDirectories]).toEqual(["src"]);
    },
  );

  it("ignores stale successes and failures after leaving and returning to a workspace", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    screen.load("src/other");
    screen.render({ cwd: "/second" });
    screen.render();
    screen.load();

    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    await screen.fail(1, "Stale error");
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect(screen.current.error).toBeNull();
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    expect(screen.current.isPending).toBe(true);

    await screen.succeed(2, [{ kind: "file", path: "src/current.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/current.ts"]);
    expect(screen.current.error).toBeNull();
    expect(screen.current.isPending).toBe(false);
    expect([...screen.current.loadingDirectories]).toEqual([]);
  });
  it("evicts the least recently visited workspace instead of retaining unbounded history", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    const nested = Array.from({ length: 65 }, (_, index) => `src/directory-${index}`);
    await screen.succeed(0, [
      { kind: "file", path: "src/first.ts" },
      ...nested.map((path) => ({ kind: "directory" as const, path })),
    ]);
    screen.render({ cwd: "/second" });
    screen.render();
    for (const path of nested) {
      screen.load(path);
      await screen.succeed(screen.requests.length - 1);
    }
    screen.updateView(nested, "src/first.ts");
    expect(screen.current.loadedDirectories.size).toBe(66);
    screen.render({ cwd: "/second" });
    screen.render();
    expect(screen.current.loadedDirectories.size).toBe(64);
    expect(screen.current.expandedPaths.size).toBe(64);
    expect(screen.current.selectedPath).toBe("src/first.ts");
    for (let index = 1; index <= 8; index++) screen.render({ cwd: `/workspace-${index}` });
    screen.render();
    expect([...screen.current.loadedDirectories]).toEqual([]);
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.current.selectedPath).toBeNull();
  });

  it("prunes deleted directory contents, expansion and selection after a fresh parent listing", async () => {
    using screen = setup();
    screen.render();
    screen.load();
    await screen.succeed(0, [{ kind: "directory", path: "src/nested" }]);
    screen.load("src/nested");
    await screen.succeed(1, [{ kind: "file", path: "src/nested/file.ts" }]);
    screen.updateView(["src", "src/nested"], "src/nested/file.ts");
    screen.rootQuery.data = { entries: [], truncated: true };
    screen.render();
    expect([...screen.current.loadedDirectories]).toEqual(["src", "src/nested"]);
    expect(screen.current.selectedPath).toBe("src/nested/file.ts");
    screen.rootQuery.data = { entries: [], truncated: false };
    screen.render();
    expect(screen.current.entries).toEqual([]);
    expect([...screen.current.loadedDirectories]).toEqual([]);
    expect([...screen.current.expandedPaths]).toEqual([]);
    expect(screen.current.selectedPath).toBeNull();
    screen.rootQuery.data = { entries: rootEntries, truncated: false };
    screen.render();
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
  });
});
