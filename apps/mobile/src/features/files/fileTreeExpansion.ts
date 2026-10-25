export interface FileTreeExpansion {
  /** Environment and cwd the expansion belongs to; a new tree starts collapsed. */
  readonly scopeKey: string;
  /** The selection whose ancestors were last expanded. */
  readonly selectedPath: string | null;
  readonly expanded: ReadonlySet<string>;
}

export function ancestorPaths(path: string): ReadonlyArray<string> {
  const parts = path.split("/").filter(Boolean);
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join("/"));
  }
  return ancestors;
}

/**
 * Expands the selected file's ancestors whenever the selection changes. The user
 * can collapse them afterwards; they only reopen for the next selection.
 */
export function followFileTreeSelection(
  current: FileTreeExpansion | null,
  scopeKey: string,
  selectedPath: string | null,
): FileTreeExpansion {
  const base =
    current !== null && current.scopeKey === scopeKey ? current.expanded : new Set<string>();
  if (current !== null && current.scopeKey === scopeKey && current.selectedPath === selectedPath) {
    return current;
  }
  const ancestors = selectedPath === null ? [] : ancestorPaths(selectedPath);
  const expanded = ancestors.every((ancestor) => base.has(ancestor))
    ? base
    : new Set([...base, ...ancestors]);
  return { scopeKey, selectedPath, expanded };
}

export function toggleFileTreeDirectory(
  current: FileTreeExpansion,
  path: string,
): FileTreeExpansion {
  const expanded = new Set(current.expanded);
  if (!expanded.delete(path)) expanded.add(path);
  return { ...current, expanded };
}
