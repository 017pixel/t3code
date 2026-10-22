// Import from the isolated Vite app; authentication stays in the browser session.
const { appAtomRegistry: registry } = await import("/src/rpc/atomRegistry.ts");
const { threadEnvironment, environmentThreadDetails } = await import("/src/state/threads.ts");
const { projectEnvironment } = await import("/src/state/projects.ts");
const { useDiffPanelStore } = await import("/src/diffPanelStore.ts");
const { environmentId } = await fetch("/.well-known/t3/environment").then((response) =>
  response.json(),
);
const selection = { instanceId: "grok", model: "grok-4.6" };
const ref = (threadId) => ({ environmentId, threadId });
async function command(command, input) {
  const result = await command.run(registry, { environmentId, input });
  if (result._tag !== "Success") throw new Error("Fixture app command failed");
  return result.value;
}
export async function create(root, threadId, title = "Checkpoint availability") {
  if (!root.startsWith("/tmp/issue-15843-replay-"))
    throw new Error("Supply an isolated replay root");
  const projectId = `${threadId}-project`;
  await command(projectEnvironment.create, {
    projectId,
    title: "Checkpoint proof",
    workspaceRoot: `${root}/project`,
  });
  await command(threadEnvironment.create, {
    threadId,
    projectId,
    title,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
  });
  return ref(threadId);
}
export const start = (threadId, turn) =>
  command(threadEnvironment.startTurn, {
    threadId,
    message: {
      messageId: `${threadId}-${turn}`,
      role: "user",
      text: `FIXTURE:${turn}`,
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: "default",
  });
export const fork = (sourceThreadId, targetThreadId, runId) =>
  command(threadEnvironment.forkFromRun, {
    sourceThreadId,
    targetThreadId,
    runId,
    title: "Inherited checkpoint proof",
  });
export function state(threadId) {
  const target = ref(threadId);
  return {
    checkpoints: registry.get(environmentThreadDetails.checkpointSummariesAtom(target)),
    items: registry
      .get(environmentThreadDetails.visibleTurnItemsAtom(target))
      .map(({ item, sourceThreadId }) => ({
        type: item.type,
        runId: item.runId,
        status: item.status,
        sourceThreadId,
        fileName: item.fileName,
      })),
  };
}
export function checkpoint(threadId, runId) {
  const atom = environmentThreadDetails.checkpointSummariesAtom(ref(threadId));
  return new Promise((resolve) => {
    let unsubscribe;
    const check = (summaries) => {
      const summary = summaries.find((item) => item.runId === runId);
      if (summary) {
        unsubscribe?.();
        resolve(summary);
      }
    };
    unsubscribe = registry.subscribe(atom, check);
    check(registry.get(atom));
  });
}
// This is selection injection, never an ordinary UI action. Label its captures.
export const selectUnavailable = (threadId, runId, filePath) =>
  useDiffPanelStore.getState().selectTurn(ref(threadId), runId, filePath);
export function freezeVisibleClock() {
  if (window.checkpointFixtureClock) return;
  const OriginalDate = Date;
  window.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : ["2026-10-22T08:00:00.000Z"]));
    }
    static now() {
      return 1792656000000;
    }
  };
  window.checkpointFixtureClock = true;
}
