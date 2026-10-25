import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { IncomingShareDraft } from "../sharing/incoming-share-model";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import {
  makeIncomingShareImports,
  type ShareImportDeps,
  type ShareImportPhase,
  type ShareImportTarget,
  transitionShareImport,
} from "./incomingShareImport";

const destination = { environmentId: "env-1", projectId: "project-1" };

function fileAttachment(id: string): DraftComposerAttachment {
  return {
    id,
    type: "file",
    name: `${id}.txt`,
    mimeType: "text/plain",
    sizeBytes: 4,
    fileUri: `file:///${id}.txt`,
  };
}

function share(attachments: ReadonlyArray<DraftComposerAttachment> = []): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id: "share-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    text: "shared text",
    attachments,
    warnings: [],
  };
}

function importTarget(overrides: Partial<ShareImportTarget> = {}): ShareImportTarget {
  return {
    flowKey: "flow-a",
    routeKey: "route-a",
    draftKey: "draft-a",
    destination,
    shareId: "share-1",
    ...overrides,
  };
}

function setup(overrides: Partial<ShareImportDeps> = {}) {
  const drafts = new Map<string, ComposerDraft>([["draft-a", { text: "mine", attachments: [] }]]);
  const inbox = new Map<string, IncomingShareDraft>([["share-1", share()]]);
  const calls: Array<string> = [];
  const registry = overrides.registry ?? AtomRegistry.make();
  const deps: ShareImportDeps = {
    registry,
    getShare: (shareId) => inbox.get(shareId) ?? null,
    reserve: vi.fn(async () => {
      calls.push("reserve");
    }),
    release: vi.fn(async () => {
      calls.push("release");
    }),
    consume: vi.fn(async () => {
      calls.push("consume");
    }),
    readDraft: (draftKey) => drafts.get(draftKey) ?? { text: "", attachments: [] },
    restoreDraft: vi.fn(async (draftKey, snapshot) => {
      calls.push("restore");
      drafts.set(draftKey, snapshot);
    }),
    mergeIntoDraft: vi.fn(async (draftKey, content) => {
      calls.push("merge");
      const existing = drafts.get(draftKey) ?? { text: "", attachments: [] };
      drafts.set(draftKey, {
        text: `${existing.text}\n${content.text}`,
        attachments: [...existing.attachments, ...content.attachments],
      });
      return { skippedAttachmentCount: 0 };
    }),
    selectAttachments: (incoming) => ({
      status: "ready",
      attachments: incoming.attachments,
      warnings: [],
    }),
    releaseUnusedAttachments: vi.fn(),
    onWarnings: vi.fn(),
    onImportFailure: vi.fn(),
    onCancelFailure: vi.fn(),
    leave: vi.fn(),
    ...overrides,
  };
  const imports = makeIncomingShareImports(deps);
  const watch = (target: ShareImportTarget) => {
    const atom = imports.phaseAtom(target);
    const unmount = registry.mount(atom);
    registry.get(atom);
    return { phase: (): ShareImportPhase => registry.get(atom), unmount };
  };
  return { imports, deps, drafts, inbox, calls, watch, registry };
}

describe("transitionShareImport", () => {
  it("only cancels or retries from a failure, and keeps terminal phases terminal", () => {
    expect(transitionShareImport("attaching", "cancel")).toBe("attaching");
    expect(transitionShareImport("failed", "start")).toBe("reserving");
    expect(transitionShareImport("cancelling", "cancelFailed")).toBe("failed");
    expect(transitionShareImport("done", "start")).toBe("done");
    expect(transitionShareImport("cancelled", "start")).toBe("cancelled");
  });
});

