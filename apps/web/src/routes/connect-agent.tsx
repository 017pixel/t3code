import { createFileRoute } from "@tanstack/react-router";

import { ConnectAgentSurface, loadConnectAgentEntry } from "../components/auth/ConnectAgentSurface";

export const Route = createFileRoute("/connect-agent")({
  loaderDeps: ({ search }) => ({ search }),
  // One approval lookup per request; a reload of the same request must not fetch it again.
  staleTime: Number.POSITIVE_INFINITY,
  // Not awaited: the surface shows its checking state while the request loads.
  loader: ({ location }) => loadConnectAgentEntry(location.searchStr),
  component: ConnectAgentRouteView,
});

function ConnectAgentRouteView() {
  return <ConnectAgentSurface entry={Route.useLoaderData()} />;
}
