import type { ConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";

import { resolveClerkSignInProps } from "../components/clerk/authRedirect";
import { isElectron } from "../env";
import { buildConnectCliClerkAuthorizeUrl, connectCliSignInRedirectUrl } from "./connectCliAuth";
import { type ManagedClerk, whenManagedClerk } from "./managedClerk";

export function openConnectCliSignIn(clerk: ManagedClerk, request: ConnectAuthorizeRequest): void {
  clerk.openSignIn(
    resolveClerkSignInProps(connectCliSignInRedirectUrl(request, window.location.href), isElectron),
  );
}

interface ConnectCliAuthorizationWatch {
  readonly state: string;
  stopped: boolean;
  signInOpened: boolean;
  redirecting: boolean;
  unsubscribe: (() => void) | null;
}

let activeWatch: ConnectCliAuthorizationWatch | null = null;

/**
 * Drives one /connect visit from Clerk's own listener: opens sign-in once
 * Clerk loads signed out, and leaves for the authorize URL once signed in.
 * Keyed by the request's `state` so route reloads for the same request keep
 * the watch (and do not reopen sign-in).
 */
export function watchConnectCliAuthorization(request: ConnectAuthorizeRequest | null): void {
  if (request && activeWatch?.state === request.state) return;
  stopConnectCliAuthorization();
  if (!request) return;

  const watch: ConnectCliAuthorizationWatch = {
    state: request.state,
    stopped: false,
    signInOpened: false,
    redirecting: false,
    unsubscribe: null,
  };
  activeWatch = watch;

  // The route loads before ClerkProvider renders, so the instance arrives later.
  void whenManagedClerk().then((clerk) => {
    if (watch.stopped) return;
    watch.unsubscribe = clerk.addListener((resources) => {
      // Clerk reports `user: undefined` until it loads.
      if (resources.user === undefined || watch.redirecting) return;
      if (!clerk.isSignedIn) {
        if (!watch.signInOpened) {
          watch.signInOpened = true;
          openConnectCliSignIn(clerk, request);
        }
        return;
      }
      const authorizeUrl = buildConnectCliClerkAuthorizeUrl(request);
      if (!authorizeUrl) return;
      watch.redirecting = true;
      window.location.assign(authorizeUrl);
    });
  });
}

export function stopConnectCliAuthorization(): void {
  const watch = activeWatch;
  if (!watch) return;
  activeWatch = null;
  watch.stopped = true;
  watch.unsubscribe?.();
}
