// Run in a paired isolated dev browser, passing the real app's registry,
// threadEnvironment commands and snapshotAtom. No provider turns are started.
export async function issue15572Fixture(
  { registry, commands, projectCommands, snapshotAtom, environmentId, readArchived },
  preset = "reset",
) {
  const expectedEnvironment = "ab5fcc8e-bf0e-4db7-931b-6dde04fb25b9";
  const projectId = "project:214f796a-b3a7-4144-8d2a-df416aa22722";
  if (
    environmentId !== expectedEnvironment ||
    !["localhost", "127.0.0.1"].includes(location.hostname)
  ) {
    throw new Error("This fixture only operates on its isolated loopback environment");
  }
  const names = [
    "alpha",
    "beta",
    "gamma",
    "pinned",
    "snoozed",
    "long",
    ...Array.from({ length: 36 }, (_, i) => `tail-${String(i + 1).padStart(2, "0")}`),
  ];
  const titles = new Map(
    names.map((name) => [`issue-15572-${name}`, `Target ${name[0].toUpperCase()}${name.slice(1)}`]),
  );
  titles.set(
    "issue-15572-long",
    "Target Long title that deliberately extends beyond the available sidebar width to exercise truncation",
  );
  const presets = [
    "reset",
    "S1",
    "S2-empty",
    "S2-active",
    "S2-settled",
    "R1",
    "R8-10",
    "R8-11",
    "R8-36",
    "R9",
  ];
  if (!presets.includes(preset)) throw new Error(`Unknown preset ${preset}`);
  const read = () => registry.get(snapshotAtom(environmentId));
  const initial = read();
  if (!initial) throw new Error("Wait for the environment shell before running the fixture");
  const workspaceRoot = "/tmp/issue-15572-fixture-workspace";
  const project = initial.projects.find((project) => project.id === projectId);
  if (
    project &&
    (project.title !== "Issue 15572 fixture" || project.workspaceRoot !== workspaceRoot)
  ) {
    throw new Error("Refusing to reuse an unrecognized fixture project");
  }
  if (!project) {
    const result = await projectCommands.create.run(registry, {
      environmentId,
      input: {
        projectId,
        title: "Issue 15572 fixture",
        workspaceRoot,
        createWorkspaceRootIfMissing: true,
      },
    });
    if (result._tag !== "Success") throw new Error("Fixture project creation failed");
  }
  const all = [...initial.threads, ...(await readArchived())];
  for (const thread of all.filter((thread) => titles.has(thread.id))) {
    if (
      thread.projectId !== projectId ||
      thread.title !== titles.get(thread.id) ||
      thread.activeRunId !== null ||
      thread.activeProviderThreadId !== null
    ) {
      throw new Error(`Refusing to mutate unrecognized or running fixture ${thread.id}`);
    }
  }
  const template = all.find((thread) => thread.id === "issue-15572-alpha");
  if (!template) throw new Error("The allowlisted Alpha shell must already exist");
  const outcomes = [];
  const run = async (operation, threadId, extra = {}) => {
    if (!titles.has(threadId)) throw new Error("Thread is outside fixture allowlist");
    const result = await commands[operation].run(registry, {
      environmentId,
      input: { threadId, ...extra },
    });
    outcomes.push({ operation, threadId, outcome: result._tag });
    if (result._tag !== "Success") throw new Error(`${operation} failed for ${threadId}`);
  };
  const desired =
    preset === "S1"
      ? names.slice(0, 6)
      : preset.startsWith("R8-")
        ? ["alpha", ...names.slice(6, 6 + Number(preset.slice(3)))]
        : preset === "S2-empty"
          ? []
          : preset.startsWith("S2-")
            ? ["alpha"]
            : names.slice(0, 3);
  const ids = desired.map((name) => `issue-15572-${name}`);
  for (const thread of all.filter(
    (thread) => titles.has(thread.id) && !ids.includes(thread.id) && thread.archivedAt === null,
  ))
    await run("archive", thread.id);
  for (const [index, id] of ids.entries()) {
    const existing = all.find((thread) => thread.id === id);
    if (!existing)
      await run("create", id, {
        projectId,
        title: titles.get(id),
        modelSelection: template.modelSelection,
        runtimeMode: template.runtimeMode,
        interactionMode: template.interactionMode,
        branch: null,
        worktreePath: null,
      });
    else if (existing.archivedAt !== null) await run("unarchive", id);
    const settled =
      id.includes("tail-") || preset === "S2-settled" || (preset === "S1" && id.endsWith("gamma"));
    const pinned = id.endsWith("pinned");
    const snoozed = id.endsWith("snoozed");
    const orderKey = String.fromCharCode(index < 3 ? 99 - index : 100 + index);
    if (existing?.snoozedUntil && !snoozed) await run("unsnooze", id, { reason: "user" });
    if (existing?.pinnedAt && !pinned) await run("unpin", id);
    if (!settled && existing?.settledOverride === "settled")
      await run("unsettle", id, { reason: "user" });
    if (!settled && existing?.activeOrderKey !== orderKey)
      await run("reorderActive", id, { orderKey });
    if (settled && existing?.settledOverride !== "settled") await run("settle", id);
    if (pinned && !existing?.pinnedAt) await run("pin", id, { orderKey: "a" });
    if (snoozed && !existing?.snoozedUntil)
      await run("snooze", id, { snoozedUntil: "2035-01-01T12:00:00.000Z" });
  }
  const result = {
    preset,
    environmentId,
    projectId,
    ids,
    outcomes,
    requiresUi: preset === "R9" ? "Create and discard unsent drafts through the composer" : null,
    unavailable: preset === "S1" ? ["working: fixture deliberately starts no provider turn"] : [],
  };
  console.info(JSON.stringify(result));
  return result;
}

export async function runIssue15572Fixture(preset = "reset") {
  const { appAtomRegistry: registry } = await import("/src/rpc/atomRegistry.ts");
  const { threadEnvironment: commands } = await import("/src/state/threads.ts");
  const { projectEnvironment: projectCommands } = await import("/src/state/projects.ts");
  const { environmentSnapshotAtom: snapshotAtom } = await import("/src/state/shell.ts");
  const { orchestrationEnvironment } = await import("/src/state/orchestration.ts");
  const { waitForAtomValue } = await import("/src/state/waitForAtomValue.ts");
  const environmentId = "ab5fcc8e-bf0e-4db7-931b-6dde04fb25b9";
  const readArchived = async () => {
    const atom = orchestrationEnvironment.archivedShellSnapshot({ environmentId, input: {} });
    registry.refresh(atom);
    const ready = await waitForAtomValue({
      registry,
      atom,
      predicate: (result) => result._tag === "Success" && !result.waiting,
      timeoutMs: 10_000,
    });
    if (!ready) throw new Error("Archived fixture snapshot unavailable");
    return registry.get(atom).value.threads;
  };
  return issue15572Fixture(
    { registry, commands, projectCommands, snapshotAtom, environmentId, readArchived },
    preset,
  );
}
