import { ActiveNewTaskContext } from "../../state/active-new-task";
import * as Dialog from "../../components/ui/Dialog";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { useEnvironmentPresentation } from "../../state/presentation";
import { environmentSession } from "../../state/session";
import React, { useRef, useState } from "react";

import type {
  EnvironmentId,
  ModelSelection,
  ProjectReadFileResult,
  ProviderInteractionMode,
  ProviderOptionSelection,
  RuntimeMode,
  ServerConfig,
  ServerProvider,
} from "@t3tools/contracts";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  repositoryGroupingKeyOf,
  T3_PROJECT_FILE_NAME,
  ThreadId,
} from "@t3tools/contracts";
import { threadContextsOutsideEnvironment } from "@t3tools/shared/composerContextReferences";
import { resolveNewThreadEnvMode, resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { useAtomValue } from "@effect/atom-react";
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";

import {
  useEnvironmentServerConfig,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../../state/entities";
import type { TurnCommandMetadata } from "../../lib/commandMetadata";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  buildModelOptions,
  groupByProvider,
  resolveDefaultableModelSelection,
  resolveNewTaskModelSelection,
  resolveSelectableModelSelection,
} from "../../lib/modelOptions";
import { scopedProjectKey } from "../../lib/scopedEntities";
import { appAtomRegistry } from "../../state/atom-registry";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  appendComposerDraftAttachments,
  type ComposerDraftInsertion,
  type ComposerDraftWorkspaceSelection,
  composerDraftsLoadedAtom,
  createNewTaskDraft,
  ensureNewTaskDraft,
  getComposerDraftSnapshot,
  isNewTaskDraftKey,
  removeComposerDraftAttachment,
  replaceComposerDraftAttachments,
  retargetNewTaskDraft,
  setComposerDraftText,
  setStickyComposerModelSelection,
  updateComposerDraftSettings,
  useComposerDraft,
  useStickyComposerModelSelection,
} from "../../state/use-composer-drafts";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import { useBranches, usePaginatedBranches } from "../../state/queries";
import { vcsEnvironment } from "../../state/vcs";
import { type QueuedThreadMessage } from "../../state/thread-outbox";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
  useSavedRemoteConnections,
} from "../../state/use-remote-environment-registry";
import { availableScratchWorkspaceRoot } from "@t3tools/client-runtime/operations/projects";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type VcsRef } from "@t3tools/client-runtime/state/vcs";
import {
  buildHomeProjectScopes,
  sortHomeProjectScopes,
  type HomeProjectScope,
} from "../home/homeThreadList";
import { useMobileProjectGroupingSettings } from "../../state/project-grouping";
import {
  resolvePendingTaskInteractionMode,
  resolveProviderInteractionMode,
} from "../../state/legacy-plan-mode";
import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import { refreshChosenProjectBranches } from "./new-task-project-branches";
import {
  INACTIVE_FLOW_KEY,
  newTaskFlowStateAtom,
  type NewTaskFlowState,
  readNewTaskFlowState,
  type RouteDraftResolution,
  resolveRouteDraft,
  resolveRouteProject,
  routeNewTaskDraftKey,
  updateNewTaskFlowState,
} from "./new-task-flow-state";
import {
  fillNewTaskWorkspaceBranch,
  resolveNewTaskBranchWorktreePath,
  resolveNewTaskLocalWorkspaceSelection,
  resolveNewTaskWorkspaceSelection,
} from "./new-task-context-presentation";
import { resolveEnvironmentProjectMatch } from "./new-task-project-selection";
import { resolveProjectThreadCreationBranch } from "./projectThreadCreationValidation";

type WorkspaceMode = "local" | "worktree";

interface PendingTaskMessageInput {
  readonly project: EnvironmentProject;
  readonly draft: ReturnType<typeof getComposerDraftSnapshot>;
  readonly serverConfig: ServerConfig | null;
  readonly fallbackModelSelection: ModelSelection | null;
  readonly workspaceSelection: ComposerDraftWorkspaceSelection;
  readonly startFromOriginDefault: boolean;
  readonly defaultRuntimeMode: RuntimeMode;
  readonly planModeEnabled: boolean;
  readonly metadata: TurnCommandMetadata;
  readonly currentCheckoutBranch: string | null;
}

