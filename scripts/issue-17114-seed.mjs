// Run in an authenticated isolated Vite app with preview_evaluate:
// (await import('/@fs/ABSOLUTE_WORKTREE/scripts/issue-17114-seed.mjs')).seed({environmentId, workspaceRoot, modelSelection})
// Keep returned IDs private. No provider turn is started. Use separate paired
// browser profiles for additional viewers; this helper grants no credentials.
export async function seed({ environmentId, workspaceRoot, modelSelection }) {
  const { appAtomRegistry: registry } = await import("/src/rpc/atomRegistry.ts");
  const { projectEnvironment } = await import("/src/state/projects.ts");
  const { threadEnvironment } = await import("/src/state/threads.ts");
  const { previewEnvironment } = await import("/src/state/preview.ts");
  const projectId = "issue-17114-evidence-project";
  const threadId = "issue-17114-evidence-thread";
  const run = async (command, input) => {
    const result = await command.run(registry, { environmentId, input });
    if (result._tag !== "Success") throw new Error(JSON.stringify(result));
    return result.value;
  };
  await run(projectEnvironment.create, {
    commandId: "issue-17114-project-create-v1",
    projectId,
    title: "Browser auth evidence",
    workspaceRoot,
    createWorkspaceRootIfMissing: false,
    defaultModelSelection: null,
  });
  await run(threadEnvironment.create, {
    commandId: "issue-17114-thread-create-v1",
    projectId,
    threadId,
    title: "Browser auth fixture",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  });
  const tab = await run(previewEnvironment.open, {
    threadId,
    runtime: "server",
    url: "http://127.0.0.1:18914/public",
    reveal: false,
  });
  return { environmentId, projectId, threadId, tabId: tab.tabId };
}
