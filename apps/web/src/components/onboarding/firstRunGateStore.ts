import { Atom } from "effect/reactivity";
import { useSyncExternalStore } from "react";

import {
  getClientSettings,
  getClientSettingsHydrationStatus,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "../../hooks/useSettings";
import { completeOnboarding } from "../../onboarding/firstRun";
import {
  isFirstRunWorkspaceProvenanceAuthoritative,
  isFreshFirstRunWorkspace,
  resolveFirstRunDecision,
  resolveHostedFirstRunDecision,
  transitionFirstRunGateState,
  type FirstRunGateState,
} from "../../onboarding/firstRun.logic";
import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import { allEnvironmentShellsBootstrappedAtom, environmentShell } from "../../state/shell";
import { environmentProjects } from "../../state/projects";
import { primaryServerConfigAtom, primaryServerWelcomeAtom } from "../../state/server";
import { environmentThreadShells } from "../../state/threads";

/**
 * Which first-run gate the root route renders, decided where the auth gate resolves:
 * the primary server's onboarding when authenticated, settings hydration alone for the
 * hosted static app, and no gate at all otherwise.
 */
export type FirstRunGateMode = "authenticated" | "hosted-static" | "off";

export type FirstRunGateView =
  | { readonly kind: "app" }
  | { readonly kind: "pending" }
  | { readonly kind: "wizard" }
  | { readonly kind: "connection-recovery" }
  | { readonly kind: "settings-recovery"; readonly retrying: boolean };

const FIRST_RUN_DECISION_TIMEOUT_MS = 4_000;

/** Routes the root renders outside the app shell, where nothing behind the gate is mounted. */
const ROUTES_OUTSIDE_APP_SHELL = new Set(["/pair", "/connect", "/connect-agent", "/welcome"]);

const primaryShellLiveAtom = Atom.make((get) => {
  const serverConfig = get(primaryServerConfigAtom);
  return (
    serverConfig !== null &&
    get(environmentShell.stateValueAtom(serverConfig.environment.environmentId)).status === "live"
  );
}).pipe(Atom.withLabel("web-onboarding-primary-shell-live"));

const workspaceEvidenceLiveAtom = Atom.make((get) => {
  const environmentIds = new Set([
    ...get(environmentProjects.projectsAtom).map((project) => project.environmentId),
    ...get(environmentThreadShells.threadShellsAtom).map((thread) => thread.environmentId),
  ]);

  for (const environmentId of environmentIds) {
    if (get(environmentShell.stateValueAtom(environmentId)).status !== "live") {
      return false;
    }
  }

  return true;
}).pipe(Atom.withLabel("web-onboarding-workspace-evidence-live"));

// The gate only needs how many threads exist and, while there is at most one, that thread;
// a shell update of any thread in a populated workspace must not re-run the decision.
const threadCountAtom = Atom.make(
  (get) => get(environmentThreadShells.threadShellsAtom).length,
).pipe(Atom.withLabel("web-onboarding-thread-count"));

const soleThreadAtom = Atom.make((get) => {
  const threads = get(environmentThreadShells.threadShellsAtom);
  return threads.length === 1 ? threads[0]! : null;
}).pipe(Atom.withLabel("web-onboarding-sole-thread"));

const firstRunEvidenceAtom = Atom.make((get): FirstRunEvidence => {
  const projects = get(environmentProjects.projectsAtom);
  const threadCount = get(threadCountAtom);
  const soleThread = get(soleThreadAtom);
  const serverConfig = get(primaryServerConfigAtom);
  const serverWelcome = get(primaryServerWelcomeAtom);
  // A workspace still counts as fresh when its only content is the server's own cwd
  // auto-bootstrap: web mode creates a project + thread from cwd at startup
  // (`autoBootstrapProjectFromCwd` defaults on there), so "no projects at all" would mean
  // `npx t3` users never see the wizard.
  const workspaceFresh =
    threadCount <= 1 &&
    isFreshFirstRunWorkspace({
      primaryEnvironmentId: serverConfig?.environment.environmentId ?? null,
      serverCwd: serverConfig?.cwd ?? null,
      bootstrapProjectId: serverWelcome?.bootstrapProjectId,
      bootstrapThreadId: serverWelcome?.bootstrapThreadId,
      bootstrapProjectCreated: serverWelcome?.bootstrapProjectCreated,
      bootstrapThreadCreated: serverWelcome?.bootstrapThreadCreated,
      projects,
      threads: soleThread === null ? [] : [soleThread],
    });
  return {
    bootstrapped: get(allEnvironmentShellsBootstrappedAtom),
    authoritative: get(primaryShellLiveAtom),
    workspaceAuthoritative: get(workspaceEvidenceLiveAtom),
    workspaceProvenanceAuthoritative: isFirstRunWorkspaceProvenanceAuthoritative({
      welcomeReceived: serverWelcome !== null,
      bootstrapStatus: serverWelcome?.bootstrapStatus ?? null,
    }),
    catalogReady: get(environmentCatalog.catalogValueAtom).isReady,
    serverConfigAvailable: serverConfig !== null,
    workspaceFresh,
    projectCount: projects.length,
    threadCount,
  };
}).pipe(Atom.withLabel("web-onboarding-evidence"));

type FirstRunEvidence = Omit<
  Parameters<typeof resolveFirstRunDecision>[0],
  "enabled" | "hydrated" | "completed"
>;

const NO_EVIDENCE: FirstRunEvidence = {
  bootstrapped: false,
  authoritative: false,
  workspaceAuthoritative: false,
  workspaceProvenanceAuthoritative: false,
  catalogReady: false,
  serverConfigAvailable: false,
  workspaceFresh: false,
  projectCount: 0,
  threadCount: 0,
};

let router: AppRouter | null = null;
let mode: FirstRunGateMode | null = null;
let gate: FirstRunGateState = { decision: "pending", stalled: false };
let view: FirstRunGateView = { kind: "pending" };
let appOpen = false;
let evidence: FirstRunEvidence = NO_EVIDENCE;
let stopEvidence: (() => void) | null = null;
let stallTimer: number | null = null;
let completing = false;
const listeners = new Set<() => void>();

function initialGateState(nextMode: FirstRunGateMode): FirstRunGateState {
  const completed =
    getClientSettingsHydrationStatus() === "ready" &&
    getClientSettings().onboardingCompletedAt !== null;
  return { decision: nextMode === "off" || completed ? "app" : "pending", stalled: false };
}

function resolveView(): FirstRunGateView {
  const status = getClientSettingsHydrationStatus();
  if (status === "failed" || status === "retrying") {
    return view.kind === "settings-recovery" && view.retrying === (status === "retrying")
      ? view
      : { kind: "settings-recovery", retrying: status === "retrying" };
  }
  const kind =
    gate.decision === "pending"
      ? gate.stalled
        ? "connection-recovery"
        : "pending"
      : gate.decision;
  return view.kind === kind ? view : { kind };
}

function reconcile(): void {
  if (mode === null) return;
  const hydrated = getClientSettingsHydrationStatus() === "ready";
  const completed = getClientSettings().onboardingCompletedAt !== null;

  // Workspace evidence only matters until onboarding is settled, so stop following every
  // project and thread shell once it is.
  const needsEvidence = mode === "authenticated" && hydrated && !completed;
  if (needsEvidence && stopEvidence === null) {
    stopEvidence = appAtomRegistry.subscribe(firstRunEvidenceAtom, (next) => {
      evidence = next;
      reconcile();
    });
    evidence = appAtomRegistry.get(firstRunEvidenceAtom);
  } else if (!needsEvidence && stopEvidence !== null) {
    stopEvidence();
    stopEvidence = null;
    evidence = NO_EVIDENCE;
  }

  const { decision, persistCompletion } =
    mode === "hosted-static"
      ? resolveHostedFirstRunDecision(hydrated)
      : resolveFirstRunDecision({
          enabled: mode === "authenticated",
          hydrated,
          completed,
          ...evidence,
        });

  const previousDecision = gate.decision;
  if (hydrated) gate = transitionFirstRunGateState(gate, { type: "evidence", decision });

  if (gate.decision !== "wizard" && hydrated && persistCompletion && !completed && !completing) {
    completing = true;
    void completeOnboarding()
      .catch(() => undefined)
      .finally(() => {
        completing = false;
      });
  }

  const shouldWatchStall =
    mode === "authenticated" && hydrated && gate.decision === "pending" && !gate.stalled;
  if (shouldWatchStall && stallTimer === null) {
    stallTimer = window.setTimeout(() => {
      stallTimer = null;
      gate = transitionFirstRunGateState(gate, { type: "timeout" });
      publish();
    }, FIRST_RUN_DECISION_TIMEOUT_MS);
  } else if (!shouldWatchStall && stallTimer !== null) {
    window.clearTimeout(stallTimer);
    stallTimer = null;
  }

  if (previousDecision !== "wizard") openOwedWizard();

  publish();
}

// Setup opens by itself only from the home route. A direct link, such as Settings, opens as
// asked so setup can never lock a user out of the app; a later visit home opens it then.
function openOwedWizard(): void {
  if (gate.decision === "wizard" && router?.state.location.pathname === "/") {
    void router.navigate({ to: "/welcome", replace: true });
  }
}

function publish(): void {
  const nextView = resolveView();
  const pathname = router?.state.location.pathname ?? "/";
  const nextAppOpen =
    mode === "authenticated" &&
    !ROUTES_OUTSIDE_APP_SHELL.has(pathname) &&
    (nextView.kind === "app" || (nextView.kind === "wizard" && pathname !== "/"));
  if (nextView === view && nextAppOpen === appOpen) return;
  view = nextView;
  appOpen = nextAppOpen;
  for (const listener of listeners) listener();
}

/** Called each time the root route resolves its auth gate. A new mode starts a fresh gate. */
export function setFirstRunGateMode(nextMode: FirstRunGateMode): void {
  if (mode === nextMode) return;
  mode = nextMode;
  gate = initialGateState(nextMode);
  reconcile();
}

export function subscribeFirstRunGate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getFirstRunGateView(): FirstRunGateView {
  return view;
}

export function useFirstRunGateView(): FirstRunGateView {
  return useSyncExternalStore(subscribeFirstRunGate, getFirstRunGateView, getFirstRunGateView);
}

/**
 * Runs `start` while the authenticated app shell is past the gate (and `readyAtom`, when given, holds), and
 * stops it otherwise: the lifetime the gate's children used to have.
 */
export function whileFirstRunAppOpen(
  start: () => () => void,
  readyAtom?: Atom.Atom<boolean>,
): () => void {
  let stop: (() => void) | null = null;
  const sync = () => {
    const ready = appOpen && (readyAtom === undefined || appAtomRegistry.get(readyAtom));
    if (ready && stop === null) {
      stop = start();
    } else if (!ready && stop !== null) {
      stop();
      stop = null;
    }
  };
  const unsubscribeGate = subscribeFirstRunGate(sync);
  const unsubscribeReady =
    readyAtom === undefined ? null : appAtomRegistry.subscribe(readyAtom, sync);
  sync();
  return () => {
    unsubscribeGate();
    unsubscribeReady?.();
    stop?.();
    stop = null;
  };
}

/** Follows settings hydration and the router so the gate decides without anything mounted. */
export function startFirstRunGate(appRouter: AppRouter): () => void {
  router = appRouter;
  const unsubscribeSettings = subscribeClientSettings(reconcile);
  const unsubscribeHydration = subscribeClientSettingsHydration(reconcile);
  const unsubscribeRouter = appRouter.subscribe("onResolved", () => {
    openOwedWizard();
    publish();
  });
  reconcile();
  return () => {
    unsubscribeSettings();
    unsubscribeHydration();
    unsubscribeRouter();
    stopEvidence?.();
    stopEvidence = null;
    if (stallTimer !== null) window.clearTimeout(stallTimer);
    stallTimer = null;
    router = null;
    mode = null;
    gate = { decision: "pending", stalled: false };
    view = { kind: "pending" };
    appOpen = false;
    evidence = NO_EVIDENCE;
    listeners.clear();
  };
}