function assemblePendingTaskMessage(input: PendingTaskMessageInput): QueuedThreadMessage | null {
  const { project, draft, workspaceSelection, metadata } = input;
  const text = draft.text.trim();
  const modelSelection =
    resolveSelectableModelSelection(input.serverConfig, draft.modelSelection ?? null, project.id) ??
    input.fallbackModelSelection;
  if ((text.length === 0 && draft.attachments.length === 0) || !modelSelection) {
    return null;
  }
  if (
    threadContextsOutsideEnvironment({
      text: draft.text,
      records: draft.context?.records ?? [],
      environmentId: project.environmentId,
    }).length > 0
  ) {
    return null;
  }
  const mode = workspaceSelection.mode;
  return {
    environmentId: project.environmentId,
    threadId: ThreadId.make(metadata.threadId),
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text,
    attachments: draft.attachments,
    context: draft.context,
    modelSelection,
    runtimeMode: draft.runtimeMode ?? input.defaultRuntimeMode,
    interactionMode: resolvePendingTaskInteractionMode({
      planModeEnabled: input.planModeEnabled,
      draftInteractionMode: draft.interactionMode,
      provider: input.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection.instanceId,
      ),
    }),
    creation: {
      projectId: project.id,
      projectTitle: project.title,
      projectCwd: project.workspaceRoot,
      workspaceMode: mode,
      ...(mode === "worktree" && workspaceSelection.pullRequestReference
        ? { pullRequestReference: workspaceSelection.pullRequestReference }
        : {}),
      // Queued local tasks use drain-time checkout; snapshot branches only for immediate sends or explicit choices.
      branch: resolveProjectThreadCreationBranch({
        workspaceMode: mode,
        selectedBranch: workspaceSelection.branch,
        currentCheckoutBranch: input.currentCheckoutBranch,
      }),
      worktreePath: mode === "worktree" ? null : workspaceSelection.worktreePath,
      ...((workspaceSelection.startFromOrigin ?? input.startFromOriginDefault)
        ? { startFromOrigin: true }
        : {}),
    },
    createdAt: metadata.createdAt,
  };
}

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  return null;
}

type NewTaskFlowContextValue = {
  readonly activeNewTask: { readonly pendingKey: string | null } | null;
  readonly projectScopes: ReadonlyArray<HomeProjectScope>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly selectedModelKey: string | null;
  readonly workspaceMode: WorkspaceMode;
  readonly isGitRepo: boolean;
  readonly isGitRepoKnown: boolean;
  readonly canChooseWorkspace: boolean;
  readonly selectedBranchName: string | null;
  readonly selectedWorktreePath: string | null;
  readonly startFromOrigin: boolean;
  readonly pullRequestReference: string | undefined;
  readonly draftKey: string | null;
  readonly prompt: string;
  readonly attachments: ReadonlyArray<DraftComposerAttachment>;
  readonly submitting: boolean;
  readonly branchesLoading: boolean;
  readonly availableBranches: ReadonlyArray<VcsRef>;
  readonly currentCheckoutBranchName: string | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly planModeEnabled: boolean;
  readonly expandedProvider: string | null;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
  }>;
  readonly selectedProject: EnvironmentProject | null;
  readonly isScratchDraft: boolean;
  readonly modelOptions: ReadonlyArray<ModelOption>;
  readonly selectedModel: ModelSelection | null;
  readonly selectedModelOption: ModelOption | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  /** The current selection, for continuations that resume after an await. */
  readonly getSelectedProjectKey: () => string | null;
  readonly setProject: (project: EnvironmentProject) => void;
  /**
   * The route names a draft or project that is gone, or no project when there
   * is a choice to make; the screen hands the route to the project picker.
   */
  readonly routeTargetMissing: boolean;
  readonly selectEnvironment: (environmentId: EnvironmentId) => void;
  readonly switchEnvironment: (environmentId: EnvironmentId) => Promise<boolean>;
  readonly switchingToEnvironmentId: EnvironmentId | null;
  readonly setSelectedModelKey: (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => void;
  readonly setWorkspaceMode: (mode: WorkspaceMode) => void;
  readonly selectBranch: (branch: VcsRef) => void;
  readonly setStartFromOrigin: (value: boolean) => void;
  /** Resolves a draft's workspace selection the way the composer shows it. */
  readonly resolveWorkspaceSelection: (
    selection: ComposerDraftWorkspaceSelection | undefined,
  ) => ComposerDraftWorkspaceSelection;
  readonly buildPendingTaskMessage: (
    metadata: TurnCommandMetadata,
    options?: {
      readonly currentCheckoutBranch?: string | null;
    },
  ) => QueuedThreadMessage | null;
  readonly setPrompt: (value: string) => void;
  readonly replaceAttachments: (attachments: ReadonlyArray<DraftComposerAttachment>) => void;
  /** Appends draft attachments; returns how many the live cap rejected. */
  readonly appendAttachments: (
    attachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ) => number;
  readonly removeAttachment: (imageId: string) => void;
  readonly clearAttachments: () => void;
  readonly setSubmitting: (value: boolean) => void;
  readonly loadBranches: () => void;
  readonly setRuntimeMode: (value: RuntimeMode) => void;
  readonly setInteractionMode: (value: ProviderInteractionMode) => void;
  readonly setSelectedModelOptions: (
    value: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) => void;
  readonly setExpandedProvider: (value: string | null) => void;
};

