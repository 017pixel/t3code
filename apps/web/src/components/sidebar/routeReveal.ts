import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";

// AppSidebarLayout owns this so drawer and Settings remounts preserve the chosen project scope.
// Only route changes may widen that scope; scroll position is lost on remount.
// Leaving Settings commits the router's location before its matches, briefly hiding thread params.
// Ignore null keys so the same thread does not look new during that gap.
export interface SidebarRouteReveal {
  observedKey: string | null;
  pendingKey: string | null;
}

export function pendingSidebarRouteReveal(
  reveal: SidebarRouteReveal,
  routeKey: string | null,
): string | null {
  if (routeKey === null) return null;
  if (reveal.observedKey !== routeKey) {
    reveal.observedKey = routeKey;
    reveal.pendingKey = routeKey;
  }
  return reveal.pendingKey;
}

export function completeSidebarRouteReveal(reveal: SidebarRouteReveal): void {
  reveal.pendingKey = null;
}

type RevealableThread = Parameters<typeof filterSidebarV2VisibleThreads>[0][number];

// `reveal` is the render-time copy of the record. A route key it has not seen
// yet is pending even before the copy catches up, so the first render of a new
// route already widens the scope. Only a route reveal widens: the once-per-mount
// scroll never changes a scope the user chose.
export function resolveSidebarRouteReveal<T extends RevealableThread>(input: {
  readonly reveal: Readonly<SidebarRouteReveal>;
  readonly routeKey: string | null;
  readonly isSearching: boolean;
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly findThread: (key: string) => T | undefined;
}): { readonly pendingKey: string | null; readonly widensScope: boolean } {
  const { reveal, routeKey, isSearching, scopedProjectKeys, findThread } = input;
  const pendingKey =
    routeKey !== null && reveal.observedKey === routeKey ? reveal.pendingKey : routeKey;
  // Search results replace the thread list; the reveal waits for it to return.
  const thread = pendingKey === null || isSearching ? undefined : findThread(pendingKey);
  const widensScope =
    thread !== undefined &&
    scopedProjectKeys !== null &&
    filterSidebarV2VisibleThreads([thread], scopedProjectKeys).length === 0 &&
    filterSidebarV2VisibleThreads([thread], null).length === 1;
  return { pendingKey, widensScope };
}
