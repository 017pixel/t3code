import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { useLayoutEffect, useRef, useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";

function createDirectories(cwd: string | null, environmentId: EnvironmentId | null) {
  return {
    cwd,
    environmentId,
    target: {},
    entries: new Map<string, ReadonlyArray<ProjectEntry>>(),
    errors: new Map<string, string>(),
    loading: new Set<string>(),
    isRefreshing: false,
  };
}

function createRequests() {
  return {
    active: true,
    refreshVersion: 0,
    requested: new Set<string>(),
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
  const [directories, setDirectories] = useState(() => createDirectories(cwd, environmentId));
  if (directories.cwd !== cwd || directories.environmentId !== environmentId) {
    setDirectories(createDirectories(cwd, environmentId));
  }
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
  }, [target]);
  const updateDirectories = (update: (current: typeof directories) => typeof directories) =>
    setDirectories((current) => (current.target === target ? update(current) : current));
  const loadDirectory = (directoryPath: string, refresh = false) => {
    const requests = getRequests(requestsByTarget.current, target);
    if (
      !requests.active ||
      cwd === null ||
      environmentId === null ||
      (!refresh && directories.entries.has(directoryPath)) ||
      requests.pending.has(directoryPath)
    ) {
      return;
    }
    const controller = new AbortController();
    requests.requested.add(directoryPath);
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
          entries.set(
            directoryPath,
            result.value.entries.filter(
              (entry) =>
                entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
            ),
          );
          return { ...current, entries, loading };
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

  const refresh = () => {
    const requests = getRequests(requestsByTarget.current, target);
    if (!requests.active) return Promise.resolve();
    refreshRoot();
    if (searching) refreshSearch();
    const paths = new Set(
      [...requests.requested].filter((path) => snapshot.reachableDirectories.has(path)),
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

  return {
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
