import { createFileRoute, redirect } from "@tanstack/react-router";

import {
  HostedPairingRouteSurface,
  PairingPendingSurface,
  PairingRouteSurface,
} from "../components/auth/PairingRouteSurface";
import {
  enterHostedPairRoute,
  enterPairRoute,
  leavePairRoute,
} from "../components/auth/pairingRouteEntry";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "hosted-pairing") {
      return {
        authGateState,
      };
    }

    if (
      authGateState.status === "authenticated" ||
      authGateState.status === "hosted-static" ||
      authGateState.status === "guest"
    ) {
      throw redirect({ to: "/", replace: true });
    }
    return {
      authGateState,
    };
  },
  // Not awaited: the surfaces show the attempt in progress and suspend on its result.
  loader: ({ context, preload }) => {
    if (preload) {
      return { hostedPairing: null, autoPairing: null };
    }
    return context.authGateState.status === "hosted-pairing"
      ? { hostedPairing: enterHostedPairRoute(), autoPairing: null }
      : { hostedPairing: null, autoPairing: enterPairRoute() };
  },
  onLeave: leavePairRoute,
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const { hostedPairing, autoPairing } = Route.useLoaderData();

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "hosted-pairing") {
    return <HostedPairingRouteSurface key={hostedPairing?.request.token} attempt={hostedPairing} />;
  }

  return (
    <PairingRouteSurface
      key={autoPairing?.credential}
      auth={authGateState.auth}
      autoPairing={autoPairing}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
