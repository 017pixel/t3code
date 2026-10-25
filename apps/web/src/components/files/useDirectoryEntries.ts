import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectEntry, ProjectListEntriesResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { revisionedQuery } from "~/state/revisionedQuery";

export interface DirectoryTreeSnapshot {
  readonly entries: readonly ProjectEntry[];
  /** Requested directories with no listing yet. Refreshes keep their previous listing. */
  readonly loadingDirectories: ReadonlySet<string>;
  readonly ready: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
}

const treeKey = (environmentId: EnvironmentId, cwd: string) => JSON.stringify([environmentId, cwd]);

const listEntriesAtom = (environmentId: EnvironmentId, cwd: string, directoryPath: string) =>
  projectEnvironment.listEntries({ environmentId, input: { cwd, directoryPath } });

// Directories the user expanded. The idle TTL carries the set across the derived tree atom
// being re-keyed when the selected file changes.
const expandedDirectoriesAtom = Atom.family((key: string) =>
  Atom.make<ReadonlySet<string>>(new Set<string>()).pipe(
    Atom.setIdleTTL("10 seconds"),
    Atom.withLabel(`web:file-tree:expanded:${key}`),
  ),
);

function requestedDirectories(
  expanded: ReadonlySet<string>,
  selectedPath: string | null,
): ReadonlySet<string> {
  const requested = new Set(["", ...expanded]);
  // The selected file's ancestors load so a reveal can expand down to it.
  const segments = selectedPath?.split("/") ?? [];
  for (let index = 1; index < segments.length; index++) {
    requested.add(segments.slice(0, index).join("/"));
  }
  return requested;
}

// Expand all can ask for every folder at once; first listings beyond this many
// wait for earlier ones to land. Listings that already loaded do not count.
const MAX_FIRST_LISTINGS = 6;

/**
 * Reads the listings of `directoryPaths` in order, starting at most
 * MAX_FIRST_LISTINGS that have no answer yet. The rest are left unread, so they
 * start as earlier ones land and the reading atom rebuilds.
 */
function readListings(
  get: Atom.AtomContext,
  environmentId: EnvironmentId,
  cwd: string,
  directoryPaths: Iterable<string>,
  revision?: string | null,
) {
  const results = new Map<string, AsyncResult.AsyncResult<ProjectListEntriesResult, unknown>>();
  const deferred: string[] = [];
  let firstListings = 0;
  for (const directoryPath of directoryPaths) {
    if (firstListings >= MAX_FIRST_LISTINGS) {
      deferred.push(directoryPath);
      continue;
    }
    const result = get(
      revisionedQuery(listEntriesAtom(environmentId, cwd, directoryPath), revision),
    );
    results.set(directoryPath, result);
    if (!AsyncResult.isFailure(result) && Option.isNone(AsyncResult.value(result))) {
      firstListings++;
    }
  }
  return { results, deferred };
}

const directoryTreeAtom = Atom.family((key: string) => {
  const [environmentId, cwd, selectedPath, revision] = JSON.parse(key) as [
    EnvironmentId,
    string,
    string | null,
    string | null,
  ];
  return Atom.make((get): DirectoryTreeSnapshot => {
    const requested = requestedDirectories(
      get(expandedDirectoriesAtom(treeKey(environmentId, cwd))),
      selectedPath,
    );
    const directories = new Map<string, readonly ProjectEntry[]>();
    const loadingDirectories = new Set<string>();
    const errors = new Map<string, string>();
    const { results, deferred } = readListings(get, environmentId, cwd, requested, revision);
    let isPending = deferred.length > 0;
    for (const directoryPath of deferred) loadingDirectories.add(directoryPath);
    for (const [directoryPath, result] of results) {
      if (result.waiting || AsyncResult.isInitial(result)) isPending = true;
      const listing = Option.getOrNull(AsyncResult.value(result));
      if (listing) {
        directories.set(
          directoryPath,
          listing.entries.filter(
            (entry) =>
              entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))) === directoryPath,
          ),
        );
      } else if (!AsyncResult.isFailure(result)) {
        loadingDirectories.add(directoryPath);
      }
      if (AsyncResult.isFailure(result)) {
        const cause = Cause.squash(result.cause);
        errors.set(
          directoryPath,
          cause instanceof Error ? cause.message : "Unable to load folder.",
        );
      }
    }
    const entries: ProjectEntry[] = [];
    const reachable = new Set([""]);
    const visit = (path: string) => {
      for (const entry of directories.get(path) ?? []) {
        entries.push(entry);
        if (entry.kind === "directory") {
          reachable.add(entry.path);
          visit(entry.path);
        }
      }
    };
    visit("");
    return {
      entries,
      loadingDirectories,
      ready: directories.has(""),
      isPending,
      error: [...errors].find(([path]) => reachable.has(path))?.[1] ?? null,
    };
  }).pipe(Atom.withLabel(`web:file-tree:${key}`));
});

