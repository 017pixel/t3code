import type { ScheduledTaskWebhookEndpoint } from "@t3tools/contracts";
import { environmentEndpointUrl } from "@t3tools/shared/advertisedEndpoint";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";

export interface WebhookAddress {
  readonly address: string;
  readonly copyable: boolean;
  readonly note: string | null;
}

/** `httpBaseUrl` names the environment itself, never a captain that forwards to it. */
export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Link this environment to T3 Connect for a public URL.",
    };
  }
  const url = new URL(environmentEndpointUrl(httpBaseUrl, endpoint.path));
  return {
    address: url.href,
    copyable: true,
    note: isLocalLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Link T3 Connect for a public URL."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Link T3 Connect for a public URL.",
  };
}
