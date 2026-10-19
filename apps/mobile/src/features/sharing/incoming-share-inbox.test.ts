import { describe, expect, it, vi } from "@effect/vitest";
import type { SharePayload } from "expo-sharing";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./incoming-share-presentation";
import { decodeIncomingShareDraft, type IncomingShareDraft } from "./incoming-share-model";
import { IncomingShareInbox, type IncomingShareInboxDependencies } from "./incoming-share-inbox";

const PAYLOAD: SharePayload = {
  shareType: "text",
  mimeType: "text/plain",
  value: "Fix this",
};

function draft(id: string, createdAt = "2026-07-16T08:00:00.000Z"): IncomingShareDraft {
  return {
    schemaVersion: 1,
    id,
    createdAt,
    text: PAYLOAD.value,
    attachments: [],
    warnings: [],
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness(overrides: Partial<IncomingShareInboxDependencies> = {}) {
  const persisted = new Map<string, IncomingShareDraft>();
  let payloads: ReadonlyArray<SharePayload> = [PAYLOAD];
  let nextId = 0;
  const dependencies: IncomingShareInboxDependencies = {
    loadDrafts: async () => [...persisted.values()].map(decodeIncomingShareDraft),
    writeDraft: async (value) => {
      persisted.set(value.id, value);
    },
    removeDraft: async (shareId) => {
      persisted.delete(shareId);
    },
    getPayloads: () => payloads,
    clearPayloads: () => {
      payloads = [];
    },
    buildDraft: async ({ id, createdAt }) => ({
      draft: draft(id, createdAt),
      cleanup: async () => undefined,
    }),
    fingerprintForPayloads: async () => "share-stable",
    createId: () => `share-entry-${++nextId}`,
    now: () => "2026-07-16T08:00:00.000Z",
    ...overrides,
  };
  return { inbox: new IncomingShareInbox(dependencies), persisted };
}

describe("IncomingShareInbox", () => {
  it("coalesces a replay of an already-persisted native handoff", async () => {
    const buildDraft = vi.fn(async ({ id, createdAt }) => ({
      draft: draft(id, createdAt),
      cleanup: async () => undefined,
    }));
    const cleanupReplayedPayloads = vi.fn(async () => undefined);
    const { inbox, persisted } = createHarness({ buildDraft, cleanupReplayedPayloads });
    persisted.set("share-stable", draft("share-stable"));

    await expect(inbox.refresh({ ingestNative: true })).resolves.toEqual([draft("share-stable")]);
    expect(buildDraft).not.toHaveBeenCalled();
    expect(cleanupReplayedPayloads).toHaveBeenCalledWith([PAYLOAD]);
  });

  it("serializes concurrent refreshes so one native payload creates one inbox item", async () => {
    const building = deferred();
    const buildDraft = vi.fn(async ({ id, createdAt }) => {
      await building.promise;
      return { draft: draft(id, createdAt), cleanup: async () => undefined };
    });
    const { inbox } = createHarness({
      buildDraft,
      clearPayloads: () => {
        throw new Error("native acknowledgement failed");
      },
    });

    const first = inbox.refresh({ ingestNative: true });
    const second = inbox.refresh({ ingestNative: true });
    building.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      [{ ...draft("share-entry-1"), payloadFingerprint: "share-stable" }],
      [{ ...draft("share-entry-1"), payloadFingerprint: "share-stable" }],
    ]);
    expect(buildDraft).toHaveBeenCalledTimes(1);
  });

  it("orders consumption after an in-flight refresh without restoring stale state", async () => {
    const building = deferred();
    const { inbox, persisted } = createHarness({
      buildDraft: async ({ id, createdAt }) => {
        await building.promise;
        return { draft: draft(id, createdAt), cleanup: async () => undefined };
      },
    });

    const refresh = inbox.refresh({ ingestNative: true });
    const consume = inbox.consume("share-entry-1");
    building.resolve();

    await expect(refresh).resolves.toEqual([
      { ...draft("share-entry-1"), payloadFingerprint: "share-stable" },
    ]);
    await expect(consume).resolves.toEqual([]);
    expect([...persisted.values()]).toEqual([]);
  });

  it("consumes only the addressed share when another share has identical content", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-first", draft("share-first", "2026-07-16T07:59:00.000Z"));
    persisted.set("share-second", draft("share-second"));

    await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([
      draft("share-second"),
      draft("share-first", "2026-07-16T07:59:00.000Z"),
    ]);
    await expect(inbox.consume("share-second")).resolves.toEqual([
      draft("share-first", "2026-07-16T07:59:00.000Z"),
    ]);
    expect([...persisted.values()]).toEqual([draft("share-first", "2026-07-16T07:59:00.000Z")]);
  });

  it("keeps content-identical shares addressable by their own ids", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-open-flow", draft("share-open-flow", "2026-07-16T07:59:00.000Z"));
    persisted.set("share-newer", draft("share-newer"));

    await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([
      draft("share-newer"),
      draft("share-open-flow", "2026-07-16T07:59:00.000Z"),
    ]);
  });

  it.each(["dismissed", "consumed"] as const)(
    "preserves an identical new handoff after the earlier share was %s",
    async (completion) => {
      let payloads: ReadonlyArray<SharePayload> = [PAYLOAD];
      let now = "2026-07-16T08:00:00.000Z";
      const { inbox } = createHarness({
        getPayloads: () => payloads,
        clearPayloads: () => {
          payloads = [];
        },
        now: () => now,
      });
      let pending = (await inbox.refresh({ ingestNative: true }))[0]!;
      const first = pending;
      let state = EMPTY_INCOMING_SHARE_PRESENTATION_STATE;
      const step = (sheetShareId: string | null) => {
        const result = transitionIncomingSharePresentation(state, {
          pendingShareId: pending.id,
          isSheetPresented: sheetShareId !== null,
          sheetShareId,
        });
        state = result.state;
        return result;
      };

      expect(step(null).shareIdToPresent).toBe(first.id);
      expect(step(first.id).shareIdToDiscard).toBeNull();
      if (completion === "dismissed") {
        const dismissed = step(null);
        expect(dismissed.shareIdToDiscard).toBe(first.id);
        expect(dismissed.shareIdToPresent).toBeNull();
        expect(step(null).shareIdToPresent).toBeNull();
        await inbox.consume(dismissed.shareIdToDiscard!);
        state = transitionIncomingSharePresentation(state, {
          pendingShareId: null,
          isSheetPresented: false,
          sheetShareId: null,
        }).state;
      } else {
        await inbox.consume(first.id);
      }
      await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([]);

      now = "2026-07-16T08:01:00.000Z";
      payloads = [PAYLOAD];
      pending = (await inbox.refresh({ ingestNative: true }))[0]!;
      expect(pending.text).toBe(first.text);
      expect(pending.createdAt).not.toBe(first.createdAt);
      if (completion === "consumed") {
        // React may batch consumption and re-ingestion without rendering an empty inbox.
        expect(step(first.id).shareIdToPresent).toBeNull();
      }
      const closed = step(null);
      if (closed.shareIdToDiscard) {
        await inbox.consume(closed.shareIdToDiscard);
      }
      await expect(inbox.refresh({ ingestNative: false })).resolves.toEqual([pending]);
      expect(closed.shareIdToPresent).toBe(pending.id);
    },
  );

  it("does not acknowledge a supported payload when its durable write fails", async () => {
    const clearPayloads = vi.fn();
    const cleanup = vi.fn(async () => undefined);
    const rollback = vi.fn(async () => undefined);
    const { inbox } = createHarness({
      clearPayloads,
      buildDraft: async ({ id, createdAt }) => ({
        draft: draft(id, createdAt),
        cleanup,
        rollback,
      }),
      writeDraft: async () => {
        throw new Error("disk full");
      },
    });

    await expect(inbox.refresh({ ingestNative: true })).rejects.toThrow("disk full");
    expect(clearPayloads).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("durably reserves a share for one project before draft import", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-stable", draft("share-stable"));
    const destination = { environmentId: "environment-1", projectId: "project-1" };

    await expect(inbox.reserve("share-stable", destination)).resolves.toEqual([
      { ...draft("share-stable"), destination },
    ]);
    expect(persisted.get("share-stable")?.destination).toEqual(destination);
    await expect(inbox.reserve("share-stable", destination)).resolves.toEqual([
      { ...draft("share-stable"), destination },
    ]);
  });

  it("rejects moving a reserved share to another project", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-stable", {
      ...draft("share-stable"),
      destination: { environmentId: "environment-1", projectId: "project-1" },
    });

    await expect(
      inbox.reserve("share-stable", {
        environmentId: "environment-1",
        projectId: "project-2",
      }),
    ).rejects.toThrow("already reserved");
    expect(persisted.get("share-stable")?.destination?.projectId).toBe("project-1");
  });

  it("conditionally releases a reservation when its project is unavailable", async () => {
    const { inbox, persisted } = createHarness();
    const destination = { environmentId: "environment-1", projectId: "project-1" };
    persisted.set("share-stable", { ...draft("share-stable"), destination });

    await expect(inbox.releaseReservation("share-stable", destination)).resolves.toEqual([
      draft("share-stable"),
    ]);
    expect(persisted.get("share-stable")?.destination).toBeUndefined();

    await expect(
      inbox.reserve("share-stable", {
        environmentId: "environment-2",
        projectId: "project-2",
      }),
    ).resolves.toEqual([
      {
        ...draft("share-stable"),
        destination: { environmentId: "environment-2", projectId: "project-2" },
      },
    ]);
  });

  it("does not release a reservation that changed concurrently", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-stable", {
      ...draft("share-stable"),
      destination: { environmentId: "environment-2", projectId: "project-2" },
    });

    await expect(
      inbox.releaseReservation("share-stable", {
        environmentId: "environment-1",
        projectId: "project-1",
      }),
    ).rejects.toThrow("reservation changed");
    expect(persisted.get("share-stable")?.destination?.projectId).toBe("project-2");
  });

  it("treats an already-removed share as an already-released reservation", async () => {
    const { inbox, persisted } = createHarness();
    persisted.set("share-other", draft("share-other"));

    await expect(
      inbox.releaseReservation("share-stable", {
        environmentId: "environment-1",
        projectId: "project-1",
      }),
    ).resolves.toEqual([draft("share-other")]);
    expect([...persisted.values()]).toEqual([draft("share-other")]);
  });
});