const directoryTreeKey = (
  environmentId: EnvironmentId,
  cwd: string,
  selectedPath: string | null,
  revision: string | null,
) => JSON.stringify([environmentId, cwd, selectedPath, revision]);

/**
 * Lists the root, every expanded directory, and the selected file's ancestors.
 * `revision` is the workspace mutation id; a new one refetches every listing.
 */
export function useDirectoryEntries(
  environmentId: EnvironmentId,
  cwd: string,
  selectedPath: string | null,
  revision: string | null,
) {
  const tree = useAtomValue(
    directoryTreeAtom(directoryTreeKey(environmentId, cwd, selectedPath, revision)),
  );
  const refresh = () => {
    const expanded = appAtomRegistry.get(expandedDirectoriesAtom(treeKey(environmentId, cwd)));
    const reachable = new Set(["", ...tree.entries.map((entry) => entry.path)]);
    for (const directoryPath of requestedDirectories(expanded, selectedPath)) {
      if (reachable.has(directoryPath)) {
        appAtomRegistry.refresh(listEntriesAtom(environmentId, cwd, directoryPath));
      }
    }
  };
  return { ...tree, refresh };
}

const hasNode = (atom: Atom.Atom<unknown>) =>
  appAtomRegistry
    .getNodes()
    .has(Atom.isSerializable(atom) ? atom[Atom.SerializableTypeId].key : atom);

/**
 * Refetches the listings that already answered, for a panel that opens on
 * cached listings: edits made outside T3 Code bump no mutation id. A listing
 * nobody has read is left to start on its own.
 */
export function revalidateDirectoryTree(environmentId: EnvironmentId, cwd: string) {
  const expanded = appAtomRegistry.get(expandedDirectoriesAtom(treeKey(environmentId, cwd)));
  for (const directoryPath of ["", ...expanded]) {
    const atom = listEntriesAtom(environmentId, cwd, directoryPath);
    if (!hasNode(atom)) continue;
    const result = appAtomRegistry.get(atom);
    if (AsyncResult.isSuccess(result) && !result.waiting) appAtomRegistry.refresh(atom);
  }
}

const loadingExpandedDirectoriesAtom = Atom.family((key: string) => {
  const [environmentId, cwd] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const { results, deferred } = readListings(
      get,
      environmentId,
      cwd,
      get(expandedDirectoriesAtom(key)),
    );
    const loading = [...deferred];
    for (const [directoryPath, result] of results) {
      if (!AsyncResult.isFailure(result) && Option.isNone(AsyncResult.value(result))) {
        loading.push(directoryPath);
      }
    }
    // A string snapshot so listeners only hear real changes in the loading set.
    return loading.toSorted().join("\0");
  }).pipe(Atom.withLabel(`web:file-tree:loading:${key}`));
});

/** For row renderers that the tree model calls outside React renders. */
export function isDirectoryLoading(environmentId: EnvironmentId, cwd: string, path: string) {
  const loading = appAtomRegistry.get(loadingExpandedDirectoriesAtom(treeKey(environmentId, cwd)));
  return loading.split("\0").includes(path);
}

/** Fires when an expanded directory starts or finishes its first listing. */
export function subscribeDirectoryLoading(
  environmentId: EnvironmentId,
  cwd: string,
  listener: () => void,
): () => void {
  return appAtomRegistry.subscribe(
    loadingExpandedDirectoriesAtom(treeKey(environmentId, cwd)),
    listener,
  );
}

/**
 * Records directories the tree has shown expanded; listing follows from the tree atom.
 * Collapsing keeps a directory listed, so its subtree and expansion survive.
 */
export function addExpandedDirectories(
  environmentId: EnvironmentId,
  cwd: string,
  directoryPaths: Iterable<string>,
) {
  const atom = expandedDirectoriesAtom(treeKey(environmentId, cwd));
  const current = appAtomRegistry.get(atom);
  const added = [...directoryPaths].filter((path) => !current.has(path));
  if (added.length > 0) appAtomRegistry.set(atom, new Set([...current, ...added]));
}
