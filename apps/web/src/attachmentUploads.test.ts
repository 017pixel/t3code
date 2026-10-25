import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AttachmentUploadPolicy,
  planAttachmentUploads,
  planDraftUploadsForPolicies,
} from "./attachmentUploads";
import {
  DraftId,
  QUEUED_EDIT_DRAFT_PREFIX,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
} from "./composerDraftStore";
import { questionAttachmentDraftId } from "./questionAttachments";

vi.mock("./lib/attachmentUploadQueue", () => ({
  releaseAttachmentUpload: vi.fn(),
  releaseDraftAttachments: vi.fn(),
  startAttachmentUpload: vi.fn(),
}));
vi.mock("./state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentServerConfigsAtom: Atom.make(new Map()) };
});
vi.mock("./state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentSession: { sessionStateAtom: () => Atom.make(null) } };
});

const environmentId = EnvironmentId.make("environment-1");
const otherEnvironmentId = EnvironmentId.make("environment-2");
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread-1"));
const threadKey = scopedThreadKey(threadRef);
const policy: AttachmentUploadPolicy = { supported: true, maxFileBytes: 10, canOperate: true };

function image(id: string): ComposerImageAttachment {
  return {
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 4,
    previewUrl: `blob:${id}`,
    file: new File(["png"], `${id}.png`, { type: "image/png" }),
  };
}

function file(
  id: string,
  sizeBytes = 4,
  extra: Partial<ComposerFileAttachment> = {},
): ComposerFileAttachment {
  return {
    type: "file",
    id,
    name: `${id}.pdf`,
    mimeType: "application/pdf",
    sizeBytes,
    file: new File(["pdf"], `${id}.pdf`, { type: "application/pdf" }),
    ...extra,
  } as ComposerFileAttachment;
}

function draft(
  attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>,
): ComposerThreadDraftState {
  return {
    images: attachments.filter((attachment) => attachment.type === "image"),
    files: attachments.filter((attachment) => attachment.type === "file"),
  } as ComposerThreadDraftState;
}

const ids = (attachments: ReadonlyArray<{ readonly id: string }>) =>
  attachments.map((attachment) => attachment.id);

describe("planAttachmentUploads", () => {
  it("starts images and files that fit, releases oversized files", () => {
    const plan = planAttachmentUploads(policy, [image("a"), file("small"), file("big", 11)]);
    expect(ids(plan.start)).toEqual(["a", "small"]);
    expect(ids(plan.release)).toEqual(["big"]);
  });

  it("releases only unpersisted uploads when the capability is gone", () => {
    const persisted = file("persisted", 4, {
      uploadEnvironmentId: environmentId,
      uploadedAttachmentId: "server-copy",
    });
    const plan = planAttachmentUploads({ ...policy, supported: false }, [image("a"), persisted]);
    expect(ids(plan.release)).toEqual(["a"]);
    expect(plan.start).toEqual([]);
  });

  it("starts nothing without operate access, and no files without a size limit", () => {
    expect(
      planAttachmentUploads({ ...policy, canOperate: false }, [image("a"), file("f")]),
    ).toEqual({ release: [], start: [] });
    const unlimited = planAttachmentUploads({ ...policy, maxFileBytes: null }, [
      image("a"),
      file("f"),
    ]);
    expect(ids(unlimited.start)).toEqual(["a"]);
    expect(ids(unlimited.release)).toEqual(["f"]);
  });
});

describe("planDraftUploadsForPolicies", () => {
  const policies = new Map([
    [environmentId, policy],
    [otherEnvironmentId, policy],
  ]);

  it("re-plans every attachment of drafts in a changed environment only", () => {
    const otherKey = scopedThreadKey(scopeThreadRef(otherEnvironmentId, ThreadId.make("t2")));
    const state = {
      draftsByThreadKey: {
        [threadKey]: draft([image("a"), file("f")]),
        [otherKey]: draft([image("b")]),
      },
      draftThreadsByThreadKey: {},
    };
    const work = planDraftUploadsForPolicies(new Map(), state, policies, new Set([environmentId]));
    expect(work.map((entry) => [entry.draftTarget, ids(entry.start)])).toEqual([
      [threadRef, ["a", "f"]],
    ]);
  });

  it("uses the environment the add named for a queued-edit draft", () => {
    const key = `${QUEUED_EDIT_DRAFT_PREFIX}${threadKey}:run-1`;
    const draftTarget = DraftId.make(key);
    const state = {
      draftsByThreadKey: { [key]: draft([image("a")]) },
      draftThreadsByThreadKey: {},
    };
    expect(planDraftUploadsForPolicies(new Map(), state, policies, null)).toEqual([]);
    const targets = new Map([[key, { environmentId, draftTarget }]]);
    const work = planDraftUploadsForPolicies(targets, state, policies, new Set([environmentId]));
    expect(work.map((entry) => [entry.environmentId, entry.draftTarget, ids(entry.start)])).toEqual(
      [[environmentId, draftTarget, ["a"]]],
    );
  });

  it("restores a draft session's environment and releases on capability loss", () => {
    const key = "draft-1";
    const state = {
      draftsByThreadKey: { [key]: draft([image("a")]) },
      draftThreadsByThreadKey: { [key]: { environmentId: otherEnvironmentId } },
    };
    const lost = planDraftUploadsForPolicies(
      new Map(),
      state,
      new Map([[otherEnvironmentId, { ...policy, supported: false }]]),
      null,
    );
    expect(lost.map((work) => [work.environmentId, ids(work.release)])).toEqual([
      [otherEnvironmentId, ["a"]],
    ]);
  });

  it("plans a draft session in its current environment, not the one its adds named", () => {
    const key = "draft-moved";
    const draftTarget = DraftId.make(key);
    const state = {
      draftsByThreadKey: { [key]: draft([image("a")]) },
      draftThreadsByThreadKey: { [key]: { environmentId: otherEnvironmentId } },
    };
    const targets = new Map([[key, { environmentId, draftTarget }]]);
    expect(planDraftUploadsForPolicies(targets, state, policies, new Set([environmentId]))).toEqual(
      [],
    );
    const work = planDraftUploadsForPolicies(targets, state, policies, null);
    expect(work.map((entry) => [entry.environmentId, entry.draftTarget])).toEqual([
      [otherEnvironmentId, draftTarget],
    ]);
  });

  it("uploads question drafts to the environment encoded in their key", () => {
    const key = questionAttachmentDraftId(environmentId, threadRef.threadId, "request", "q1");
    const work = planDraftUploadsForPolicies(
      new Map(),
      { draftsByThreadKey: { [key]: draft([image("a")]) }, draftThreadsByThreadKey: {} },
      policies,
      null,
    );
    expect(work.map((entry) => [entry.environmentId, entry.draftTarget])).toEqual([
      [environmentId, key],
    ]);
  });

  it("forgets targets of drafts that no longer exist", () => {
    const targets = new Map([["gone", { environmentId, draftTarget: DraftId.make("gone") }]]);
    planDraftUploadsForPolicies(
      targets,
      { draftsByThreadKey: {}, draftThreadsByThreadKey: {} },
      policies,
      null,
    );
    expect(targets.size).toBe(0);
  });
});
