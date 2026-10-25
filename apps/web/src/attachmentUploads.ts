import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  sessionGrantsScope,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { attachmentsToReleaseOnUploadCapabilityLoss } from "./components/chat/composerAttachmentFiles";
import {
  composerFileNeedsReattach,
  composerTargetKey,
  DraftId,
  QUEUED_EDIT_DRAFT_PREFIX,
  setComposerAttachmentUploader,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadDraftState,
  type ComposerThreadTarget,
  useComposerDraftStore,
} from "./composerDraftStore";
import { releaseAttachmentUpload, startAttachmentUpload } from "./lib/attachmentUploadQueue";
import { questionAttachmentDraftEnvironmentId } from "./questionAttachments";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentServerConfigsAtom } from "./state/server";
import { environmentSession } from "./state/session";

type DraftAttachment = ComposerImageAttachment | ComposerFileAttachment;

/** An environment without a known server config has no policy: uploads wait for it. */
export interface AttachmentUploadPolicy {
  readonly supported: boolean;
  readonly maxFileBytes: number | null;
  readonly canOperate: boolean;
}

export function planAttachmentUploads(
  policy: AttachmentUploadPolicy,
  attachments: ReadonlyArray<DraftAttachment>,
): { readonly release: DraftAttachment[]; readonly start: DraftAttachment[] } {
  // The capability can flap on reconnect or version skew. Deleting a persisted hydrated upload
  // here would make the next send fail verification while the file still sits in the draft.
  if (!policy.supported) {
    return { release: attachmentsToReleaseOnUploadCapabilityLoss(attachments), start: [] };
  }
  if (!policy.canOperate) return { release: [], start: [] };
  const { maxFileBytes } = policy;
  const fits = (attachment: DraftAttachment) =>
    attachment.type !== "file" || (maxFileBytes !== null && attachment.sizeBytes <= maxFileBytes);
  return {
    release: attachmentsToReleaseOnUploadCapabilityLoss(
      attachments.filter((attachment) => !fits(attachment)),
    ),
    start: attachments.filter(
      (attachment) =>
        fits(attachment) && !(attachment.type === "file" && composerFileNeedsReattach(attachment)),
    ),
  };
}

interface DraftUploadTarget {
  readonly environmentId: EnvironmentId;
  readonly draftTarget: ComposerThreadTarget;
}

export interface DraftUploadWork extends DraftUploadTarget {
  readonly release: DraftAttachment[];
  readonly start: DraftAttachment[];
}

interface DraftUploadState {
  readonly draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>;
  readonly draftThreadsByThreadKey: Readonly<Record<string, { environmentId: EnvironmentId }>>;
}

function samePolicy(left: AttachmentUploadPolicy, right: AttachmentUploadPolicy): boolean {
  return (
    left.supported === right.supported &&
    left.maxFileBytes === right.maxFileBytes &&
    left.canOperate === right.canOperate
  );
}

/** The environment a draft target names without the caller's help. */
function namedDraftUploadTarget(
  state: DraftUploadState,
  target: ComposerThreadTarget,
): DraftUploadTarget | null {
  if (typeof target !== "string")
    return { environmentId: target.environmentId, draftTarget: target };
  const environmentId =
    state.draftThreadsByThreadKey[target]?.environmentId ??
    questionAttachmentDraftEnvironmentId(target);
  return environmentId ? { environmentId, draftTarget: target } : null;
}

/**
 * Draft sessions and question drafts name their environment at plan time, so a draft moved to
 * another environment is planned there. Keys that name none (queued edits) use the environment
 * their adds named; a thread key names its thread's environment.
 */
function draftUploadTargetForKey(
  explicitTargets: ReadonlyMap<string, DraftUploadTarget>,
  state: DraftUploadState,
  threadKey: string,
): DraftUploadTarget | null {
  const named = namedDraftUploadTarget(state, DraftId.make(threadKey));
  if (named) return named;
  const explicit = explicitTargets.get(threadKey);
  if (explicit) return explicit;
  if (threadKey.startsWith(QUEUED_EDIT_DRAFT_PREFIX)) return null;
  const threadRef = parseScopedThreadKey(threadKey);
  return threadRef ? { environmentId: threadRef.environmentId, draftTarget: threadRef } : null;
}

/**
 * Re-plans every attachment of the drafts in environments whose policy changed (config arrival,
 * capability loss, operate scope), or of all drafts when `changed` is null. `targets` holds the
 * environment adds named for drafts that name none themselves; entries for drafts that no longer
 * exist are dropped.
 */
