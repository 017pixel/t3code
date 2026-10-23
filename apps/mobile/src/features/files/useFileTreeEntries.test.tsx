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
import { act, StrictMode, useEffect, useLayoutEffect } from "react";
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

function compileHook(compiler: boolean) {
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
      supportsReactCompiler: compiler,
    },
  });
  if (compiler) expect(code).toContain("react/compiler-runtime");
  return NodeVM.compileFunction(code, ["require", "exports"], { filename: sourcePath });
}

function setup(moduleFactory: ReturnType<typeof compileHook>, autoLoad = false) {
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
  moduleFactory((name: string) => {
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
    const { loadDirectory } = result;
    useEffect(() => {
      if (autoLoad) void loadDirectory("src");
    }, [loadDirectory]);
    useLayoutEffect(() => {
      current = result;
    });
    return null;
  }
  const unmount = () => act(() => root.unmount());
  return {
    requests,
    unmount,
    get current() {
      return current;
    },
    render(target: Partial<Input> = {}, strict = false) {
      const probe = <Probe {...firstTarget} searchQuery="" {...target} />;
      act(() => root.render(strict ? <StrictMode>{probe}</StrictMode> : probe));
    },
    load(path = "src") {
      act(() => {
        void current.loadDirectory(path);
      });
    },
    refresh() {
      let completion: ReturnType<ReturnType<Hook>["refresh"]>;
      act(() => {
        completion = current.refresh();
      });
      return completion!;
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

describe.each([false, true])("file tree (React Compiler: %s)", (compiler) => {
  const moduleFactory = compileHook(compiler);

  it("publishes loading and loaded snapshots, filters descendants, and deduplicates loads", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    const initial = screen.current;
    screen.load();
    expect(screen.current.isPending).toBe(true);
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    expect([...initial.loadingDirectories]).toEqual([]);
    screen.render();
    screen.load();
    expect(screen.requests).toHaveLength(1);
    await screen.succeed(0, [
      { kind: "file", path: "src/new.ts" },
      { kind: "file", path: "src/nested/hidden.ts" },
    ]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/new.ts"]);
    expect([...screen.current.loadedDirectories]).toEqual(["src"]);
    expect([...screen.current.loadingDirectories]).toEqual([]);
    expect(screen.current.isPending).toBe(false);
    screen.load();
    expect(screen.requests).toHaveLength(1);
  });

  it("publishes failures and clears them when retrying", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    screen.load();
    await screen.fail(0);
    expect(screen.current.error).toBe("Directory unavailable");
    expect(screen.current.isPending).toBe(false);
    expect([...screen.current.loadingDirectories]).toEqual([]);
    expect([...screen.current.loadedDirectories]).toEqual([]);
    screen.load();
    expect(screen.current.error).toBeNull();
    expect(screen.current.isPending).toBe(true);
    await screen.succeed(1, [{ kind: "file", path: "src/retried.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toContain("src/retried.ts");
    expect(screen.current.isPending).toBe(false);
  });

  it.each([{ cwd: "/second" }, { environmentId: EnvironmentId.make("second") }, { cwd: null }])(
    "resets directory data when switching target to %j",
    async (target) => {
      using screen = setup(moduleFactory);
      screen.render();
      screen.load();
      await screen.succeed(0, [{ kind: "file", path: "src/old.ts" }]);
      screen.render(target);
      expect(screen.current.entries.map((entry) => entry.path)).not.toContain("src/old.ts");
      expect([...screen.current.loadedDirectories]).toEqual([]);
      expect([...screen.current.loadingDirectories]).toEqual([]);
      screen.load();
      expect(screen.requests).toHaveLength(target.cwd === null ? 1 : 2);
      if (target.cwd !== null) {
        expect(screen.requests[1]!.query).toEqual({
          environmentId: target.environmentId ?? firstTarget.environmentId,
          input: { cwd: target.cwd ?? firstTarget.cwd, directoryPath: "src" },
        });
      }
    },
  );

  it("aborts old target loads and ignores their late success and failure", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    screen.load();
    screen.load("src/other");
    screen.render({ cwd: "/second" });
    expect(screen.requests[0]!.signal?.aborted).toBe(true);
    expect(screen.requests[1]!.signal?.aborted).toBe(true);
    screen.load();
    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    await screen.fail(1, "Stale error");
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect(screen.current.error).toBeNull();
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    await screen.succeed(2, [{ kind: "file", path: "src/current.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/current.ts"]);
  });

  it("refreshes loaded directories and ignores superseded loads", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    screen.load();
    const firstRefresh = screen.refresh();
    expect(screen.requests[0]!.signal?.aborted).toBe(true);
    expect(screen.current.isRefreshing).toBe(true);
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src"]);
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    await screen.succeed(1);
    await screen.succeed(2, [{ kind: "file", path: "src/refreshed.ts" }]);
    await act(async () => {
      await firstRefresh;
    });
    expect(screen.current.isRefreshing).toBe(false);
    expect(screen.current.isPending).toBe(false);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/refreshed.ts"]);
    const secondRefresh = screen.refresh();
    expect(screen.requests[4]!.query.input.directoryPath).toBe("src");
    await screen.succeed(3);
    await screen.fail(4);
    await act(async () => {
      await secondRefresh;
    });
    expect(screen.current.isRefreshing).toBe(false);
    expect(screen.current.error).toBe("Directory unavailable");
  });

  it("does not let an old target refresh clear the new target refresh", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    const oldRefresh = screen.refresh();
    screen.render({ cwd: "/second" });
    expect(screen.current.isRefreshing).toBe(false);
    const newRefresh = screen.refresh();
    await screen.succeed(0);
    await act(async () => {
      await oldRefresh;
    });
    expect(screen.current.isRefreshing).toBe(true);
    await screen.succeed(1);
    await act(async () => {
      await newRefresh;
    });
    expect(screen.current.isRefreshing).toBe(false);
  });

  it("cancels loads on unmount and ignores late completions and callbacks", async () => {
    using screen = setup(moduleFactory);
    screen.render();
    screen.load();
    screen.unmount();
    expect(screen.requests[0]!.signal?.aborted).toBe(true);
    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    screen.load();
    await screen.refresh();
    expect(screen.requests).toHaveLength(1);
  });

  it("allows consumer effects to reload after Strict Mode cancellation", async () => {
    using screen = setup(moduleFactory, true);
    screen.render({}, true);
    expect(screen.requests).toHaveLength(2);
    expect(screen.requests[0]!.signal?.aborted).toBe(true);
    expect(screen.requests[1]!.signal?.aborted).toBe(false);
    await screen.succeed(0, [{ kind: "file", path: "src/stale.ts" }]);
    expect([...screen.current.loadingDirectories]).toEqual(["src"]);
    await screen.succeed(1, [{ kind: "file", path: "src/current.ts" }]);
    expect(screen.current.entries.map((entry) => entry.path)).toEqual(["src", "src/current.ts"]);
    expect(screen.current.isPending).toBe(false);
    expect(screen.requests).toHaveLength(2);
  });
});
