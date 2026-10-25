import type { NavigationState, PartialState } from "@react-navigation/native";
import { StackActions } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { updateLinkedRoute } from "../../lib/appLinking";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { pairEnvironment } from "../../state/use-remote-environment-registry";

export type DevAutoConnectAttempt =
  | { readonly pairingUrl: string; readonly status: "connecting" }
  | { readonly pairingUrl: string; readonly status: "failed"; readonly error: string | null };

/** The pairing the dev deep link started, so the form it opens can show its progress. */
export const devAutoConnectAttemptAtom = Atom.make<DevAutoConnectAttempt | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:dev-auto-connect-attempt"),
);

// The pairing form is mounted both as a root sheet and inside the settings sheet.
const PAIRING_FORM_ROUTES = ["ConnectionsNew", "SettingsEnvironmentNew"];

function isAutoConnectFlag(value: unknown): boolean {
  return value === "1" || value === "true";
}

async function connect(pairingUrl: string, expectedEnvironmentId: EnvironmentId | undefined) {
  appAtomRegistry.set(devAutoConnectAttemptAtom, { pairingUrl, status: "connecting" });
  const outcome = await pairEnvironment(pairingUrl, expectedEnvironmentId);
  if (!outcome.ok) {
    appAtomRegistry.set(devAutoConnectAttemptAtom, {
      pairingUrl,
      status: "failed",
      error: outcome.error,
    });
    return;
  }
  appAtomRegistry.set(devAutoConnectAttemptAtom, null);
  whenRootNavigationReady(() => {
    const current = rootNavigationRef.getCurrentRoute()?.name;
    if (current === undefined || !PAIRING_FORM_ROUTES.includes(current)) return;
    // Return to whatever the link opened the sheet over.
    if (rootNavigationRef.canGoBack()) rootNavigationRef.goBack();
    else rootNavigationRef.dispatch(StackActions.replace("Home"));
  });
}

/**
 * `connections/new?pairingUrl=…&autoConnect=1` (or `settings/environment-new?…`)
 * lets development automation pair without tapping. The link itself starts the
 * pairing; the opened form only prefills and reports it. Production builds
 * ignore the flag so a link can never pair with an attacker-chosen host.
 */
export function startDevAutoConnect(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!__DEV__) return state;
  return updateLinkedRoute(state, PAIRING_FORM_ROUTES, (route) => {
    const { autoConnect, ...params } = (route.params ?? {}) as {
      readonly autoConnect?: unknown;
      readonly pairingUrl?: unknown;
      readonly routeFor?: EnvironmentId;
    };
    if (!isAutoConnectFlag(autoConnect)) return route;
    const pairingUrl = typeof params.pairingUrl === "string" ? params.pairingUrl.trim() : "";
    if (pairingUrl.length > 0) void connect(pairingUrl, params.routeFor);
    return { ...route, params };
  });
}
