// Evaluate the source in the real Vite app with preview_evaluate after pairing.
(async () => {
  const { appAtomRegistry: registry } = await import("/src/rpc/atomRegistry.ts");
  const { primaryEnvironmentIdAtom } = await import("/src/state/primaryEnvironment.ts");
  const { connectionAtomRuntime } = await import("/src/connection/runtime.ts");
  const { createEnvironmentRpcCommand } =
    await import("/@fs/home/ubuntu/wt/issue-20883/packages/client-runtime/src/state/runtime.ts");
  const { projectEnvironment } = await import("/src/state/projects.ts");
  const { threadEnvironment } = await import("/src/state/threads.ts");
  const { environmentSnapshotAtom } = await import("/src/state/shell.ts");
  const settings = await import("/src/hooks/useSettings.ts");
  const env = registry.get(primaryEnvironmentIdAtom);
  const rpc = (tag, input) =>
    createEnvironmentRpcCommand(connectionAtomRuntime, { label: "public-proof:" + tag, tag }).run(
      registry,
      { environmentId: env, input },
    );
  const dispatch = (command) =>
    rpc("orchestration.dispatchCommand", { commandId: crypto.randomUUID(), ...command });
  const project = (command, input) =>
    projectEnvironment[command].run(registry, { environmentId: env, input });
  const titles = {
    other: "Quiet destination",
    complete: "Public completion fixture",
    input:
      "Public question fixture with a long descriptive title that wraps at narrow viewport widths",
    approval: "Public approval fixture",
    failed:
      "Public runtime failure fixture — " +
      "A deliberately long public description for the notification clamp. ".repeat(4),
    limited: "Public usage limit fixture",
  };
  const create = (id, kind) =>
    threadEnvironment.create.run(registry, {
      environmentId: env,
      input: {
        threadId: id,
        projectId: "proof-project",
        title: titles[kind],
        modelSelection: { instanceId: "proof", model: "gpt-5.6-sol" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      },
    });
  window.proof = {
    env,
    registry,
    rpc,
    dispatch,
    project,
    create,
    titles,
    snapshot: () => registry.get(environmentSnapshotAtom(env)),
    send: (threadId, kind) =>
      dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        threadId,
        messageId: crypto.randomUUID(),
        text: "PROOF:" + kind,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      }),
    async seed() {
      const results = [];
      results.push(
        await rpc("server.updateSettings", {
          patch: {
            providerInstances: {
              proof: {
                driver: "codex",
                displayName: "Public fixture",
                config: {
                  binaryPath:
                    "/home/ubuntu/wt/issue-20883/apps/server/scripts/issue-20883-proof/provider.mjs",
                },
              },
            },
          },
        }),
      );
      results.push(
        await project("create", {
          projectId: "proof-project",
          title: "Public notification proof",
          workspaceRoot: "/tmp/issue-20883-public-project",
        }),
      );
      for (const kind of Object.keys(titles)) results.push(await create("proof-" + kind, kind));
      await settings.updateClientSettings({
        inAppNotificationsEnabled: true,
        notificationMode: "off",
      });
      return results.map((r) => r._tag);
    },
    freeze(epoch = 1792670400000) {
      const RealDate = window.__proofRealDate ?? Date;
      window.__proofRealDate = RealDate;
      window.Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [epoch]));
        }
        static now() {
          return epoch;
        }
      };
    },
  };
  return { env, ready: true };
})();
