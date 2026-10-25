import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommand,
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import * as Effect from "effect/Effect";
import { Atom, type AsyncResult, AtomRegistry } from "effect/reactivity";
import * as Stream from "effect/Stream";

import { openFileInPreview, openUrlInPreview } from "../../browser/openFileInPreview";
import { isPreviewAvailableFor } from "../../browser/previewRuntime";
import { useComposerDraftStore } from "../../composerDraftStore";
import { createNewThreadHandler } from "../../hooks/useHandleNewThread";
import { createRouterScratchProject } from "../../hooks/useScratchProject";
import { getClientSettings } from "../../hooks/useSettings";
import { createOpenChangeRequestLink } from "../../lib/openPullRequestLink";
import { selectActiveRightPanelSurface, useRightPanelStore } from "../../rightPanelStore";
import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { assetEnvironment } from "../../state/assets";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { previewEnvironment } from "../../state/preview";
import { readPreparedConnection } from "../../state/session";
import { allReachableShellsLiveAtom } from "../../state/shell";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { whileFirstRunAppOpen } from "../onboarding/firstRunGateStore";

/** A link handed over by the OS is a plain click: nothing about it asks for the browser. */
const externalClick = {
  preventDefault() {},
  stopPropagation() {},
  metaKey: false,
  ctrlKey: false,
};

/** Resolves once every reachable environment has reported its projects or settled offline. */
const projectsSettled = (): Promise<void> =>
  Effect.runPromise(
    AtomRegistry.toStream(appAtomRegistry, allReachableShellsLiveAtom).pipe(
      Stream.filter((settled) => settled),
      Stream.runHead,
      Effect.asVoid,
    ),
  );

/**
 * HTML files are served by this machine's environment, so only its threads can
 * take them.
 */
function threadShowingBrowser(
  routeParams: Record<string, string | undefined>,
  fileEnvironmentId: EnvironmentId | null,
): ScopedThreadRef | null {
  const target = resolveThreadRouteTarget(routeParams);
  if (target === null) return null;
  let threadRef = target.kind === "server" ? target.threadRef : null;
  if (target.kind === "draft") {
    const session = useComposerDraftStore.getState().getDraftSession(target.draftId);
    if (!session || session.promotedTo) return null;
    threadRef = scopeThreadRef(session.environmentId, session.threadId);
  }
  if (threadRef === null || !isPreviewAvailableFor(threadRef.environmentId)) return null;
  if (fileEnvironmentId !== null && threadRef.environmentId !== fileEnvironmentId) return null;
  const surface = selectActiveRightPanelSurface(
    useRightPanelStore.getState().byThreadKey,
    threadRef,
  );
  return surface?.kind === "preview" ? threadRef : null;
}

const primaryWebLinksReadyAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return false;
  const presentation = get(environmentPresentations.presentationAtom(environmentId));
  return presentation?.connection.phase === "connected" && presentation.serverConfig !== null;
}).pipe(Atom.withLabel("web-desktop-web-links-ready"));

const reportFailure = (url: string, description = url) =>
  toastManager.add(
    stackedThreadToast({ type: "error", title: "Could not open the link", description }),
  );

const commandRunner =
  <W, A, E>(command: AtomCommand<W, A, E>) =>
  (value: W) =>
    runAtomCommand(appAtomRegistry, command, value, {
      label: command.label,
      reportFailure: false,
      reportDefect: true,
    });

const queryRunner =
  <T, A, E>(family: (target: T) => Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  (target: T) => {
    const atom = family(target);
    return executeAtomQuery(appAtomRegistry, atom, {
      label: atom.label?.[0] ?? "atom query",
      reportFailure: false,
      reportDefect: true,
      refresh: true,
    });
  };

/** Opens links the OS hands the desktop app, while the primary environment can take them. */
export function startDesktopWebLinks(router: AppRouter): () => void {
  const webLinks = window.desktopBridge?.webLinks;
  if (webLinks === undefined) return () => {};
  const openChangeRequest = createOpenChangeRequestLink(router);
  const { scratchEnvironmentId, openScratchProject } = createRouterScratchProject(router);
  const openThread = createNewThreadHandler(router);
  const openPreview = commandRunner(previewEnvironment.open);
  const createAssetUrl = queryRunner(assetEnvironment.createUrl);

  const startThread = async (url: string): Promise<ScopedThreadRef | null> => {
    const environmentId = scratchEnvironmentId(appAtomRegistry.get(primaryEnvironmentIdAtom));
    if (environmentId === null) {
      reportFailure(url);
      return null;
    }
    const project = await openScratchProject(environmentId, "Could not open the link");
    if (!project) return null;
    const opened = await openThread(scopeProjectRef(project.environmentId, project.id));
    if (!opened) {
      reportFailure(url);
      return null;
    }
    const threadRef = scopeThreadRef(project.environmentId, opened.threadId);
    useRightPanelStore.getState().setMaximized(threadRef, true);
    return threadRef;
  };

  const openLink = async (url: string) => {
    const appPath = promptLinkAppPath(url);
    if (appPath !== null) {
      await router.navigate({ href: appPath });
      return;
    }
    if (openChangeRequest(externalClick, url)) return;
    const isFile = url.startsWith("file:");
    const primaryEnvironmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
    const routeParams = router.state.matches.at(-1)?.params ?? {};
    const threadRef =
      threadShowingBrowser(routeParams, isFile ? primaryEnvironmentId : null) ??
      (await startThread(url));
    if (threadRef === null) return;
    const httpBaseUrl =
      primaryEnvironmentId === null
        ? null
        : (readPreparedConnection(primaryEnvironmentId)?.httpBaseUrl ?? null);
    const result = isFile
      ? httpBaseUrl === null
        ? null
        : await openFileInPreview({
            threadRef,
            filePath: decodeURIComponent(new URL(url).pathname),
            workspaceRoot: undefined,
            httpBaseUrl,
            createAssetUrl,
            openPreview,
          })
      : await openUrlInPreview({ threadRef, url, openPreview });
    if (result === null) {
      reportFailure(url);
      return;
    }
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      reportFailure(url, error instanceof Error ? error.message : url);
    }
  };

  let queue = Promise.resolve();
  const receiveLink = (url: string) => {
    // A connected server publishes its config before its project snapshot, so a PR link
    // delivered at launch would miss its project and fall through to the browser. Hold PR
    // links, and only those, until discovery settles; an ordinary link never waits for it.
    const hold =
      getClientSettings().pullRequestLinksOpenInApp &&
      sourceControlClients.parseChangeRequestUrl(url) !== null
        ? projectsSettled()
        : Promise.resolve();
    void hold.then(() => {
      queue = queue.then(() => openLink(url)).catch(() => undefined);
    });
  };

  return whileFirstRunAppOpen(() => {
    const unsubscribe = webLinks.onOpen(receiveLink);
    void webLinks.setReady(true).catch(() => undefined);
    return () => {
      void webLinks.setReady(false).catch(() => undefined);
      unsubscribe();
    };
  }, primaryWebLinksReadyAtom);
}
