import type {
  AdvertisedEndpoint,
  AdvertisedEndpointHostedHttpsCompatibility,
  AdvertisedEndpointProvider,
  AdvertisedEndpointReachability,
  AdvertisedEndpointSource,
  AdvertisedEndpointStatus,
} from "@t3tools/contracts";

export interface CreateAdvertisedEndpointInput {
  readonly id: string;
  readonly label: string;
  readonly provider: AdvertisedEndpointProvider;
  readonly httpBaseUrl: string;
  readonly reachability: AdvertisedEndpointReachability;
  readonly hostedHttpsCompatibility?: AdvertisedEndpointHostedHttpsCompatibility;
  readonly desktopCompatibility?: "compatible" | "unknown";
  readonly source: AdvertisedEndpointSource;
  readonly status?: AdvertisedEndpointStatus;
  readonly isDefault?: boolean;
  readonly description?: string;
}

function parseHttpBaseUrl(rawValue: string): URL {
  const url = new URL(rawValue);
  if (url.protocol === "ws:") {
    url.protocol = "http:";
  } else if (url.protocol === "wss:") {
    url.protocol = "https:";
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Endpoint must use HTTP or HTTPS. Received ${url.protocol}`);
  }

  url.search = "";
  url.hash = "";
  return url;
}

export function normalizeHttpBaseUrl(rawValue: string): string {
  const url = parseHttpBaseUrl(rawValue);
  url.pathname = "/";
  return url.toString();
}

/** Keeps the base path, so a captain route's socket stays under the captain's forwarding path. */
export function deriveWsBaseUrl(httpBaseUrl: string): string {
  const url = parseHttpBaseUrl(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/**
 * Resolves an environment path such as `/api/assets/...` (with any query) against a base URL and
 * keeps the base's own path. A captain route's base is `<captain>/api/mesh/via/<handle>/<id>`, so an
 * origin-only join would send the request to the captain itself. Absolute and protocol-relative
 * URLs resolve as usual.
 */
export function environmentEndpointUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (!path.startsWith("/") || path.startsWith("//")) return new URL(path, url).href;
  const target = new URL(path, "http://path.invalid");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${target.pathname}`;
  url.search = target.search;
  url.hash = target.hash;
  return url.href;
}

function classifyHostedHttpsCompatibility(
  httpBaseUrl: string,
  fallback: AdvertisedEndpointHostedHttpsCompatibility = "unknown",
): AdvertisedEndpointHostedHttpsCompatibility {
  const url = parseHttpBaseUrl(httpBaseUrl);
  if (url.protocol === "http:") {
    return "mixed-content-blocked";
  }
  return fallback === "mixed-content-blocked" ? "unknown" : fallback;
}

export function createAdvertisedEndpoint(input: CreateAdvertisedEndpointInput): AdvertisedEndpoint {
  const httpBaseUrl = normalizeHttpBaseUrl(input.httpBaseUrl);
  return {
    id: input.id,
    label: input.label,
    provider: input.provider,
    httpBaseUrl,
    wsBaseUrl: deriveWsBaseUrl(httpBaseUrl),
    reachability: input.reachability,
    compatibility: {
      hostedHttpsApp:
        input.hostedHttpsCompatibility ?? classifyHostedHttpsCompatibility(httpBaseUrl),
      desktopApp: input.desktopCompatibility ?? "compatible",
    },
    source: input.source,
    status: input.status ?? "available",
    ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
    ...(input.description === undefined ? {} : { description: input.description }),
  };
}