describe("incoming share imports", () => {
  it("reserves, attaches and consumes once, releasing files the draft did not keep", async () => {
    const kept = fileAttachment("kept");
    const skipped = fileAttachment("skipped");
    const { deps, calls, drafts, inbox, watch } = setup({
      selectAttachments: () => ({ status: "ready", attachments: [kept], warnings: ["too big"] }),
    });
    inbox.set("share-1", share([kept, skipped]));
    const watched = watch(importTarget());

    expect(watched.phase()).toBe("reserving");
    await vi.waitFor(() => expect(watched.phase()).toBe("done"));

    expect(calls).toEqual(["reserve", "merge", "consume"]);
    expect(drafts.get("draft-a")?.attachments).toEqual([kept]);
    expect(deps.releaseUnusedAttachments).toHaveBeenCalledWith([skipped]);
    expect(deps.onWarnings).toHaveBeenCalledWith(["too big"]);
  });

  it("runs once when its atom node is removed and rebuilt", async () => {
    const { imports, deps } = setup();
    const tasks: Array<() => void> = [];
    const registry = AtomRegistry.make({
      scheduleTask: (task) => {
        tasks.push(task);
        return () => undefined;
      },
    });
    const atom = imports.phaseAtom(importTarget());

    registry.get(atom);
    tasks.splice(0).forEach((task) => task());
    expect(registry.getNodes().size).toBe(0);
    const unmount = registry.mount(atom);
    await vi.waitFor(() => expect(registry.get(atom)).toBe("done"));
    unmount();

    expect(deps.reserve).toHaveBeenCalledTimes(1);
    expect(deps.consume).toHaveBeenCalledTimes(1);
  });

  it("marks the share imported for its route until the route leaves", async () => {
    const { imports, watch, registry } = setup();
    const watched = watch(importTarget());
    const imported = imports.importedAtom("flow-a", "share-1");
    expect(registry.get(imported)).toBe(false);
    await vi.waitFor(() => expect(watched.phase()).toBe("done"));
    expect(registry.get(imported)).toBe(true);
    expect(registry.get(imports.importedAtom("flow-b", "share-1"))).toBe(false);

    imports.prune(new Set());
    expect(registry.get(imported)).toBe(false);
  });

  it("cancel after a failed consume restores the draft, releases the reservation and leaves", async () => {
    const { deps, calls, drafts, watch, imports } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));
    expect(deps.onImportFailure).toHaveBeenCalledWith(target, new Error("disk full"));

    await imports.cancel(target);

    expect(watched.phase()).toBe("cancelled");
    expect(calls).toEqual(["reserve", "merge", "restore", "release"]);
    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
    // Unconsumed: the inbox still owns the files.
    expect(deps.releaseUnusedAttachments).not.toHaveBeenCalled();
    expect(deps.leave).toHaveBeenCalledWith(target);
  });

  it("cancel before anything was reserved only leaves", async () => {
    const { calls, deps, watch, imports } = setup({
      reserve: vi.fn(async () => {
        throw new Error("reserved elsewhere");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));

    await imports.cancel(target);

    expect(calls).toEqual([]);
    expect(deps.leave).toHaveBeenCalledTimes(1);
  });

  it("a failed cancel can be retried and keeps the original backup", async () => {
    let releaseAttempts = 0;
    const { deps, drafts, watch, imports } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
      release: vi.fn(async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) throw new Error("locked");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));

    await imports.cancel(target);
    expect(watched.phase()).toBe("failed");
    expect(deps.onCancelFailure).toHaveBeenCalledWith(target, new Error("locked"));
    expect(deps.leave).not.toHaveBeenCalled();

    await imports.cancel(target);
    expect(watched.phase()).toBe("cancelled");
    expect(deps.restoreDraft).toHaveBeenCalledTimes(1);
    expect(drafts.get("draft-a")).toEqual({ text: "mine", attachments: [] });
    expect(deps.leave).toHaveBeenCalledTimes(1);
  });

  it("retry imports the share as the inbox holds it then", async () => {
    let fail = true;
    const { deps, imports, inbox, watch } = setup({
      mergeIntoDraft: vi.fn(async () => {
        if (fail) throw new Error("busy");
        return { skippedAttachmentCount: 0 };
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));

    fail = false;
    inbox.set("share-1", { ...share(), text: "edited" });
    imports.retry(target);

    await vi.waitFor(() => expect(watched.phase()).toBe("done"));
    expect(deps.reserve).toHaveBeenCalledTimes(2);
    expect(deps.mergeIntoDraft).toHaveBeenLastCalledWith("draft-a", {
      text: "edited",
      attachments: [],
      sourceShareId: "share-1",
    });
  });

  it("stops before consuming once its route leaves the stack", async () => {
    const merged = Promise.withResolvers<{ readonly skippedAttachmentCount: number }>();
    const { deps, imports, watch } = setup({ mergeIntoDraft: () => merged.promise });
    const watched = watch(importTarget());
    await vi.waitFor(() => expect(watched.phase()).toBe("attaching"));

    const pruned = imports.prune(new Set(["flow-b"]));
    merged.resolve({ skippedAttachmentCount: 0 });
    await pruned;

    expect(deps.consume).not.toHaveBeenCalled();
    expect(deps.onImportFailure).not.toHaveBeenCalled();
    watched.unmount();
  });

  it("a failed import keeps its cancel after its route left, and reports a failed undo", async () => {
    const { calls, deps, imports, watch } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
      release: vi.fn(async () => {
        throw new Error("locked");
      }),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));
    watched.unmount();
    await imports.prune(new Set());

    await imports.cancel(target);

    expect(calls).toEqual(["reserve", "merge", "restore"]);
    expect(deps.onCancelFailure).toHaveBeenCalledWith(target, new Error("locked"));
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it("a cancel finishes its undo after the route left, without navigating", async () => {
    const restored = Promise.withResolvers<void>();
    const { deps, imports, watch } = setup({
      consume: vi.fn(async () => {
        throw new Error("disk full");
      }),
      restoreDraft: vi.fn(() => restored.promise),
    });
    const target = importTarget();
    const watched = watch(target);
    await vi.waitFor(() => expect(watched.phase()).toBe("failed"));

    const cancelling = imports.cancel(target);
    await imports.prune(new Set());
    restored.resolve();
    await cancelling;

    expect(deps.release).toHaveBeenCalledTimes(1);
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it("a route switching drafts abandons the in-flight import", async () => {
    const reserved = Promise.withResolvers<void>();
    const { deps, watch } = setup({
      reserve: vi.fn().mockReturnValueOnce(reserved.promise).mockResolvedValue(undefined),
    });
    watch(importTarget()).unmount();
    const second = watch(importTarget({ draftKey: "draft-b" }));
    reserved.resolve();

    await vi.waitFor(() => expect(second.phase()).toBe("done"));
    expect(deps.mergeIntoDraft).toHaveBeenCalledTimes(1);
    expect(deps.mergeIntoDraft).toHaveBeenCalledWith("draft-b", expect.anything());
  });

  it("a route switching back to a superseded draft starts it over", async () => {
    const reserved = Promise.withResolvers<void>();
    // Keep unsubscribed nodes cached, as they are between a screen's renders.
    const registry = AtomRegistry.make({ scheduleTask: () => () => undefined });
    const { deps, watch } = setup({
      registry,
      reserve: vi.fn().mockReturnValueOnce(reserved.promise).mockResolvedValue(undefined),
    });
    watch(importTarget()).unmount();
    watch(importTarget({ draftKey: "draft-b" })).unmount();
    const back = watch(importTarget());
    reserved.resolve();

    await vi.waitFor(() => expect(back.phase()).toBe("done"));
    expect(deps.mergeIntoDraft).toHaveBeenLastCalledWith("draft-a", expect.anything());
  });
});
