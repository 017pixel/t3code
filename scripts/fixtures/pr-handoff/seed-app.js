// Run in an authenticated isolated app tab; pass fixture.json and a live model selection.
globalThis.seedIssue16455 = async function (fixture, modelSelection) {
  if (!modelSelection?.instanceId || !modelSelection?.model) {
    throw new Error(
      "Pass a valid model selection from this environment. No provider turn is started.",
    );
  }
  const response = await fetch("/api/orchestration/shell", {
    headers: { "x-t3-orchestration-protocol": "2" },
  });
  if (!response.ok) throw new Error(`Shell snapshot: HTTP ${response.status}`);
  const snapshot = await response.json();
  const socket = new WebSocket(
    `${location.origin.replace(/^http/, "ws")}/ws?orchestrationProtocol=2`,
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Could not connect to the authenticated app socket")),
      { once: true },
    );
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message._tag === "Ping") {
      socket.send(JSON.stringify({ _tag: "Pong" }));
      return;
    }
    const entry = pending.get(String(message.requestId));
    if (!entry || message._tag !== "Exit") return;
    pending.delete(String(message.requestId));
    clearTimeout(entry.timeout);
    if (message.exit._tag === "Success") entry.resolve(message.exit.value);
    else entry.reject(new Error(JSON.stringify(message.exit)));
  });
  const rpc = (tag, payload) =>
    new Promise((resolve, reject) => {
      const id = String(nextId++);
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${tag} timed out`));
      }, 30000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  try {
    for (const project of fixture.projects) {
      if (!snapshot.projects.some((item) => item.id === project.id))
        await rpc("projects.mutate", {
          type: "project.create",
          commandId: crypto.randomUUID(),
          projectId: project.id,
          title: project.title,
          workspaceRoot: `${fixture.root}/${project.directory}`,
        });
    }
    if (!snapshot.threads.some((item) => item.id === fixture.thread.id))
      await rpc("orchestration.dispatchCommand", {
        type: "thread.create",
        commandId: crypto.randomUUID(),
        threadId: fixture.thread.id,
        projectId: fixture.thread.projectId,
        title: fixture.thread.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: fixture.thread.branch,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
    await rpc("orchestration.dispatchCommand", {
      type: "thread.pull-request.link",
      commandId: crypto.randomUUID(),
      threadId: fixture.thread.id,
      ...fixture.pullRequest,
      source: "manual",
    });
    return { threadId: fixture.thread.id, pullRequest: fixture.pullRequest.url };
  } finally {
    socket.close();
  }
};
