import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type { EnvironmentId, ProjectEntry, ScopedThreadRef } from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Cause from "effect/Cause";
import { ChevronsDownUp, ChevronsUpDown } from "lucide";
import { useEffect, useRef, useState } from "react";

import { selectSelectedRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import { MorphIcon } from "~/components/MorphIcon";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { joinHostPath, retainedBreadcrumbTrail, trailChildOf } from "./filePath";
import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import { buildFileTreePathUpdates } from "./fileTreePathReconciliation";
import {
  addExpandedDirectories,
  isDirectoryLoading,
  revalidateDirectoryTree,
  subscribeDirectoryLoading,
  useDirectoryEntries,
} from "./useDirectoryEntries";
import { useProjectPathSearch } from "~/state/queries";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  selectedPath: string | null;
  /** The thread whose file tabs this tree reveals as they open or are re-requested. */
  threadRef: ScopedThreadRef;
  onOpenFile: (relativePath: string) => void;
  /** Host-folder entries use absolute paths. Avoid full traversal: disable expand-all and search only
   * loaded folders. */
  hostFolder?: boolean;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

function treePath(entry: ProjectEntry): string {
  return entry.kind === "directory" ? `${entry.path}/` : entry.path;
}

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup variant="ghost" className="h-7 min-w-0 flex-1">
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

function buildTreeEntries(
  directoryEntries: readonly ProjectEntry[],
  searchEntries: readonly ProjectEntry[],
  searchPending: boolean,
  query: string,
) {
  const result = new Map(directoryEntries.map((entry) => [entry.path, entry]));
  if (query.trim() && !searchPending) {
    for (const entry of searchEntries) {
      if (!result.has(entry.path)) result.set(entry.path, entry);
      const segments = entry.path.split("/");
      for (let index = 1; index < segments.length; index++) {
        const path = segments.slice(0, index).join("/");
        if (!result.has(path)) result.set(path, { path, kind: "directory" });
      }
    }
  }
  const entries = [...result.values()];
  const treePaths = entries.map(treePath);
  const directories = entries.filter((entry) => entry.kind === "directory");
  const directoryPaths = directories.map(treePath);
  // Expanding a folder lists it, and an ignored one such as `node_modules` can hold tens of
  // thousands, so expand all skips ignored folders. They still open by hand.
  const expandableDirectoryPaths = directories.filter((entry) => !entry.ignored).map(treePath);
  return { entries, treePaths, directoryPaths, expandableDirectoryPaths };
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  threadRef,
  onOpenFile,
  onRefreshSelectedFile,
  workspaceMutationId,
  hostFolder = false,
}: FileBrowserPanelProps) {
  // Primitives, so the tree's ref callback keeps its identity across renders.
  const { environmentId: threadEnvironmentId, threadId } = threadRef;
  const revealThreadRef = { environmentId: threadEnvironmentId, threadId };
  const panelPath = (relativePath: string) =>
    hostFolder ? joinHostPath(cwd, relativePath) : relativePath;
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const fileContextMenu = useFileContextMenu(environmentId);
  const {
    entries: directoryEntries,
    refresh,
    ready,
    error,
    isPending,
  } = useDirectoryEntries(environmentId, cwd, selectedPath, workspaceMutationId);
  const [query, setQuery] = useState("");
  const [expandAll, setExpandAll] = useState(false);
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd: hostFolder ? null : cwd, query: query.slice(0, 256) },
    200,
    { revision: workspaceMutationId },
  );
  const { entries, treePaths, directoryPaths, expandableDirectoryPaths } = buildTreeEntries(
    directoryEntries,
    pathSearch.entries,
    pathSearch.isPending,
    query,
  );
  const previousTreePathsRef = useRef<readonly string[] | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  // A reveal whose row the tree does not hold yet; the path reconcile applies it.
  const pendingRevealRef = useRef<string | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // the panel root captures the right-click position; contextmenu is a
  // composed event, so the capture phase sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);

  const showEntryContextMenu = useStableCallback(
    (item: TreeContextMenuItem, context: TreeContextMenuOpenContext) => {
      const api = readLocalApi();
      if (!api) {
        context.close();
        return;
      }
      const relativePath = item.path.replace(/\/$/, "");
      const mention = serializeComposerFileLink(panelPath(relativePath));
      const pointer = contextMenuPointerRef.current;
      const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
      const anchorRect = context.anchorElement.getBoundingClientRect();
      const position = pointerIsFresh
        ? { x: pointer.x, y: pointer.y }
        : { x: anchorRect.left, y: anchorRect.bottom };
      const fileTarget = { environmentId, filePath: relativePath, workspaceRoot: cwd };
      const fileMenuItems = fileContextMenu.buildItems(fileTarget);
      void settlePromise(async () => {
        const clicked = await api.contextMenu.show(
          [
            ...fileMenuItems,
            { id: "copy-mention", label: "Copy mention" },
            { id: "add-to-chat", label: "Add to chat" },
          ],
          position,
        );
        if (clicked === null) return;
        // Open-with submenu ids are absent from the top-level item list.
        const isFileMenuAction =
          fileMenuItems.some((entry) => entry.id === clicked) || clicked.startsWith("editor:");
        if (isFileMenuAction) {
          await fileContextMenu.activate(clicked as FileContextMenuAction, fileTarget);
          return;
        }
        if (clicked === "copy-mention") {
          try {
            await writeTextToClipboard(mention);
            toastManager.add({
              type: "success",
              title: "Mention copied",
              description: relativePath,
            });
          } catch (error) {
            toastManager.add({
              type: "error",
              title: "Failed to copy mention",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          }
          return;
        }
        if (clicked === "add-to-chat") {
          const composer = composerRef?.current;
          if (!composer) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "Open a chat for this project and try again.",
            });
            return;
          }
          const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
          if (!inserted) {
            toastManager.add({
              type: "error",
              title: "Unable to add to chat",
              description: "The chat isn't ready to accept input right now.",
            });
          }
        }
      }).then((result) => {
        context.close();
        if (!AsyncResult.isSuccess(result)) throw Cause.squash(result.cause);
      });
    },
  );

  const dragMention = createFileTreeDragMentionController(
    hostFolder ? { mentionPath: (path: string) => joinHostPath(cwd, path) } : {},
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          showEntryContextMenu(item, context);
        },
      },
    },
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: true,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // Update drag selection even for reveals so subsequent drags cannot use stale paths.
      dragMention.handleSelectionChange(selectedPaths);
      if (syncingSelectionRef.current) return;
      if (dragMention.isDragInProgress()) {
        return;
      }
      // Directories are registered with a trailing slash (see treePath), so a bare path is a file.
      const selectedPath = selectedPaths.at(-1);
      if (selectedPath && !selectedPath.endsWith("/")) {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(panelPath(selectedPath));
      }
    },
    paths: [],
    renderRowDecoration: ({ item, row }) =>
      row.kind === "directory" &&
      row.isExpanded &&
      isDirectoryLoading(environmentId, cwd, item.path.replace(/\/$/, ""))
        ? { icon: "t3-tree-icon-loading", title: "Loading…" }
        : null,
    search: false,
    onSearchChange: (value) => setQuery(value ?? ""),
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const search = useFileTreeSearch(model);
  // Pierre restores the unfiltered tree when a search has no matches.
  const hasNoSearchMatches = search.value.trim().length > 0 && search.matchingPaths.length === 0;
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, expandableDirectoryPaths),
  );
  const toggleAllDirectories = () => {
    const expanded = !(expandAll || allDirectoriesExpanded);
    setExpandAll(expanded);
    setAllDirectoriesExpanded(
      model,
      expanded ? expandableDirectoryPaths : directoryPaths,
      expanded,
    );
  };
  const closeSearch = () => {
    setQuery("");
    search.close();
  };
  // The tab a request opens names a path in the panel's terms: a host folder's
  // tree selects the entry on the way back down its breadcrumb trail.
  const revealRequestOf = (state: ReturnType<typeof useRightPanelStore.getState>) => {
    const surface = selectSelectedRightPanelSurface(state.byThreadKey, revealThreadRef);
    if (surface?.kind !== "file" || surface.attachment !== undefined) return null;
    const path = hostFolder
      ? trailChildOf(cwd, retainedBreadcrumbTrail(surface.folderTrail, surface.relativePath))
      : surface.relativePath;
    return path ? { key: `${surface.id}\0${surface.revealRequestId}`, path } : null;
  };
  const revealInTree = (path: string): boolean => {
    const selectedItem = model.getItem(`${path}/`) ?? model.getItem(path);
    if (!selectedItem) return false;
    const selectedTreePath = selectedItem.isDirectory() ? `${path}/` : path;

    // Reveal only external selections; tree selections are visible and re-revealing would close search.
    const selectedInTree = model
      .getSelectedPaths()
      .some((selected) => selected.replace(/\/$/, "") === path);
    const fromTree = selectedInTree && treeSelectionPathRef.current === path;
    treeSelectionPathRef.current = null;
    if (fromTree) return true;

    syncingSelectionRef.current = true;
    setQuery("");
    model.closeSearch();
    for (const selected of model.getSelectedPaths()) {
      model.getItem(selected)?.deselect();
    }

    // Directory paths include trailing slashes; ancestor lookups must match.
    const segments = path.split("/");
    let ancestorPath = "";
    for (const segment of segments.slice(0, -1)) {
      ancestorPath = ancestorPath ? `${ancestorPath}/${segment}` : segment;
      const item = model.getItem(`${ancestorPath}/`) ?? model.getItem(ancestorPath);
      if (item && "expand" in item) item.expand();
    }

    if ("expand" in selectedItem) selectedItem.expand();
    selectedItem.select();
    model.scrollToPath(selectedTreePath, {
      focus: true,
      offset: "center",
    });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
    return true;
  };
  const requestReveal = (path: string) => {
    pendingRevealRef.current = revealInTree(path) ? null : path;
  };
  // Owns the tree model's listeners for the panel's lifetime. Pierre has no expand
  // callback, so expansion is read from model updates; loading rows repaint when an
  // expanded directory's first listing starts or lands.
  const observeTreeModel = () => {
    const expandedPaths = new Set<string>();
    const recordExpansion = () => {
      if (model.isSearchOpen()) return;
      const expanded = new Set<string>();
      for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
        if (row.kind === "directory" && row.isExpanded) expanded.add(row.path.replace(/\/$/, ""));
      }
      for (const path of expandedPaths) {
        if (expanded.has(path)) continue;
        const item = model.getItem(`${path}/`);
        // A collapsed folder ends expand-all; one that scrolled out of the tree does not.
        if (item?.isDirectory() && "isExpanded" in item && !item.isExpanded()) setExpandAll(false);
        expandedPaths.delete(path);
      }
      for (const path of expanded) expandedPaths.add(path);
      addExpandedDirectories(environmentId, cwd, expanded);
    };
    recordExpansion();
    const unsubscribeModel = model.subscribe(recordExpansion);
    const unsubscribeLoading = subscribeDirectoryLoading(environmentId, cwd, () =>
      model.setComposition(model.getComposition()),
    );
    // Opening the panel shows cached listings, and edits made outside T3 Code bump no
    // mutation id, so the listings it already holds revalidate.
    revalidateDirectoryTree(environmentId, cwd);
    let request = revealRequestOf(useRightPanelStore.getState());
    if (request !== null) requestReveal(request.path);
    const unsubscribeReveals = useRightPanelStore.subscribe((state) => {
      const next = revealRequestOf(state);
      if (next?.key === request?.key) return;
      request = next;
      // A surface that is no longer a reveal target drops a reveal still waiting for its rows.
      if (next === null) pendingRevealRef.current = null;
      else requestReveal(next.path);
    });
    return () => {
      unsubscribeModel();
      unsubscribeLoading();
      unsubscribeReveals();
    };
  };
  const handleSearchValueChange = (value: string) => {
    setQuery(value);
    if (value.trim().length === 0) {
      search.close();
      return;
    }
    search.setValue(value);
  };
  const handleRefresh = () => {
    refresh();
    if (query.trim()) pathSearch.refresh();
    onRefreshSelectedFile?.();
  };

  useEffect(() => {
    if (!ready) return;
    if (previousTreePathsRef.current === treePaths) return;
    const previousTreePaths = previousTreePathsRef.current;
    previousTreePathsRef.current = treePaths;
    if (previousTreePaths === null) {
      model.resetPaths(treePaths);
    } else {
      const updates = buildFileTreePathUpdates(previousTreePaths, treePaths);
      if (updates.length > 0) model.batch(updates);
    }
    // treePaths is rebuilt whenever entries load or the query changes, so this
    // also expands folders that arrive, and the tree left when a search clears.
    if (expandAll && !query.trim()) {
      setAllDirectoriesExpanded(model, expandableDirectoryPaths, true);
    }
    model.setGitStatus(
      entries
        .filter((entry) => entry.ignored)
        .map((entry) => ({ path: treePath(entry), status: "ignored" })),
    );
    const pendingReveal = pendingRevealRef.current;
    if (pendingReveal !== null && revealInTree(pendingReveal)) pendingRevealRef.current = null;
  }, [ready, entries, expandableDirectoryPaths, expandAll, model, query, revealInTree, treePaths]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
      ref={observeTreeModel}
      onContextMenuCapture={(event) => {
        contextMenuPointerRef.current = {
          x: event.clientX,
          y: event.clientY,
          at: event.timeStamp,
        };
      }}
      // Capture dragstart before the tree selects the row so selection sees the drag flag.
      onDragStartCapture={(event) => dragMention.handleDragStart(event.nativeEvent)}
      onDragEnd={() => dragMention.handleDragEnd((path) => model.getItem(path)?.deselect())}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-1 in-data-[preview-panel-mode=inline]:h-9 in-data-[preview-panel-mode=inline]:min-h-9 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <RefreshFilesButton isPending={isPending} onRefresh={handleRefresh} />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={search.value}
          onValueChange={handleSearchValueChange}
          onClose={closeSearch}
        />
        {directoryPaths.length > 0 && !hostFolder ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    expandAll || allDirectoriesExpanded
                      ? "Collapse all folders"
                      : "Expand all folders"
                  }
                  onClick={toggleAllDirectories}
                />
              }
            >
              <MorphIcon
                className="size-3.5"
                icon={allDirectoriesExpanded ? ChevronsDownUp : ChevronsUpDown}
              />
            </TooltipTrigger>
            <TooltipPopup>
              {expandAll || allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      {error || pathSearch.error ? (
        <button
          type="button"
          onClick={handleRefresh}
          className="p-4 text-left text-xs leading-relaxed text-destructive"
        >
          {error ?? pathSearch.error} Click to retry.
        </button>
      ) : null}
      {query.trim() && pathSearch.truncated && !pathSearch.isPending ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">
          More matches available. Refine your search.
        </div>
      ) : null}
      {(!ready || pathSearch.isPending) && (
        <div
          role="status"
          className={
            entries.length > 0 && !hasNoSearchMatches
              ? "sr-only"
              : "px-3 py-1 text-xs text-muted-foreground"
          }
        >
          Loading files…
        </div>
      )}
      {hasNoSearchMatches ? (
        ready && !isPending && !pathSearch.isPending && !error && !pathSearch.error ? (
          <div role="status" className="px-3 py-4 text-xs text-muted-foreground">
            No matching files.
          </div>
        ) : null
      ) : (
        <FileTree
          model={model}
          aria-label={`${projectName} files`}
          className="min-h-0 flex-1 overflow-hidden"
          style={pierreTreeStyle(resolvedTheme)}
        />
      )}
    </div>
  );
}
