/** Capture-only boundary. Install before app modules; never import in product code.
 * Set sessionStorage menu-19208-capture to true in the capture tab only.
 * The fixture uses actual routes, RPC decoders, components, styles and portals.
 */
(() => {
  if (sessionStorage.getItem("menu-19208-capture") !== "true") return;
  const fixture = globalThis.__menu19208Fixture;
  const NativeDate = Date;
  const epoch = NativeDate.parse(fixture.clock);
  globalThis.Date = new Proxy(NativeDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [epoch], newTarget);
    },
    get(target, key, receiver) {
      return key === "now" ? () => epoch : Reflect.get(target, key, receiver);
    },
  });
  globalThis.__menu19208Requests = [];
  const nativeFetch = fetch;
  globalThis.fetch = async (...args) => {
    const url = String(args[0]?.url ?? args[0]);
    if (url.includes("/api/orchestration/shell")) return Response.json(fixture.shell);
    if (url.includes("/api/orchestration/threads/")) {
      if (url.includes("/bounded"))
        return Response.json({
          ...fixture.detail,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: 2,
        });
      return Response.json(fixture.detail);
    }
    return nativeFetch(...args);
  };
  const NativeWebSocket = WebSocket;
  globalThis.WebSocket = class extends NativeWebSocket {
    send(data) {
      if (typeof data !== "string") return super.send(data);
      let requests;
      try {
        requests = JSON.parse(data);
      } catch {
        return super.send(data);
      }
      const list = Array.isArray(requests) ? requests : [requests];
      const pass = [];
      for (const r of list) {
        if (r._tag !== "Request") {
          pass.push(r);
          continue;
        }
        __menu19208Requests.push({ tag: r.tag, payload: r.payload });
        const emit = (value) =>
          queueMicrotask(() =>
            this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })),
          );
        const chunk = (value) => emit({ _tag: "Chunk", requestId: r.id, values: [value] });
        const success = (value) =>
          emit({ _tag: "Exit", requestId: r.id, exit: { _tag: "Success", value } });
        if (r.tag === "orchestration.subscribeShell")
          chunk({ kind: "snapshot", snapshot: fixture.shell });
        else if (r.tag === "orchestration.subscribeThread") {
          chunk({ kind: "snapshot", ...fixture.detail });
          chunk({ kind: "synchronized" });
        } else if (
          r.tag === "orchestration.getTurnDiff" ||
          r.tag === "orchestration.getFullThreadDiff"
        )
          success({
            threadId: fixture.detail.projection.thread.id,
            fromTurnCount: r.payload.fromTurnCount ?? 0,
            toTurnCount: r.payload.toTurnCount ?? 2,
            diff: fixture.diff,
          });
        else if (r.tag === "subscribeVcsStatus")
          chunk({
            _tag: "snapshot",
            local: {
              isRepo: true,
              hasPrimaryRemote: false,
              isDefaultRef: false,
              refName: "synthetic-menu-proof",
              hasWorkingTreeChanges: true,
              workingTree: {
                rootPath: fixture.shell.projects[0].workspaceRoot,
                files: [{ path: "example.ts", insertions: 1, deletions: 1 }],
                insertions: 1,
                deletions: 1,
              },
            },
            remote: null,
          });
        else if (r.tag === "orchestration.dispatchCommand")
          success({ commandId: r.payload.command?.commandId ?? "menu-19208-command", sequence: 0 });
        else if (r.tag === "review.getDiffPreview")
          success({
            cwd: fixture.shell.projects[0].workspaceRoot,
            generatedAt: fixture.clock,
            sources: [
              {
                id: "menu-19208-dirty",
                kind: "working-tree",
                title: "Uncommitted",
                baseRef: null,
                headRef: null,
                diff: fixture.diff,
                diffHash: "menu-19208-diff",
                truncated: false,
              },
            ],
          });
        else if (r.tag === "review.getDiffFileContents")
          success({
            oldContents: 'export const greeting = "Hello";\n',
            newContents: 'export const greeting = "Hello, world";\n',
          });
        else pass.push(r);
      }
      if (pass.length)
        super.send(Array.isArray(requests) ? JSON.stringify(pass) : JSON.stringify(pass[0]));
    }
  };
})();
