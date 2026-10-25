import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { useSyncExternalStore } from "react";

import { environmentCatalog } from "../connection/catalog";
import { createNewThreadHandler } from "../hooks/useHandleNewThread";
import type { AppRouter } from "../router";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells } from "../state/threads";
import { getFirstRunGateView, subscribeFirstRunGate } from "./onboarding/firstRunGateStore";
import { sortScopedProjectsForSidebar } from "./Sidebar.logic";

/** What the index route shows for one visit to "/", keyed by its history entry. */
export interface IndexDraftStartState {
  readonly locationKey: string;
  readonly status: "starting" | "failed";
}

const listeners = new Set<() => void>();
let state: IndexDraftStartState | null = null;

function setState(next: IndexDraftStartState | null): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getState = () => state;

export function useIndexDraftStartFailed(): boolean {
  const current = useSyncExternalStore(subscribe, getState, getState);
  return current?.status === "failed";
}

function mostRecentIndexProject(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: Parameters<typeof sortScopedProjectsForSidebar>[1],
): EnvironmentProject | null {
  return sortScopedProjectsForSidebar(projects, threads, "updated_at")[0] ?? null;
}

let retry: (() => void) | null = null;

export function retryIndexDraftStart(): void {
  retry?.();
}

/**
 * Home opens a draft in the most recent project. It starts only while "/" is what the app shell
 * shows: the first-run gate renders nothing there while it decides or owes the wizard, and the
 * hosted app has no projects to pick from until its environment catalog is ready.
 */
export function startIndexDraftStart(router: AppRouter): () => void {
  const handleNewThread = createNewThreadHandler(router);

  const locationKey = () => router.state.location.state.__TSR_key ?? router.state.location.href;

  const sync = () => {
    if (router.state.location.pathname !== "/") {
      // A later visit home starts afresh, as a remounted page would.
      if (state?.status === "failed") setState(null);
      return;
    }
    const key = locationKey();
    if (state !== null && state.locationKey === key) return;
    if (getFirstRunGateView().kind !== "app") return;
    const authGateState = router.state.matches[0]?.context.authGateState;
    if (
      authGateState?.status === "hosted-static" &&
      !appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady
    ) {
      return;
    }
    const project = mostRecentIndexProject(
      appAtomRegistry.get(environmentProjects.projectsAtom),
      appAtomRegistry.get(environmentThreadShells.threadShellsAtom),
    );
    if (project === null) return;
    const projectRef = scopeProjectRef(project.environmentId, project.id);
    if (readProject(projectRef) === null) return;

    setState({ locationKey: key, status: "starting" });
    void handleNewThread(projectRef, { replace: true })
      .then((opened) => {
        // The handler gives up when the route or project changed under it; try again if home
        // is still showing.
        if (opened === null && state?.locationKey === key) {
          setState(null);
          sync();
        }
      })
      .catch(() => {
        if (state?.locationKey === key) setState({ locationKey: key, status: "failed" });
      });
  };

  retry = () => {
    setState(null);
    sync();
  };

  const unsubscribers = [
    router.subscribe("onResolved", sync),
    subscribeFirstRunGate(sync),
    appAtomRegistry.subscribe(environmentProjects.projectsAtom, sync),
    appAtomRegistry.subscribe(environmentThreadShells.threadShellsAtom, sync),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, sync),
  ];
  sync();
  return () => {
    retry = null;
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