const NewTaskFlowContext = React.createContext<NewTaskFlowContextValue | null>(null);

export function NewTaskFlowProvider(
  props: React.PropsWithChildren<{
    active?: boolean;
    /** Identifies the draft route this flow serves; a new key starts a fresh flow. */
    flowKey?: string;
    routeDraftId?: string;
    routeProject?: { readonly environmentId: string; readonly projectId: string };
  }>,
) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const groupingSettings = useMobileProjectGroupingSettings();
  const { enabled: legacyPlanModeEnabled } = useLegacyPlanModeState();

  const projectScopes = sortHomeProjectScopes({
    scopes: buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: groupingSettings.sidebarProjectGroupingMode,
    }),
    threads,
    pendingTasks: [],
    projectSortOrder: "updated_at",
  });

  const flowKey = props.flowKey ?? INACTIVE_FLOW_KEY;
  const storedFlowState = useAtomValue(newTaskFlowStateAtom(flowKey));
  const draftsLoaded = useAtomValue(composerDraftsLoadedAtom);
  // A draft route opened from a list row, a deep link, or restored state binds
  // its draft here until the user's own choices write the flow.
  const routeDraft = useComposerDraft(
    storedFlowState.draftKey === null ? (props.routeDraftId ?? null) : null,
  );
  // A route naming a project without a draft (a deep link) binds the route's
  // own draft, stamped on the flow's first write.
  const resolveRoute = (
    flow: NewTaskFlowState,
    loaded: boolean,
    stamp: Parameters<typeof resolveRouteDraft>[0]["stamp"],
  ): RouteDraftResolution => {
    if (props.routeDraftId !== undefined) {
      return resolveRouteDraft({
        flow,
        routeDraftId: props.routeDraftId,
        draftsLoaded: loaded,
        stamp,
        projects,
      });
    }
    if (props.flowKey === undefined) return { kind: "none" };
    return resolveRouteProject({
      flow,
      routeProject: props.routeProject,
      draftKey: routeNewTaskDraftKey(props.flowKey),
      projects,
    });
  };
  const routeDraftResolution = resolveRoute(storedFlowState, draftsLoaded, routeDraft.project);
  const flowState =
    routeDraftResolution.kind === "open" ? routeDraftResolution.flow : storedFlowState;
  const {
    environmentId: selectedEnvironmentIdOverride,
    projectKey: selectedProjectKey,
    draftKey: activeDraftKey,
    submitting,
    expandedProvider,
  } = flowState;
  // Every flow write stores the route's draft binding along with it, so the
  // binding outlives the draft's project stamp (submit clears it) and an
  // external delete once the user has acted.
  const updateFlow = (patch: Partial<NewTaskFlowState>) =>
    updateNewTaskFlowState(flowKey, { ...readFlow(), ...patch });
  // Continuations read the flow at use time, with the route's draft applied.
  const readFlow = (): NewTaskFlowState => {
    const stored = readNewTaskFlowState(flowKey);
    const resolution = resolveRoute(
      stored,
      appAtomRegistry.get(composerDraftsLoadedAtom),
      props.routeDraftId === undefined
        ? undefined
        : getComposerDraftSnapshot(props.routeDraftId).project,
    );
    return resolution.kind === "open" ? resolution.flow : stored;
  };
  // Draft writers bind the route's draft on their first write.
  const writableDraftKey = (): string | null => {
    const stored = readNewTaskFlowState(flowKey);
    if (readFlow() === stored) return selectedProjectDraftKey;
    updateFlow({});
    if (props.routeDraftId === undefined && selectedProjectDraftKey !== null && selectedProject) {
      ensureNewTaskDraft(selectedProjectDraftKey, {
        environmentId: selectedProject.environmentId,
        projectId: selectedProject.id,
      });
    }
    return selectedProjectDraftKey;
  };
  const selectedEnvironmentId =
    selectedEnvironmentIdOverride !== null &&
    projects.some((project) => project.environmentId === selectedEnvironmentIdOverride)
      ? selectedEnvironmentIdOverride
      : (projects[0]?.environmentId ?? null);
  const projectsForEnvironment = pipe(
    projects,
    Arr.filter((project) => project.environmentId === selectedEnvironmentId),
  );

  const selectedProject =
    projectsForEnvironment.find(
      (project) => scopedProjectKey(project.environmentId, project.id) === selectedProjectKey,
    ) ??
    projectsForEnvironment[0] ??
    null;

  const selectedEnvironmentServerConfig = useEnvironmentServerConfig(
    selectedProject?.environmentId ?? null,
  );
  const isScratchDraft =
    selectedProject !== null &&
    isScratchProject(selectedProject, selectedEnvironmentServerConfig?.scratchWorkspaceRoot);
  const serverConfigs = useServerConfigs();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const scratchEnvironments = connectedEnvironments.filter(
    (environment) =>
      availableScratchWorkspaceRoot(
        environment.connectionState,
        serverConfigs.get(environment.environmentId),
      ) !== null,
  );

  const selectedRepositoryKey = selectedProject?.repositoryIdentity
    ? repositoryGroupingKeyOf(selectedProject.repositoryIdentity)
    : null;
  // Use || null: placeholder workspaceRoot can be empty, and an empty basename rejects real hosts.
  const selectedWorkspaceBasename = selectedProject?.workspaceRoot.split("/").at(-1) || null;
  const selectedProjectTitle = selectedProject?.title ?? null;
  const environments = (() => {
    if (isScratchDraft) {
      return scratchEnvironments.map((environment) => ({
        environmentId: environment.environmentId,
        environmentLabel: environment.environmentLabel,
      }));
    }
    const seen = new Set<EnvironmentId>();
    const result: Array<{
      readonly environmentId: EnvironmentId;
      readonly environmentLabel: string;
    }> = [];
    const hostsSelectedRepository = (project: EnvironmentProject) => {
      if (selectedRepositoryKey === null && selectedWorkspaceBasename === null) {
        return true;
      }
      const projectKey = project.repositoryIdentity
        ? repositoryGroupingKeyOf(project.repositoryIdentity)
        : null;
      if (selectedRepositoryKey !== null && projectKey !== null) {
        return projectKey === selectedRepositoryKey;
      }
      return (
        project.workspaceRoot.split("/").at(-1) === selectedWorkspaceBasename ||
        (selectedProjectTitle !== null && project.title === selectedProjectTitle)
      );
    };
    for (const project of projects) {
      if (!hostsSelectedRepository(project)) {
        continue;
      }
      if (seen.has(project.environmentId)) {
        continue;
      }
      const environment = savedConnectionsById[project.environmentId];
      if (!environment) {
        continue;
      }
      seen.add(project.environmentId);
      result.push({
        environmentId: project.environmentId,
        environmentLabel: environment.environmentLabel,
      });
    }
    return result;
  })();

  const selectedProjectDraftKey = selectedProject ? activeDraftKey : null;
  const activePendingKey =
    props.active === false
      ? null
      : props.routeDraftId
        ? `draft-task:${props.routeDraftId}`
        : selectedProjectDraftKey
          ? `draft-task:${selectedProjectDraftKey}`
          : null;
  const activeNewTask = React.useMemo(
    () => (props.active === false ? null : { pendingKey: activePendingKey }),
    [props.active, activePendingKey],
  );
  const selectedProjectDraft = useComposerDraft(selectedProjectDraftKey);
  const prompt = selectedProjectDraft.text;
  const attachments = selectedProjectDraft.attachments;
  const projectGitStatus = useEnvironmentQuery(
    selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? vcsEnvironment.status({
          environmentId: selectedProject.environmentId,
          input: { cwd: selectedProject.workspaceRoot },
        })
      : null,
  );
  const currentCheckoutBranchName = projectGitStatus.data?.refName ?? null;
  // The unfiltered ref list also provides repository capability while offline.
  const projectBranches = useBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const knownIsGitRepo = projectGitStatus.data?.isRepo ?? projectBranches.data?.isRepo ?? null;
  const isGitRepo = knownIsGitRepo ?? true;
  const fileAccessSession = useEnvironmentQuery(
    selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? environmentSession.sessionStateAtom(selectedProject.environmentId)
      : null,
  );
  const fileEnvironment = useEnvironmentPresentation(selectedProject?.environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess({
    isCatalogReady: fileEnvironment.isReady,
    connection: fileEnvironment.presentation?.connection ?? null,
    session: fileAccessSession.data,
    sessionError: fileAccessSession.error,
  });
  const { canReadFiles } = fileAccess;
  const fileAccessPending =
    selectedProject !== null && selectedProject.workspaceRoot !== "" && fileAccess.isPending;
  const t3ProjectFileQuery = useEnvironmentQuery(
    canReadFiles && selectedProject !== null && selectedProject.workspaceRoot !== ""
      ? projectEnvironment.readFile({
          environmentId: selectedProject.environmentId,
          input: {
            cwd: selectedProject.workspaceRoot,
            relativePath: T3_PROJECT_FILE_NAME,
            allowMissing: true,
          },
        })
      : null,
  );
  const t3ProjectFileData = t3ProjectFileQuery.data as ProjectReadFileResult | null;
  const t3ProjectFile =
    t3ProjectFileData === null || t3ProjectFileData.exists === false || t3ProjectFileData.truncated
      ? null
      : parseT3ProjectFile(t3ProjectFileData.contents);
  const projectSettings = resolveProjectSettings(
    selectedEnvironmentServerConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
    selectedProject?.id ?? null,
    selectedProject,
    t3ProjectFile,
  );
  const canChooseWorkspace = !isScratchDraft;
  const selectedProjectHasThreads =
    selectedProject !== null &&
    threads.some(
      (thread) =>
        thread.environmentId === selectedProject.environmentId &&
        thread.projectId === selectedProject.id,
    );
  const defaultWorkspaceMode: WorkspaceMode = canChooseWorkspace
    ? resolveNewThreadEnvMode({
        projectSettings,
        workspaceRoot: selectedProject?.workspaceRoot ?? null,
        newProjectsRoot: selectedEnvironmentServerConfig?.newProjectsRoot,
        projectHasThreads: selectedProjectHasThreads,
      })
    : "local";
  // Do not persist the provisional workspace default while t3.json is loading; it would override
  // the file's eventual default.
  const defaultWorkspaceModeSettled =
    selectedProjectDraft.workspaceSelection?.mode !== undefined ||
    projectSettings.sources.defaultThreadEnvMode !== "environment" ||
    (!t3ProjectFileQuery.isPending && !fileAccessPending);
  // The picker runs its own filtered query; this unfiltered list feeds defaults.
  const branchState = usePaginatedBranches({
    environmentId: selectedProject?.environmentId ?? null,
    cwd: selectedProject?.workspaceRoot || null,
  });
  const branchesLoading = branchState.isPending && branchState.data === null;
  const allBranchRefs = branchState.refs;
  const availableBranches = pipe(
    allBranchRefs,
    Arr.filter((branch) => !branch.isRemote),
  );

  const resolveWorkspaceSelection = (selection: ComposerDraftWorkspaceSelection | undefined) =>
    fillNewTaskWorkspaceBranch({
      selection: resolveNewTaskWorkspaceSelection({
        selection: canChooseWorkspace ? selection : undefined,
        fallback: { mode: defaultWorkspaceMode, branch: null, worktreePath: null },
        isGitRepo,
      }),
      branches: allBranchRefs,
      projectCwd: selectedProject?.workspaceRoot ?? null,
      worktreeDefaultSettled: defaultWorkspaceModeSettled,
    });
  const workspaceSelection = resolveWorkspaceSelection(selectedProjectDraft.workspaceSelection);
  const workspaceMode = workspaceSelection.mode;
  const selectedBranchName = workspaceSelection.branch;
  const selectedWorktreePath = workspaceSelection.worktreePath;
  // Keep the user's explicit choice separate from the resolved display value:
  // only the explicit flag is ever written back to the draft, so the resolved
  // value keeps tracking the server setting when the config loads late.
  const draftStartFromOrigin = selectedProjectDraft.workspaceSelection?.startFromOrigin;
  const startFromOrigin =
    isGitRepo && (draftStartFromOrigin ?? projectSettings.settings.newWorktreesStartFromOrigin);
  const defaultRuntimeMode = projectSettings.settings.defaultRuntimeMode;
  const runtimeMode = selectedProjectDraft.runtimeMode ?? defaultRuntimeMode;

  // Antigravity keeps unavailable selections so sign-out or a catalog change
  // cannot switch the user's model.
  const draftModelSelection = resolveSelectableModelSelection(
    selectedEnvironmentServerConfig,
    selectedProjectDraft.modelSelection ?? null,
    selectedProject?.id ?? null,
  );
  const projectDefaultModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    projectSettings.settings.defaultModelSelection,
    selectedProject?.id ?? null,
  );
  const storedStickyModelSelection = useStickyComposerModelSelection();
  const stickyModelSelection = resolveDefaultableModelSelection(
    selectedEnvironmentServerConfig,
    storedStickyModelSelection,
    selectedProject?.id ?? null,
  );
  const modelOptions = buildModelOptions(
    selectedEnvironmentServerConfig,
    draftModelSelection ?? projectDefaultModelSelection ?? stickyModelSelection,
    undefined,
    selectedProject?.id ?? null,
  );

  const selectedModel = resolveNewTaskModelSelection({
    draftSelection: draftModelSelection,
    projectDefaultSelection: projectDefaultModelSelection,
    stickySelection: stickyModelSelection,
    modelOptions,
  });
  const selectedModelKey = selectedModel
    ? `${selectedModel.instanceId}:${selectedModel.model}`
    : null;

  const selectedModelOption =
    modelOptions.find(
      (option) =>
        selectedModel &&
        option.selection.instanceId === selectedModel.instanceId &&
        option.selection.model === selectedModel.model,
    ) ?? null;
  const selectedProviderStatus =
    selectedEnvironmentServerConfig?.providers.find(
      (provider) => provider.instanceId === selectedModel?.instanceId,
    ) ?? null;
  const planModeEnabled =
    legacyPlanModeEnabled && selectedProviderStatus?.showInteractionModeToggle !== false;
  const interactionMode = planModeEnabled
    ? (selectedProjectDraft.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE)
    : DEFAULT_PROVIDER_INTERACTION_MODE;
  const setSelectedModelKey = (
    key: string | null,
    options?: ReadonlyArray<ProviderOptionSelection>,
  ) => {
    const draftKey = key ? writableDraftKey() : null;
    if (!key || !draftKey) {
      return;
    }
    const option = modelOptions.find((candidate) => candidate.key === key);
    if (!option) {
      return;
    }
    const selection = withRememberedModelOptions(
      options ? { ...option.selection, options } : option.selection,
    );
    const provider = selectedEnvironmentServerConfig?.providers.find(
      (candidate) => candidate.instanceId === selection.instanceId,
    );
    updateComposerDraftSettings(draftKey, {
      modelSelection: selection,
      ...(provider?.showInteractionModeToggle === false
        ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
        : {}),
    });
    setStickyComposerModelSelection(selection);
  };
  const setSelectedModelOptions = (options: ReadonlyArray<ProviderOptionSelection> | undefined) => {
    const draftKey = selectedModel ? writableDraftKey() : null;
    if (!selectedModel || !draftKey) {
      return;
    }
    rememberModelOptions(selectedModel.instanceId, selectedModel.model, options ?? []);
    const nextSelection: ModelSelection = options
      ? { ...selectedModel, options }
      : {
          instanceId: selectedModel.instanceId,
          model: selectedModel.model,
        };
    updateComposerDraftSettings(draftKey, {
      modelSelection: nextSelection,
    });
    setStickyComposerModelSelection(nextSelection);
  };

  const providerGroups = groupByProvider(modelOptions);
  const setPrompt = (value: string) => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    setComposerDraftText(draftKey, value);
  };
  const replaceAttachments = (nextAttachments: ReadonlyArray<DraftComposerAttachment>) => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    replaceComposerDraftAttachments(draftKey, nextAttachments);
  };
  const appendAttachments = (
    nextAttachments: ReadonlyArray<DraftComposerAttachment>,
    insertion?: ComposerDraftInsertion,
  ): number => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return 0;
    }
    return appendComposerDraftAttachments(draftKey, nextAttachments, {
      appendReference: true,
      insertion,
    });
  };
  const removeAttachment = (imageId: string) => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    removeComposerDraftAttachment(draftKey, imageId);
  };
  const clearAttachments = () => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    replaceComposerDraftAttachments(draftKey, []);
  };
  // Moving to another project carries the draft along, or starts one when the
  // flow has none yet.
  const draftKeyFor = (project: EnvironmentProject): string | null => {
    const target = { environmentId: project.environmentId, projectId: project.id };
    const current = readFlow().draftKey;
    if (current !== null && isNewTaskDraftKey(current)) {
      retargetNewTaskDraft(current, target);
      return current;
    }
    return createNewTaskDraft(target);
  };

  const chooseProject = (
    environmentId: EnvironmentId,
    project: EnvironmentProject | null,
    draftKey: string | null,
  ) => {
    const projectKey =
      project === null ? null : scopedProjectKey(project.environmentId, project.id);
    if (project !== null && projectKey !== readFlow().projectKey) {
      refreshChosenProjectBranches(project);
    }
    updateFlow({ environmentId, projectKey, draftKey });
  };

  const setProject = (project: EnvironmentProject) => {
    chooseProject(project.environmentId, project, draftKeyFor(project));
  };

  const selectEnvironment = (environmentId: EnvironmentId) => {
    const match = resolveEnvironmentProjectMatch(
      projects.filter((project) => project.environmentId === environmentId),
      selectedProject,
    );
    chooseProject(environmentId, match ?? null, match ? draftKeyFor(match) : readFlow().draftKey);
  };

  const openScratch = useAtomCommand(projectEnvironment.openScratch, { reportFailure: false });
  const [switchingToEnvironmentId, setSwitchingToEnvironmentId] = useState<EnvironmentId | null>(
    null,
  );
  const latestSwitchRef = useRef<object | null>(null);
  const switchEnvironment = async (environmentId: EnvironmentId): Promise<boolean> => {
    if (environmentId === selectedEnvironmentId) {
      latestSwitchRef.current = null;
      setSwitchingToEnvironmentId(null);
      return true;
    }
    if (!isScratchDraft) {
      selectEnvironment(environmentId);
      return true;
    }
    const request = {};
    latestSwitchRef.current = request;
    setSwitchingToEnvironmentId(environmentId);
    const result = await openScratch({ environmentId, input: {} });
    if (latestSwitchRef.current !== request) return false;
    latestSwitchRef.current = null;
    setSwitchingToEnvironmentId(null);
    if (result._tag === "Success") {
      setProject(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Dialog.alert(
        "Could not switch machine",
        error instanceof Error
          ? error.message
          : "The folder for threads without a project could not be created.",
      );
    }
    return false;
  };

  const setWorkspaceMode = (mode: WorkspaceMode) => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    if (!selectedProject) {
      return;
    }
    const localSelection = resolveNewTaskLocalWorkspaceSelection({
      branches: availableBranches,
      projectCwd: selectedProject.workspaceRoot,
    });
    updateComposerDraftSettings(draftKey, {
      workspaceSelection: {
        mode,
        branch: mode === "local" ? localSelection.branch : selectedBranchName,
        worktreePath: mode === "local" ? localSelection.worktreePath : selectedWorktreePath,
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
        // Refs have not named the current branch yet; the selection follows it.
        ...(mode === "local" && localSelection.awaitsCurrentBranch
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const selectBranch = (branch: VcsRef) => {
    const draftKey = selectedProject ? writableDraftKey() : null;
    if (!selectedProject || !draftKey) {
      return;
    }
    updateComposerDraftSettings(draftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: branch.name,
        worktreePath: resolveNewTaskBranchWorktreePath({
          workspaceMode,
          projectCwd: selectedProject.workspaceRoot,
          branchWorktreePath: branch.worktreePath,
        }),
        ...(draftStartFromOrigin !== undefined ? { startFromOrigin: draftStartFromOrigin } : {}),
      },
    });
  };

  const setStartFromOrigin = (value: boolean) => {
    const draftKey = writableDraftKey();
    if (!draftKey) {
      return;
    }
    updateComposerDraftSettings(draftKey, {
      workspaceSelection: {
        mode: workspaceMode,
        branch: selectedBranchName,
        worktreePath: selectedWorktreePath,
        startFromOrigin: value,
        ...(selectedBranchName === null && workspaceSelection.followsCurrentCheckout
          ? { followsCurrentCheckout: true }
          : {}),
      },
    });
  };

  const refreshBranches = branchState.refresh;
  const loadBranches = () => {
    if (!selectedProject) {
      return;
    }
    setPendingConnectionError(null);
    refreshBranches();
  };

  const setRuntimeMode = (value: RuntimeMode) => {
    const draftKey = writableDraftKey();
    if (draftKey) {
      updateComposerDraftSettings(draftKey, { runtimeMode: value });
    }
  };
  const setInteractionMode = (value: ProviderInteractionMode) => {
    const draftKey = writableDraftKey();
    if (draftKey) {
      updateComposerDraftSettings(draftKey, {
        interactionMode: resolveProviderInteractionMode(selectedProviderStatus, value),
      });
    }
  };

  const buildPendingTaskMessage = (
    metadata: TurnCommandMetadata,
    options?: { readonly currentCheckoutBranch?: string | null },
  ): QueuedThreadMessage | null => {
    if (!selectedProject || !selectedProjectDraftKey) {
      return null;
    }
    const draft = getComposerDraftSnapshot(selectedProjectDraftKey);
    return assemblePendingTaskMessage({
      project: selectedProject,
      draft,
      serverConfig: selectedEnvironmentServerConfig,
      fallbackModelSelection: selectedModel,
      workspaceSelection: resolveWorkspaceSelection(draft.workspaceSelection),
      startFromOriginDefault: startFromOrigin,
      defaultRuntimeMode,
      planModeEnabled: legacyPlanModeEnabled,
      metadata,
      currentCheckoutBranch: options?.currentCheckoutBranch ?? null,
    });
  };

  const value = {
    activeNewTask,
    projectScopes,
    selectedEnvironmentId,
    selectedProjectKey,
    selectedModelKey,
    workspaceMode,
    isGitRepo,
    isGitRepoKnown: knownIsGitRepo !== null,
    canChooseWorkspace,
    selectedBranchName,
    selectedWorktreePath,
    startFromOrigin,
    draftKey: selectedProjectDraftKey,
    pullRequestReference: selectedProjectDraft.workspaceSelection?.pullRequestReference,
    prompt,
    attachments,
    submitting,
    branchesLoading,
    availableBranches,
    currentCheckoutBranchName,
    runtimeMode,
    interactionMode,
    planModeEnabled,
    expandedProvider,
    environments,
    selectedProject,
    isScratchDraft,
    modelOptions,
    selectedModel,
    selectedModelOption,
    selectedProviderStatus,
    providerGroups,
    getSelectedProjectKey: () => readFlow().projectKey,
    setProject,
    routeTargetMissing: routeDraftResolution.kind === "missing",
    selectEnvironment,
    switchEnvironment,
    switchingToEnvironmentId,
    setSelectedModelKey,
    setWorkspaceMode,
    selectBranch,
    setStartFromOrigin,
    resolveWorkspaceSelection,
    buildPendingTaskMessage,
    setPrompt,
    replaceAttachments,
    appendAttachments,
    removeAttachment,
    clearAttachments,
    setSubmitting: (value: boolean) => updateFlow({ submitting: value }),
    loadBranches,
    setRuntimeMode,
    setInteractionMode,
    setSelectedModelOptions,
    setExpandedProvider: (value: string | null) => updateFlow({ expandedProvider: value }),
  } satisfies NewTaskFlowContextValue;

  return (
    <ActiveNewTaskContext value={activeNewTask}>
      <NewTaskFlowContext.Provider value={value}>{props.children}</NewTaskFlowContext.Provider>
    </ActiveNewTaskContext>
  );
}

export function useNewTaskFlow() {
  const value = React.use(NewTaskFlowContext);
  if (value === null) {
    throw new Error("useNewTaskFlow must be used within NewTaskFlowProvider.");
  }
  return value;
}
