import React from "react";
import ReactDOM from "react-dom/client";
import { createHashHistory, createBrowserHistory } from "@tanstack/react-router";

import "./index.css";

import { prepareProviderAuthDelivery } from "./providerAuthDelivery";
import { isElectron } from "./env";
import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { getRouter } from "./router";
import {
  syncDocumentElectronPlatformClasses,
  syncDocumentWindowControlsOverlayClass,
} from "./lib/windowControlsOverlay";
import { AppRoot } from "./AppRoot";
import {
  clearChunkReloadGuardAfterStartup,
  isChunkReloadScheduled,
  isSpeculativeLoadFailure,
  isSpeculativeLoadPending,
  recoverChunkLoadError,
} from "./lib/chunkReloadGuard";

prepareProviderAuthDelivery();

// Electron loads the app from a file-backed shell, so hash history avoids path resolution issues.
const history = isElectron ? createHashHistory() : createBrowserHistory();

const router = getRouter(history);

if (isElectron) {
  syncDocumentElectronPlatformClasses(navigator.platform);
  syncDocumentWindowControlsOverlayClass();
}

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

window.addEventListener("vite:preloadError", (event) => {
  if (!isSpeculativeLoadPending()) {
    if (recoverChunkLoadError()) event.preventDefault();
    return;
  }
  // The import rejects after this event. Wait for its owner to identify a failed preload.
  setTimeout(() => {
    if (!isSpeculativeLoadFailure(event.payload)) recoverChunkLoadError();
  }, 0);
});

const app = <AppRoot router={router} />;

// Loading only the selected runtime as a split chunk keeps every Clerk byte out
// of the startup graph for local-mode users, and keeps the bundled clerk-js out
// of the browser build entirely.
const managedAuthShellModule =
  clerkPublishableKey && hasCloudPublicConfig()
    ? isElectron
      ? import("./components/clerk/ElectronManagedAuthShell")
      : import("./components/clerk/BrowserManagedAuthShell")
    : null;

export const startup = Promise.all([
  managedAuthShellModule?.then((module) => module.default) ?? null,
  router.load(),
])
  .then(([ManagedAuthShell]) => {
    // A route chunk failure still resolves router.load(): the error is parked in
    // the lazy component and surfaces through the route error boundary.
    if (isChunkReloadScheduled()) return;
    clearChunkReloadGuardAfterStartup();
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  })
  .catch((error: unknown) => {
    if (isChunkReloadScheduled()) return;
    throw error;
  });
