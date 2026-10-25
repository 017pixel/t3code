import { environmentEndpointUrl } from "@t3tools/shared/advertisedEndpoint";

export * from "@t3tools/shared/advertisedEndpoint";

/**
 * The URL a DPoP proof must name for `requestUrl`. A captain route sends the request to
 * `<captain>/api/mesh/via/<handle>/<id>/...`, but the captain forwards it with the member's Connect
 * host, so the member checks the proof against `proofBaseUrl` plus the same path.
 */
export function environmentProofUrl(
  requestUrl: string,
  base: { readonly httpBaseUrl: string; readonly proofBaseUrl?: string | undefined },
): string {
  if (base.proofBaseUrl === undefined) return requestUrl;
  const request = new URL(requestUrl);
  const route = new URL(base.httpBaseUrl);
  const routePath = route.pathname.replace(/\/+$/, "");
  const sameOrigin =
    request.host === route.host &&
    request.protocol.replace(/^ws/, "http") === route.protocol.replace(/^ws/, "http");
  if (
    !sameOrigin ||
    (request.pathname !== routePath && !request.pathname.startsWith(`${routePath}/`))
  ) {
    return requestUrl;
  }
  const path = request.pathname.slice(routePath.length) || "/";
  return environmentEndpointUrl(base.proofBaseUrl, `${path}${request.search}`);
}
