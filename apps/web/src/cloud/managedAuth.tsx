import { useAuth, useClerk } from "@clerk/react";
import { ManagedRelay, setManagedRelaySession } from "@t3tools/client-runtime/relay";
import {
  reportAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";

import { environmentCatalog } from "../connection/catalog";
import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveRelayClerkTokenOptions } from "./publicConfig";

export function deactivateManagedRelayAuthentication(): void {
  setManagedRelaySession(appAtomRegistry, null);
}

export function activateManagedRelayAuthentication(
  accountId: string,
  readClerkToken: () => Promise<string | null>,
): void {
  setManagedRelaySession(appAtomRegistry, {
    accountId,
    readClerkToken,
  });
}

export function ManagedRelayAuthProvider({ children }: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({
    treatPendingAsSignedOut: false,
  });
  const clerk = useClerk();
  // Clerk's status cannot prove its API answered: while offline it reports "ready" with an empty,
  // id-less client, and a failed launch fetch reports "degraded" with a "client_init" placeholder
  // built from the session cookie. A real /v1/client response always carries its own id, and can
  // arrive later while the status stays "degraded".
  const clerkApiAnswered = useSyncExternalStore(
    (onChange) => clerk.addListener(onChange),
    () => {
      const clientId = clerk.client?.id;
      return Boolean(clientId) && clientId !== "client_init";
    },
  );
  const signedOutByClerkApi = !(isSignedIn && userId) && clerkApiAnswered;
  const observedAccountRef = useRef<string | null | undefined>(undefined);
  const accountTransitionRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    let cancelled = false;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    // An unconfirmed sign-out stays unobserved so a later confirmed one still cleans up.
    const resolved = nextAccount !== null || previousAccount !== undefined || signedOutByClerkApi;
    observedAccountRef.current = resolved ? nextAccount : undefined;

    const queueAccountCleanup = () => {
      const previousTransition = accountTransitionRef.current ?? Promise.resolve();
      accountTransitionRef.current = previousTransition.then(async () => {
        const results = await Promise.all([
          // This provider mounts above AppAtomRegistryProvider, so a context-bound command would
          // clear a registry the rendered app never reads.
          runAtomCommand(appAtomRegistry, environmentCatalog.removeRelayEnvironments, undefined, {
            reportFailure: false,
            reportDefect: false,
          }),
          settleAsyncResult(() =>
            runtime.runPromiseExit(
              ManagedRelay.ManagedRelayClient.pipe(
                Effect.flatMap((client) => client.resetTokenCache),
              ),
            ),
          ),
        ]);
        for (const result of results) {
          reportAtomCommandResult(result, { label: "cloud account cleanup" });
        }
      });
      return accountTransitionRef.current;
    };

    if (!isSignedIn || !userId) {
      deactivateManagedRelayAuthentication();
      if (resolved && previousAccount !== null) {
        void queueAccountCleanup();
      }
    } else {
      const tokenProvider = () => getToken(resolveRelayClerkTokenOptions());
      const activateSession = () => {
        if (!cancelled) {
          activateManagedRelayAuthentication(userId, tokenProvider);
        }
      };
      const activateAfterTransition = (transition: Promise<void>) => {
        void (async () => {
          const result = await settlePromise(async () => {
            await transition;
            activateSession();
          });
          reportAtomCommandResult(result, { label: "cloud account activation" });
        })();
      };
      if (previousAccount !== undefined && previousAccount !== null && previousAccount !== userId) {
        deactivateManagedRelayAuthentication();
        activateAfterTransition(queueAccountCleanup());
      } else {
        activateAfterTransition(accountTransitionRef.current ?? Promise.resolve());
      }
    }
    return () => {
      cancelled = true;
    };
  }, [getToken, isLoaded, isSignedIn, signedOutByClerkApi, userId]);

  useEffect(() => () => deactivateManagedRelayAuthentication(), []);

  return children;
}
