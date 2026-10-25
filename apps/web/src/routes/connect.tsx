import { readConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { connectCliAuthRoutesEnabled } from "../cloud/connectCliAuth";
import {
  stopConnectCliAuthorization,
  watchConnectCliAuthorization,
} from "../cloud/connectCliAuthorization";
import { ConnectCliAuthorizeSurface } from "../components/cloud/ConnectCliAuthSurface";

export const Route = createFileRoute("/connect")({
  beforeLoad: () => {
    if (!connectCliAuthRoutesEnabled()) {
      throw redirect({ to: "/", replace: true });
    }
  },
  loader: ({ location }) =>
    readConnectAuthorizeRequest(new URL(location.href, window.location.origin)),
  // Hooks rather than the loader: they fire only for the committed match, never for preloads.
  onEnter: (match) => watchConnectCliAuthorization(match.loaderData ?? null),
  onStay: (match) => watchConnectCliAuthorization(match.loaderData ?? null),
  onLeave: stopConnectCliAuthorization,
  component: ConnectCliRouteView,
});

function ConnectCliRouteView() {
  return <ConnectCliAuthorizeSurface request={Route.useLoaderData()} />;
}
