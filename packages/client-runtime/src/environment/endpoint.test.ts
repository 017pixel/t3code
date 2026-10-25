import { EnvironmentId, meshViaBasePath } from "@t3tools/contracts";
import { previewPdfAssetUrl } from "@t3tools/shared/preview";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";

import { rpcSocketUrl } from "../authorization/remote.ts";
import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { makeEnvironmentHttpApiUrlBuilder } from "../rpc/http.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { resolveDeviceHubAccess } from "../state/deviceHubAccess.ts";
import {
  deriveWsBaseUrl,
  environmentEndpointUrl,
  environmentProofUrl,
  normalizeHttpBaseUrl,
} from "./endpoint.ts";

const MEMBER = EnvironmentId.make("member-1");
const CAPTAIN_BASE = `http://192.168.1.5:3773${meshViaBasePath("h+1", MEMBER)}`;
const CAPTAIN_PATH = "/api/mesh/via/h%2B1/member-1";

function prepared(httpBaseUrl: string): PreparedConnection {
  return {
    environmentId: MEMBER,
    label: "Member",
    httpBaseUrl,
    socketUrl: "ws://unused.invalid/ws",
    httpAuthorization: null,
    target: new BearerConnectionTarget({
      environmentId: MEMBER,
      label: "Member",
      connectionId: "c",
    }),
  };
}

const deviceHub = (httpBaseUrl: string) =>
  resolveDeviceHubAccess({ prepared: prepared(httpBaseUrl), hubBasePath: "/api/device-hub" }).pipe(
    Effect.provide(FetchHttpClient.layer),
  );

describe("advertised endpoint helpers", () => {
  it("normalizes HTTP and WebSocket base URLs", () => {
    expect(normalizeHttpBaseUrl("https://example.com/path?x=1#hash")).toBe("https://example.com/");
    expect(normalizeHttpBaseUrl("wss://example.com/socket")).toBe("https://example.com/");
    expect(deriveWsBaseUrl("https://example.com/?x=1")).toBe("wss://example.com/");
    expect(deriveWsBaseUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773/");
  });
});

// A captain route's base is `<captain>/api/mesh/via/<handle>/<id>`. A builder that drops it
// reaches the captain itself instead of the member.
describe("client URL builders", () => {
  it.effect("keep a captain route's base path", () =>
    Effect.gen(function* () {
      for (const base of [CAPTAIN_BASE, `${CAPTAIN_BASE}/`]) {
        const prefix = `http://192.168.1.5:3773${CAPTAIN_PATH}`;
        expect(environmentEndpointUrl(base, "/.well-known/t3/environment")).toBe(
          `${prefix}/.well-known/t3/environment`,
        );
        expect(
          makeEnvironmentHttpApiUrlBuilder(base).auth.webSocketTicketFor({
            params: { use: "rpc" },
          }),
        ).toBe(`${prefix}/api/auth/websocket-ticket/rpc`);
        expect(deriveWsBaseUrl(base)).toBe(
          `ws://192.168.1.5:3773${CAPTAIN_PATH}${base.endsWith("/") ? "/" : ""}`,
        );
        expect(rpcSocketUrl(deriveWsBaseUrl(base)).href).toBe(
          `ws://192.168.1.5:3773${CAPTAIN_PATH}/ws`,
        );
        expect(resolveAssetUrl(base, "/api/assets/a.png?token=t#f")).toBe(
          `${prefix}/api/assets/a.png?token=t#f`,
        );
        expect(previewPdfAssetUrl(`${prefix}/api/assets/doc.pdf?sig=1`, base)).toBe(
          `${prefix}/api/assets/doc.pdf?sig=1`,
        );
        expect(previewPdfAssetUrl("http://localhost:3773/api/assets/doc.pdf?sig=1", base)).toBe(
          `${prefix}/api/assets/doc.pdf?sig=1`,
        );
        const hub = yield* deviceHub(base);
        expect(hub.httpBase).toBe(`${prefix}/api/device-hub`);
        expect(hub.wsBase).toBe(`ws://192.168.1.5:3773${CAPTAIN_PATH}/api/device-hub`);
      }
    }),
  );

  it.effect("leave path-less bases as they were", () =>
    Effect.gen(function* () {
      const base = "http://127.0.0.1:3773/";
      expect(environmentEndpointUrl(base, "/oauth/token")).toBe(
        "http://127.0.0.1:3773/oauth/token",
      );
      expect(environmentEndpointUrl("https://host.test/?x=1#h", "/api/a")).toBe(
        "https://host.test/api/a",
      );
      expect(
        makeEnvironmentHttpApiUrlBuilder("https://host.test").auth.webSocketTicketFor({
          params: { use: "rpc" },
        }),
      ).toBe("https://host.test/api/auth/websocket-ticket/rpc");
      expect(rpcSocketUrl("wss://host.test/").href).toBe("wss://host.test/ws");
      // The relay names the socket itself, as does a custom socket path.
      expect(rpcSocketUrl("wss://tunnel.test/ws").href).toBe("wss://tunnel.test/ws");
      expect(rpcSocketUrl("wss://proxy.test/t3/socket").href).toBe("wss://proxy.test/t3/socket");
      expect(resolveAssetUrl(base, "/api/assets/a.png?token=t")).toBe(
        "http://127.0.0.1:3773/api/assets/a.png?token=t",
      );
      expect(resolveAssetUrl(base, "https://cdn.test/a.png")).toBe("https://cdn.test/a.png");
      expect(
        previewPdfAssetUrl("http://localhost:4000/api/assets/doc.pdf", "https://host.test/"),
      ).toBe("https://host.test/api/assets/doc.pdf");
      const hub = yield* deviceHub("https://host.test/");
      expect(hub.httpBase).toBe("https://host.test/api/device-hub");
      expect(hub.wsBase).toBe("wss://host.test/api/device-hub");
    }),
  );
});

describe("environmentProofUrl", () => {
  const base = { httpBaseUrl: CAPTAIN_BASE, proofBaseUrl: "https://member.t3.test/" };

  it("names the member's Connect URL for a request through the captain", () => {
    expect(environmentProofUrl(`${CAPTAIN_BASE}/api/auth/websocket-ticket/rpc`, base)).toBe(
      "https://member.t3.test/api/auth/websocket-ticket/rpc",
    );
    expect(environmentProofUrl(`${CAPTAIN_BASE}/api/assets/a?x=1`, base)).toBe(
      "https://member.t3.test/api/assets/a?x=1",
    );
    // The RPC upgrade proof is built from the socket URL with an HTTP scheme.
    expect(environmentProofUrl(`${CAPTAIN_BASE}/ws`, base)).toBe("https://member.t3.test/ws");
  });

  it("leaves a request alone without a proof base or outside the route", () => {
    const url = "http://192.168.1.10:3773/api/auth/session";
    expect(environmentProofUrl(url, { httpBaseUrl: "http://192.168.1.10:3773/" })).toBe(url);
    expect(environmentProofUrl("http://192.168.1.5:3773/api/mesh/via", base)).toBe(
      "http://192.168.1.5:3773/api/mesh/via",
    );
  });
});
