/** Run in the paired isolated app's browser console. Setup only; send via the composer. */
globalThis.setupIssue10056 = async ({ home, providerPath, suffix = "literal" }) => {
  if (!home.startsWith("/tmp/issue-10056-evidence/") || home.includes(".."))
    throw new Error("Use a dedicated synthetic evidence home");
  if (!providerPath.endsWith("/scripts/fixtures/issue-10056/provider.sh"))
    throw new Error("Expected the deterministic provider fixture");
  const descriptor = await fetch("/.well-known/t3/environment").then((r) => r.json());
  const { ticket } = await fetch("/api/auth/websocket-ticket", { method: "POST" }).then((r) =>
    r.json(),
  );
  const url = new URL("/ws", location.href);
  url.protocol = "ws:";
  url.search = new URLSearchParams({ orchestrationProtocol: "2", wsTicket: ticket });
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 1;
  const call = (tag, payload) =>
    new Promise((resolve, reject) => {
      const id = String(next++);
      const listener = (event) => {
        const frame = JSON.parse(event.data);
        if (frame._tag !== "Exit" || frame.requestId !== id) return;
        ws.removeEventListener("message", listener);
        frame.exit._tag === "Success" ? resolve(frame.exit.value) : reject(frame.exit);
      };
      ws.addEventListener("message", listener);
      ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  const modelSelection = { instanceId: "codex", model: "gpt-6.1-sol" };
  await call("server.updateSettings", {
    patch: { sidebarAutoSettleAfterDays: null },
    providerInstanceMutation: {
      operation: "upsert",
      instanceId: "codex",
      instance: { driver: "codex", enabled: true, config: { binaryPath: providerPath } },
    },
  });
  const projectId = "issue10056-project";
  await call("projects.mutate", {
    type: "project.create",
    commandId: crypto.randomUUID(),
    projectId,
    title: "Synthetic recall",
    workspaceRoot: "/tmp/issue-10056-public",
    createWorkspaceRootIfMissing: true,
  }).catch((error) => {
    if (!JSON.stringify(error).includes("already exists and cannot be created twice")) throw error;
  });
  const threadId = "issue10056-" + suffix;
  await call("orchestration.dispatchCommand", {
    type: "thread.create",
    commandId: crypto.randomUUID(),
    threadId,
    projectId,
    title: "Literal history",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  ws.close();
  return {
    environmentId: descriptor.environmentId,
    threadId,
    path: "/" + descriptor.environmentId + "/" + threadId,
  };
};
