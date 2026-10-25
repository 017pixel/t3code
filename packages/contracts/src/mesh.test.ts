import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, isUnknownUnionMember, ThreadId } from "./baseSchemas.ts";
import {
  formatMeshCaller,
  formatMeshModeLimit,
  isMeshForwardedPath,
  meshViaBasePath,
  parseMeshCaller,
  parseMeshModeLimit,
  parseMeshViaPath,
  ReceivedMeshRelayMessage,
} from "./mesh.ts";

describe("mesh mode limit", () => {
  it("round-trips runtime and interaction modes", () => {
    const limit = { runtimeMode: "auto-accept-edits", interactionMode: "plan" } as const;
    expect(formatMeshModeLimit(limit)).toBe("auto-accept-edits/plan");
    expect(parseMeshModeLimit(formatMeshModeLimit(limit))).toEqual(limit);
    expect(parseMeshModeLimit(" full-access/default ")).toEqual({
      runtimeMode: "full-access",
      interactionMode: "default",
    });
  });

  it("refuses missing or malformed values", () => {
    for (const value of [
      undefined,
      null,
      "",
      "full-access",
      "full-access/",
      "/default",
      "full-access/default/plan",
      "root/default",
      "full-access/yolo",
      "default/full-access",
    ]) {
      expect(parseMeshModeLimit(value)).toBeNull();
    }
  });
});

describe("mesh caller", () => {
  it("round-trips a thread caller and a client grant", () => {
    const thread = { kind: "thread", threadId: ThreadId.make("thread:a/b c") } as const;
    expect(parseMeshCaller(formatMeshCaller(thread))).toEqual(thread);
    const delegated = { ...thread, delegated: true } as const;
    expect(parseMeshCaller(formatMeshCaller(delegated))).toEqual(delegated);
    expect(parseMeshCaller("client:read-only")).toEqual({ kind: "client", access: "read-only" });
  });

  it("refuses missing or malformed values", () => {
    for (const value of [
      undefined,
      null,
      "",
      "thread:",
      "delegated-thread:",
      "client:root",
      "agent:x",
      "thread",
    ]) {
      expect(parseMeshCaller(value)).toBeNull();
    }
  });
});

describe("isMeshForwardedPath", () => {
  it("forwards API, socket, OAuth and T3 well-known paths with their query", () => {
    for (const path of [
      "/api/assets/abc?token=1",
      "/ws",
      "/ws?ticket=abc",
      "/oauth/token",
      "/.well-known/t3/environment",
    ]) {
      expect(isMeshForwardedPath(path)).toBe(true);
    }
  });

  it("refuses the web app, mesh routes, and paths that could escape the member", () => {
    for (const path of [
      "/",
      "/index.html",
      "/api",
      "/wsx",
      "/.well-known/openid-configuration",
      "/api/mesh/via/handle/env/api/x",
      "/api/mesh/session",
      "//evil.example/api/x",
      "/\\evil.example/api/x",
      "https://evil.example/api/x",
      "api/x",
      "/api/../index.html",
      "/api/%2e%2e/index.html",
      "/api/./x",
    ]) {
      expect(isMeshForwardedPath(path)).toBe(false);
    }
  });
});

describe("captain via paths", () => {
  it("splits what meshViaBasePath builds", () => {
    const environmentId = EnvironmentId.make("env/1");
    const base = meshViaBasePath("h+1", environmentId);
    expect(base).toBe("/api/mesh/via/h%2B1/env%2F1");
    expect(parseMeshViaPath(`${base}/api/assets/a?x=1`)).toEqual({
      handle: "h+1",
      environmentId,
      forwardedPath: "/api/assets/a?x=1",
    });
    expect(parseMeshViaPath(`${base}?x=1`)?.forwardedPath).toBe("/?x=1");
  });

  it("refuses paths without a handle and environment", () => {
    expect(parseMeshViaPath("/api/mesh/via")).toBeNull();
    expect(parseMeshViaPath("/api/mesh/via/handle")).toBeNull();
    expect(parseMeshViaPath("/api/mesh/via/%E0%A4%A/env/ws")).toBeNull();
  });
});

describe("relay messages", () => {
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(ReceivedMeshRelayMessage));

  it("decodes a message type this build does not know as an unknown member", () => {
    expect(isUnknownUnionMember(decode('{"type":"delta","members":[]}'))).toBe(true);
  });

  it("decodes an unknown credential error code as internal", () => {
    expect(
      decode('{"type":"credentialError","requestId":"r1","code":"quota","message":"no"}'),
    ).toMatchObject({ type: "credentialError", code: "internal" });
  });
});