export function planDraftUploadsForPolicies(
  targets: Map<string, DraftUploadTarget>,
  state: DraftUploadState,
  policies: ReadonlyMap<EnvironmentId, AttachmentUploadPolicy>,
  changed: ReadonlySet<EnvironmentId> | null,
): DraftUploadWork[] {
  for (const threadKey of targets.keys()) {
    if (!state.draftsByThreadKey[threadKey]) targets.delete(threadKey);
  }
  const work: DraftUploadWork[] = [];
  for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
    if (draft.images.length === 0 && draft.files.length === 0) continue;
    const target = draftUploadTargetForKey(targets, state, threadKey);
    if (!target || (changed && !changed.has(target.environmentId))) continue;
    const policy = policies.get(target.environmentId);
    if (!policy) continue;
    work.push({ ...target, ...planAttachmentUploads(policy, [...draft.images, ...draft.files]) });
  }
  return work;
}

const uploadPoliciesAtom = Atom.make((get) => {
  const policies = new Map<EnvironmentId, AttachmentUploadPolicy>();
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    const grant = Option.getOrNull(AsyncResult.value(session));
    const maxUploadBytes = config.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
    policies.set(environmentId, {
      supported: config.environment.capabilities.attachmentUploads === true,
      maxFileBytes: maxUploadBytes === null ? null : clampFileAttachmentUploadBytes(maxUploadBytes),
      canOperate:
        session._tag !== "Failure" &&
        grant !== null &&
        sessionGrantsScope(grant, AuthOrchestrationOperateScope),
    });
  }
  return policies;
}).pipe(Atom.keepAlive, Atom.withLabel("web-attachment-upload-policies"));

function runWork(work: DraftUploadWork): void {
  for (const attachment of work.release) releaseAttachmentUpload(attachment.id);
  for (const attachment of work.start) {
    startAttachmentUpload({
      environmentId: work.environmentId,
      image: attachment,
      draftTarget: work.draftTarget,
    });
  }
}

const draftUploadTargets = new Map<string, DraftUploadTarget>();

/**
 * Called by the draft store's add, move and retarget actions. Without a known policy yet, the draft waits for its
 * environment's config through `startDraftAttachmentUploads`.
 */
function uploadDraftAttachments(input: {
  readonly environmentId: EnvironmentId | undefined;
  readonly draftTarget: ComposerThreadTarget;
  readonly attachments: ReadonlyArray<DraftAttachment>;
}): void {
  const named = namedDraftUploadTarget(useComposerDraftStore.getState(), input.draftTarget);
  const target =
    named ??
    (input.environmentId
      ? { environmentId: input.environmentId, draftTarget: input.draftTarget }
      : null);
  if (!target) return;
  if (!named) draftUploadTargets.set(composerTargetKey(input.draftTarget), target);
  const policy = appAtomRegistry.get(uploadPoliciesAtom).get(target.environmentId);
  if (policy) runWork({ ...target, ...planAttachmentUploads(policy, input.attachments) });
}

/**
 * Connects the draft store's add actions to the upload queue and re-plans drafts when an
 * environment's upload policy changes or stored drafts finish loading. Completion writes back to
 * the owning draft from the queue itself.
 */
export function startDraftAttachmentUploads(): () => void {
  setComposerAttachmentUploader(uploadDraftAttachments);
  let policies: ReadonlyMap<EnvironmentId, AttachmentUploadPolicy> = new Map();
  const replan = (changed: ReadonlySet<EnvironmentId> | null) => {
    const state = useComposerDraftStore.getState();
    for (const work of planDraftUploadsForPolicies(draftUploadTargets, state, policies, changed)) {
      runWork(work);
    }
  };
  const onPolicies = (next: ReadonlyMap<EnvironmentId, AttachmentUploadPolicy>) => {
    const changed = new Set<EnvironmentId>();
    for (const [environmentId, policy] of next) {
      const previous = policies.get(environmentId);
      if (!previous || !samePolicy(previous, policy)) changed.add(environmentId);
    }
    policies = next;
    if (changed.size > 0) replan(changed);
  };
  onPolicies(appAtomRegistry.get(uploadPoliciesAtom));
  const stopPolicies = appAtomRegistry.subscribe(uploadPoliciesAtom, onPolicies);
  const stopHydration = useComposerDraftStore.persist.onFinishHydration(() => replan(null));
  if (useComposerDraftStore.persist.hasHydrated()) replan(null);
  return () => {
    setComposerAttachmentUploader(null);
    stopPolicies();
    stopHydration();
  };
}
