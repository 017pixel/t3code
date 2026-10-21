import { describe, expect, it } from "@effect/vitest";
import { type AssetCreateUrlResult, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  resolveViewedImageAsset,
  workEntryViewedImagePath,
  type WorkLogPresentationEntry,
} from "../work-log/presentation.ts";
import { createAssetEnvironmentAtoms, createProjectFaviconUrlAtomFamily } from "./assets.ts";

describe("project favicon URL cache", () => {
  it("does not reuse another environment, workspace, or selected icon's cached URL", () => {
    const registry = AtomRegistry.make();
    const result = Atom.make<AsyncResult.AsyncResult<AssetCreateUrlResult, unknown>>(
      AsyncResult.success({
        expiresAt: 4_000_000_000_000,
        relativeUrl: "/api/assets/token/icon.svg",
      }),
    );
    const favicon = createProjectFaviconUrlAtomFamily({
      createUrl: () => result,
      preparedConnection: () => Atom.make(Option.some({ httpBaseUrl: "https://remote.test" })),
    });
    const target = { environmentId: EnvironmentId.make("remote"), cwd: "/workspace" };
    const unmount = registry.mount(favicon(target));
    try {
      expect(registry.get(favicon(target))).toBe("https://remote.test/api/assets/token/icon.svg");
      registry.set(result, AsyncResult.failure(Cause.die("disconnected")));
      expect(
        registry.get(favicon({ ...target, environmentId: EnvironmentId.make("other") })),
      ).toBeNull();
      expect(registry.get(favicon({ ...target, cwd: "/other" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: "brand.svg" }))).toBeNull();
      expect(registry.get(favicon({ ...target, faviconPath: null }))).toBe(
        "https://remote.test/api/assets/token/icon.svg",
      );
    } finally {
      unmount();
      registry.dispose();
    }
  });
});

describe("image Read preview URL cache", () => {
  it("does not reuse an earlier Read's cached URL when the same path is read again", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry,
      never
    >;
    const { createUrl } = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("local");
    const threadId = ThreadId.make("thread");
    const read = (id: string): WorkLogPresentationEntry => ({
      id,
      createdAt: "2026-10-21T00:00:00.000Z",
      label: "Read",
      tone: "tool",
      viewedImagePath: "repro.png",
    });
    const previewUrl = (entry: WorkLogPresentationEntry) => {
      const asset = resolveViewedImageAsset(workEntryViewedImagePath(entry)!, {
        threadId,
        workspaceRoot: "/repo",
        entryId: entry.id,
      });
      return createUrl({ environmentId, input: { resource: asset!.resource } });
    };

    expect(previewUrl(read("read-red"))).toBe(previewUrl(read("read-red")));
    expect(previewUrl(read("read-blue"))).not.toBe(previewUrl(read("read-red")));
  });
});
