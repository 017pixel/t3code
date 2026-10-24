import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";

function createDirectories() {
  return {
    target: {},
    entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
    errors: new Map<string, string>(),
    completeDirectories: new Set<string>(),
    loading: new Set<string>(),
    expandedPaths: new Set<string>(),
    selectedPath: null as string | null,
    isRefreshing: false,
  };
}

function createRequests() {
  return {
    active: true,
    refreshVersion: 0,
    pending: new Map<string, AbortController>(),
  };
}

function getRequests(
  requestsByTarget: WeakMap<object, ReturnType<typeof createRequests>>,
  target: object,
) {
  let requests = requestsByTarget.get(target);
  if (!requests) {
    requests = createRequests();
    requestsByTarget.set(target, requests);
  }
  return requests;
}

export function useFileTreeEntries(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
}) {
  const { cwd, environmentId } = input;
  const searching = input.searchQuery.trim().length > 0;
  const query = input.searchQuery.trim().slice(0, 256);
  const debouncedQuery = useDebouncedValue(query, 200);
  const root = useEnvironmentQuery(
    cwd !== null && environmentId !== null
      ? projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath: "" } })
      : null,
  );
  const search = useEnvironmentQuery(
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedQuery, limit: 200 },
        })
      : null,
  );
  const workspaceKey = JSON.stringify([environmentId, cwd]);
  const [cache, setCache] = useState(() => ({
    key: workspaceKey,
    workspaces: new Map([[workspaceKey, createDirectories()]]),
  }));
  const savedDirectories = cache.workspaces.get(workspaceKey) ?? createDirectories();
  // Requests belong to a visit, so returning cannot revive an old completion.
  const directories =
    cache.key === workspaceKey
      ? savedDirectories
      : {
          ...savedDirectories,
          target: {},
          loading: new Set<string>(),
          isRefreshing: false,
        };
  if (cache.key !== workspaceKey) {
    const workspaces = new Map(cache.workspaces);
    const previous = workspaces.get(cache.key);
    if (previous) {
      // Bound retained history without evicting directories from the visible tree.
      const entries = new Map([...previous.entries].slice(-64));
      workspaces.set(cache.key, {
        ...previous,
        entries,
        completeDirectories: new Set(
          [...previous.completeDirectories].filter((path) => entries.has(path)),
        ),
        errors: new Map(),
        loading: new Set(),
        expandedPaths: new Set([...previous.expandedPaths].slice(-64)),
        isRefreshing: false,
      });
    }
    workspaces.delete(workspaceKey);
    workspaces.set(workspaceKey, directories);
    if (workspaces.size > 8) workspaces.delete(workspaces.keys().next().value!);
    setCache({ key: workspaceKey, workspaces });
  }
  const setDirectories = useCallback(
    (
      update: (
        current: ReturnType<typeof createDirectories>,
      ) => ReturnType<typeof createDirectories>,
    ) =>
      setCache((current) => {
        const previous = current.workspaces.get(workspaceKey);
        if (!previous) return current;
        const next = update(previous);
        if (next === previous) return current;
        return { ...current, workspaces: new Map(current.workspaces).set(workspaceKey, next) };
      }),
    [workspaceKey],
  );
  const { target } = directories;
  const requestsByTarget = useRef(new WeakMap<object, ReturnType<typeof createRequests>>());
  // Cancel the old target before consumers' passive effects start new directory loads.
  useLayoutEffect(() => {
    const requests = getRequests(requestsByTarget.current, target);
    requests.active = true;
    return () => {
      requests.active = false;
      requests.refreshVersion++;
      for (const controller of requests.pending.values()) controller.abort();
      requests.pending.clear();
      setDirectories((current) =>
        current.target === target
          ? { ...current, loading: new Set(), isRefreshing: false }
          : current,
      );
    };
  }, [target, setDirectories, requestsByTarget]);
  const updateDirectories = (
    update: (current: ReturnType<typeof createDirectories>) => ReturnType<typeof createDirectories>,
  ) => setDirectories((current) => (current.target === target ? update(current) : current));
  const loadDirectory = (directoryPath: string, refresh = false) => {
    const requests = getRequests(requestsByTarget.current, target);
    if (
      !requests.active ||
      cwd === null ||
      environmentId === null ||
      (!refresh &&
        (directories.entries.has(directoryPath) || directories.errors.has(directoryPath))) ||
      requests.pending.has(directoryPath)
    ) {
      return;
    }
    const controller = new AbortController();
    requests.pending.set(directoryPath, controller);
    updateDirectories((current) => {
      const errors = new Map(current.errors);
      errors.delete(directoryPath);
      return { ...current, errors, loading: new Set(current.loading).add(directoryPath) };
    });
    const atom = projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });
    appAtomRegistry.refresh(atom);
    return executeAtomQuery(appAtomRegistry, atom, {
      signal: controller.signal,
      reportFailure: false,
      reportDefect: false,
    }).then((result) => {
      if (controller.signal.aborted) return;
      requests.pending.delete(directoryPath);
      updateDirectories((current) => {
        const loading = new Set(current.loading);
        loading.delete(directoryPath);
        if (result._tag === "Success") {
          const entries = new Map(current.entries);
          entries.delete(directoryPath);
          entries.set(
            directoryPath,
            result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
          const completeDirectories = new Set(current.completeDirectories);
          if (result.value.truncated) completeDirectories.delete(directoryPath);
          else completeDirectories.add(directoryPath);
          return { ...current, entries, loading, completeDirectories };
        }
        const error = Cause.squash(result.cause);
        return {
          ...current,
          loading,
          errors: new Map(current.errors).set(
            directoryPath,
            error instanceof Error ? error.message : "Files unavailable",
          ),
        };
      });
    });
  };
  const { refresh: refreshRoot, data: rootData } = root;
  const { refresh: refreshSearch, data: searchData } = search;
  const snapshot = (() => {
    const merged = new Map<string, ProjectEntry>();
    if (searching) {
      for (const entry of searchData?.entries ?? []) merged.set(entry.path, entry);
    }
    const reachableDirectories = new Set<string>();
    const visit = (items: ReadonlyArray<ProjectEntry>) => {
      for (const entry of items) {
        merged.set(entry.path, entry);
        if (entry.kind === "directory") {
          reachableDirectories.add(entry.path);
          visit(directories.entries.get(entry.path) ?? []);
        }
      }
    };
    visit((rootData?.entries ?? []).filter((entry) => !entry.path.includes("/")));
    return {
      entries: [...merged.values()],
      reachableDirectories,
      searchResultPaths: searching
        ? new Set((searchData?.entries ?? []).map((entry) => entry.path))
        : null,
    };
  })();

  if (rootData) {
    const deleted = (path: string, directory = false) => {
      const parts = path.split("/");
      for (let index = 0; index < parts.length; index++) {
        const parent = parts.slice(0, index).join("/");
        const listing = index === 0 ? rootData.entries : directories.entries.get(parent);
        const child = parts.slice(0, index + 1).join("/");
        const complete =
          index === 0 ? !rootData.truncated : directories.completeDirectories.has(parent);
        const entry = listing?.find((item) => item.path === child);
        if (complete && listing && !entry) return true;
        if (entry && (directory || index < parts.length - 1) && entry.kind !== "directory")
          return true;
      }
      return false;
    };
    const reconciled = (() => {
      const current = directories;
      const entries = new Map([...current.entries].filter(([path]) => !deleted(path, true)));
      const errors = new Map([...current.errors].filter(([path]) => !deleted(path, true)));
      const expandedPaths = new Set(
        [...current.expandedPaths].filter((path) => !deleted(path, true)),
      );
      const selectedPath =
        current.selectedPath !== null && deleted(current.selectedPath)
          ? null
          : current.selectedPath;
      if (
        entries.size === current.entries.size &&
        errors.size === current.errors.size &&
        expandedPaths.size === current.expandedPaths.size &&
        selectedPath === current.selectedPath
      )
        return current;
      const completeDirectories = new Set(
        [...current.completeDirectories].filter((path) => entries.has(path)),
      );
      return { ...current, entries, errors, expandedPaths, selectedPath, completeDirectories };
    })();
    if (reconciled !== directories) setDirectories(() => reconciled);
  }

  const refresh = () => {
    const requests = getRequests(requestsByTarget.current, target);
    if (!requests.active) return Promise.resolve();
    refreshRoot();
    if (searching) refreshSearch();
    const paths = new Set(
      [...directories.entries.keys(), ...directories.errors.keys(), ...directories.loading].filter(
        (path) => snapshot.reachableDirectories.has(path),
      ),
    );
    for (const controller of requests.pending.values()) controller.abort();
    requests.pending.clear();
    const version = ++requests.refreshVersion;
    updateDirectories((current) => ({
      ...current,
      errors: new Map(),
      loading: new Set(),
      isRefreshing: true,
    }));
    const remaining = paths.values();
    const worker = async () => {
      while (requests.active && version === requests.refreshVersion) {
        const next = remaining.next();
        if (next.done) return;
        await loadDirectory(next.value, true);
      }
    };
    const queries =
      cwd !== null && environmentId !== null
        ? [
            projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath: "" } }),
            ...(searching
              ? [
                  projectEnvironment.searchEntries({
                    environmentId,
                    input: { cwd, query: debouncedQuery, limit: 200 },
                  }),
                ]
              : []),
          ]
        : [];
    const work = [
      ...queries.map((atom) =>
        executeAtomQuery(appAtomRegistry, atom, { reportFailure: false, reportDefect: false }),
      ),
      ...Array.from({ length: Math.min(4, paths.size) }, () => worker()),
    ];
    return Promise.all(work).finally(() => {
      if (version === requests.refreshVersion) {
        updateDirectories((current) => ({ ...current, isRefreshing: false }));
      }
    });
  };

  const setExpandedPaths = (update: (current: ReadonlySet<string>) => ReadonlySet<string>) =>
    updateDirectories((current) => {
      const expandedPaths = update(current.expandedPaths);
      return expandedPaths === current.expandedPaths
        ? current
        : { ...current, expandedPaths: new Set(expandedPaths) };
    });

  return {
    expandedPaths: directories.expandedPaths,
    setExpandedPaths,
    selectedPath: directories.selectedPath,
    selectPath: (selectedPath: string) =>
      updateDirectories((current) => ({ ...current, selectedPath })),
    entries: snapshot.entries,
    searchResultPaths: snapshot.searchResultPaths,
    isRefreshing: directories.isRefreshing,
    error:
      root.error ??
      (searching ? search.error : null) ??
      [...directories.errors].find(([path]) => snapshot.reachableDirectories.has(path))?.[1] ??
      null,
    isPending:
      root.isPending ||
      directories.loading.size > 0 ||
      (searching && (query !== debouncedQuery || search.isPending)),
    searchTruncated: searching && (search.data?.truncated ?? false),
    loadedDirectories: new Set(directories.entries.keys()),
    loadingDirectories: directories.loading,
    loadDirectory,
    refresh,
  };
}
