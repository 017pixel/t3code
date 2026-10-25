import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useDebouncedValue } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { followFileTreeSelection, toggleFileTreeDirectory } from "./fileTreeExpansion";

interface FileTreeListing {
  /** Entries reachable from the root through expanded directories. */
  readonly entries: ReadonlyArray<ProjectEntry>;
  readonly reachableDirectories: ReadonlySet<string>;
  /** Expanded directories whose listing is loading or refreshing. */
  readonly loadingDirectories: ReadonlySet<string>;
  readonly isPending: boolean;
  readonly rootError: string | null;
  readonly directoryError: string | null;
}

const EMPTY_LISTING: FileTreeListing = {
  entries: [],
  reachableDirectories: new Set(),
  loadingDirectories: new Set(),
  isPending: false,
  rootError: null,
  directoryError: null,
};

const REFRESH_CONCURRENCY = 4;

const listEntriesAtom = (environmentId: EnvironmentId, cwd: string, directoryPath: string) =>
  projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });

const listingFailure = (result: AsyncResult.AsyncResult<unknown, unknown>) => {
  if (!AsyncResult.isFailure(result)) return null;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error.message : "Files unavailable";
};

// Keyed by the expanded set, so expanding or collapsing subscribes to exactly the
// listings on screen. Collapsed listings stay cached by listEntries' idle TTL.
const fileTreeListingAtom = Atom.family((key: string) => {
  const [environmentId, cwd, expanded] = JSON.parse(key) as [
    EnvironmentId,
    string,
    ReadonlyArray<string>,
  ];
  return Atom.make((get): FileTreeListing => {
    const listings = new Map<string, ReadonlyArray<ProjectEntry>>();
    const loadingDirectories = new Set<string>();
    const errors = new Map<string, string>();
    let isPending = false;
    for (const directoryPath of ["", ...expanded]) {
      const result = get(listEntriesAtom(environmentId, cwd, directoryPath));
      const listing = Option.getOrNull(AsyncResult.value(result));
      if (result.waiting || AsyncResult.isInitial(result)) {
        isPending = true;
        if (directoryPath !== "") loadingDirectories.add(directoryPath);
      }
      if (listing !== null) {
        listings.set(
          directoryPath,
          listing.entries.filter(
            (entry) =>
              entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
          ),
        );
      }
      const failure = listingFailure(result);
      if (failure !== null) errors.set(directoryPath, failure);
    }
    const entries: ProjectEntry[] = [];
    const reachableDirectories = new Set<string>();
    const visit = (items: ReadonlyArray<ProjectEntry>) => {
      for (const entry of items) {
        entries.push(entry);
        if (entry.kind === "directory") {
          reachableDirectories.add(entry.path);
          visit(listings.get(entry.path) ?? []);
        }
      }
    };
    visit(listings.get("") ?? []);
    return {
      entries,
      reachableDirectories,
      loadingDirectories,
      isPending,
      rootError: errors.get("") ?? null,
      directoryError: [...errors].find(([path]) => reachableDirectories.has(path))?.[1] ?? null,
    };
  }).pipe(Atom.withLabel(`mobile:file-tree:${key}`));
});

const EMPTY_LISTING_ATOM = Atom.make(EMPTY_LISTING).pipe(Atom.withLabel("mobile:file-tree:none"));

export function useFileTreeEntries(input: {
  readonly cwd: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly selectedPath: string | null;
}) {
  const { cwd, environmentId } = input;
  const scopeKey = JSON.stringify([environmentId, cwd]);
  const [storedExpansion, setExpansion] = useState(() =>
    followFileTreeSelection(null, scopeKey, input.selectedPath),
  );
  const expansion = followFileTreeSelection(storedExpansion, scopeKey, input.selectedPath);
  if (expansion !== storedExpansion) setExpansion(expansion);

  const searching = input.searchQuery.trim().length > 0;
  const query = input.searchQuery.trim().slice(0, 256);
  const debouncedQuery = useDebouncedValue(query, 200);
  const searchAtom =
    searching && debouncedQuery.length > 0 && cwd !== null && environmentId !== null
      ? projectEnvironment.searchEntries({
          environmentId,
          input: { cwd, query: debouncedQuery, limit: 200 },
        })
      : null;
  const search = useEnvironmentQuery(searchAtom);
  const listing = useAtomValue(
    cwd !== null && environmentId !== null
      ? fileTreeListingAtom(JSON.stringify([environmentId, cwd, [...expansion.expanded].sort()]))
      : EMPTY_LISTING_ATOM,
  );
  const [refreshingScope, setRefreshingScope] = useState<{ readonly scopeKey: string } | null>(
    null,
  );

  const entries = (() => {
    if (!searching) return listing.entries;
    const merged = new Map<string, ProjectEntry>();
    for (const entry of search.data?.entries ?? []) merged.set(entry.path, entry);
    for (const entry of listing.entries) merged.set(entry.path, entry);
    return [...merged.values()];
  })();

  const refresh = () => {
    if (cwd === null || environmentId === null) return Promise.resolve();
    const atoms = [
      ...["", ...expansion.expanded]
        .filter((path) => path === "" || listing.reachableDirectories.has(path))
        .map((path) => listEntriesAtom(environmentId, cwd, path)),
      ...(searchAtom === null ? [] : [searchAtom]),
    ];
    const token = { scopeKey };
    setRefreshingScope(token);
    // A deep tree has many expanded directories; a few listings at a time keep
    // pull-to-refresh from flooding a remote or relayed connection.
    const remaining = atoms.values();
    const worker = async () => {
      for (let next = remaining.next(); !next.done; next = remaining.next()) {
        await executeAtomQuery(appAtomRegistry, next.value, {
          refresh: true,
          reportFailure: false,
          reportDefect: false,
        });
      }
    };
    return Promise.all(
      Array.from({ length: Math.min(REFRESH_CONCURRENCY, atoms.length) }, worker),
    ).finally(() => setRefreshingScope((current) => (current === token ? null : current)));
  };

  return {
    entries,
    searchResultPaths: searching
      ? new Set((search.data?.entries ?? []).map((entry) => entry.path))
      : null,
    isRefreshing: refreshingScope?.scopeKey === scopeKey,
    error: listing.rootError ?? (searching ? search.error : null) ?? listing.directoryError,
    isPending: listing.isPending || (searching && (query !== debouncedQuery || search.isPending)),
    searchTruncated: searching && (search.data?.truncated ?? false),
    expandedPaths: expansion.expanded,
    loadingDirectories: listing.loadingDirectories,
    toggleDirectory: (path: string) =>
      setExpansion((current) =>
        toggleFileTreeDirectory(
          followFileTreeSelection(current, scopeKey, input.selectedPath),
          path,
        ),
      ),
    refresh,
  };
}
