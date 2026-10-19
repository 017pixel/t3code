import { RegistryContext } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type AuthEnvironmentScope,
  type EditorId,
  type FilesystemEntryMetadata,
  type ScopedThreadRef,
  type ThreadLinkedPullRequest,
} from "@t3tools/contracts";
import {
  createThreadFilePathIndex,
  type ThreadFilePathIndex,
} from "@t3tools/shared/threadFilePaths";
import { searchableMessageSegments } from "@t3tools/shared/threadFindText";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useRightPanelStore } from "../rightPanelStore";
import { FileMetadataThreadContext } from "../hooks/FileMetadataThreadProvider";
import { ThreadFilePathsContext } from "../threadFilePathsContext";
import { FileMarkdownPreview } from "./files/FileMarkdownPreview";

const state = vi.hoisted(() => ({
  connection: { _tag: "Some", value: { httpBaseUrl: "https://host.test" } },
  allowed: true,
  canRead: true,
  listeners: new Set<() => void>(),
  openEditor: vi.fn(),
  updateMetadata: vi.fn(),
  search: vi.fn(),
  choose: vi.fn(),
  openFile: vi.fn(),
  openExternal: vi.fn(),
  copy: vi.fn(),
  linkedPullRequest: null as ThreadLinkedPullRequest | null,
}));

vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: (() => state.search) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => {
  const { threadEnvironment } = await import("../state/threads");
  return {
    ...(await original()),
    useAtomCommand: ((command: unknown) =>
      command === threadEnvironment.updateMetadata
        ? state.updateMetadata
        : state.openEditor) as never,
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { useSyncExternalStore } = await import("react");
  const readEnvironmentScope = (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    id !== null &&
    (scope !== AuthFilesystemReadScope || state.canRead) &&
    (scope !== AuthOrchestrationOperateScope || id !== threadRef.environmentId || state.allowed);
  return {
    ...(await original()),
    readEnvironmentScope,
    usePreparedConnection: (() => state.connection) as never,
    useEnvironmentScope: (id: EnvironmentId | null, scope: AuthEnvironmentScope) =>
      useSyncExternalStore(
        (listener) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        () => readEnvironmentScope(id, scope),
      ),
  };
});
// Atoms derived from the server config run in the real registry over this config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const config = Atom.make(() => serverConfig);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => config) as never },
    environmentServerConfigsAtom: Atom.make(
      () => new Map([[threadRef.environmentId, serverConfig]]),
    ) as never,
  };
});
// Replace only the transport-owned result; the metadata hook and query subscription stay real.
vi.mock(import("../state/projects"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    projectEnvironment: {
      ...actual.projectEnvironment,
      fileMetadata: (target) =>
        metadataAtom(target.input.path, {
          environmentId: target.environmentId,
          threadId: target.input.threadId,
        }),
    },
  };
});
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ linkedPullRequest: state.linkedPullRequest })) as never,
  useProjects: (() => [
    { id: linkedPullRequest.projectId, environmentId: threadRef.environmentId },
  ]) as never,
}));
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("../hooks/useLocalStorage"), async (original) => ({
  ...(await original()),
  useLocalStorage: (() => ["vscode", vi.fn()]) as never,
  getLocalStorageItem: (() => "vscode") as never,
}));
vi.mock(import("../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: () =>
    ({
      contextMenu: { show: state.choose },
      shell: { openExternal: state.openExternal },
    }) as never,
}));
vi.mock(import("~/lib/openPullRequestLink"), async (original) => ({
  ...(await original()),
  resolvePullRequestPreviewTarget: () => null,
  findProjectForChangeRequest: ((projects: readonly { id: ProjectId }[]) => projects[0]) as never,
  matchesLinkedPullRequestUrl: (candidate: ThreadLinkedPullRequest, href: string) =>
    candidate.url === href,
  parseChangeRequestUrl: ((href: string) =>
    href === linkedPullRequest.url
      ? {
          host: "github.com",
          repository: linkedPullRequest.repository,
          number: linkedPullRequest.number,
        }
      : null) as never,
}));

import ChatMarkdown from "./ChatMarkdown";

const threadRef = {
  environmentId: EnvironmentId.make("selected"),
  threadId: ThreadId.make("thread"),
};
const linkedPullRequest: ThreadLinkedPullRequest = {
  projectId: ProjectId.make("project"),
  repository: "example/repo",
  number: 42,
  url: "https://github.com/example/repo/pull/42",
};
const serverConfig = {
  availableEditors: ["vscode", "file-manager"] as readonly EditorId[],
  shellRevealInFileManager: true,
  shellRevealInFileManagerKind: "xdg-open",
  environment: { platform: { os: "linux" }, capabilities: { threadPullRequestLinking: true } },
};
const roots: Root[] = [];
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;
const metadataResults = Atom.family((_key: string) =>
  Atom.make<AsyncResult.AsyncResult<FilesystemEntryMetadata | null, Error>>(
    AsyncResult.initial(true),
  ).pipe(Atom.keepAlive),
);
function metadataAtom(
  path: string,
  owner: { environmentId: EnvironmentId; threadId?: ThreadId | undefined } = threadRef,
) {
  return metadataResults(JSON.stringify([owner.environmentId, owner.threadId, path]));
}
async function settleMetadata(
  path: string,
  result: AsyncResult.AsyncResult<FilesystemEntryMetadata | null, Error>,
  owner: ScopedThreadRef = threadRef,
) {
  await act(async () => registry.set(metadataAtom(path, owner), result));
}

beforeEach(() => {
  state.allowed = true;
  state.canRead = true;
  registry = AtomRegistry.make();
  state.listeners.clear();
  state.linkedPullRequest = null;
  state.openEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.updateMetadata.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.search.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  state.choose.mockReset().mockResolvedValue(null);
  state.openFile.mockReset();
  state.openExternal.mockReset().mockResolvedValue(undefined);
  state.copy.mockReset().mockResolvedValue(undefined);
  useRightPanelStore.setState({ openFile: state.openFile });
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(state.copy);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  registry.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function createTestRoot() {
  container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  roots.push(root);
  return async (
    children: ReactNode,
    index: ThreadFilePathIndex | null = null,
    owner: ScopedThreadRef = threadRef,
  ) => {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <FileMetadataThreadContext value={owner}>
            <ThreadFilePathsContext value={index}>{children}</ThreadFilePathsContext>
          </FileMetadataThreadContext>
        </RegistryContext.Provider>,
      ),
    );
  };
}

async function renderMarkdown(text: string) {
  await createTestRoot()(<ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />);
}

function anchor() {
  return container.querySelector("a")!;
}

async function openContextMenu() {
  await act(async () => {
    anchor().dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }),
    );
  });
}

function offeredActions() {
  return state.choose.mock.lastCall![0].map((item: { id: string }) => item.id);
}

async function setAllowed(allowed: boolean) {
  await act(async () => {
    state.allowed = allowed;
    for (const listener of state.listeners) listener();
  });
}

it("removes host actions after revocation while keeping file preview and copying", async () => {
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toEqual(["open", "reveal", "copy-relative", "copy-full"]);
  await setAllowed(false);
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(offeredActions()).toEqual(["copy-relative", "copy-full"]);
  await vi.waitFor(() => expect(state.copy).toHaveBeenCalledWith("/work/docs/readme.md"));
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenCalledWith(threadRef, "docs/readme.md", undefined);
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not launch an editor after revocation during a native context menu", async () => {
  let choose: (action: string) => void = () => {
    throw new Error("Menu not opened");
  };
  state.choose.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        choose = resolve;
      }),
  );
  await renderMarkdown("[Readme](docs/readme.md)");
  await openContextMenu();
  expect(offeredActions()).toContain("open");
  await act(async () => {
    state.allowed = false;
    choose("open");
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it("does not reveal a file after revocation during its workspace lookup", async () => {
  let finishLookup: () => void = () => {
    throw new Error("Lookup not started");
  };
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = () => resolve(AsyncResult.success({ entries: [] }));
      }),
  );
  state.choose.mockResolvedValue("reveal");
  await renderMarkdown("[Readme](readme.md)");
  await openContextMenu();
  expect(state.search).toHaveBeenCalledOnce();
  await act(async () => {
    state.allowed = false;
    finishLookup();
  });
  expect(state.openEditor).not.toHaveBeenCalled();
});

it.each([false, true])(
  "keeps PR links usable without offering metadata edits (linked=%s)",
  async (linked) => {
    state.allowed = false;
    state.linkedPullRequest = linked ? linkedPullRequest : null;
    state.choose.mockResolvedValue("open-external");
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toEqual(["open-external", "copy-link"]);
    await vi.waitFor(() => expect(state.openExternal).toHaveBeenCalledWith(linkedPullRequest.url));
    expect(state.updateMetadata).not.toHaveBeenCalled();
  },
);

it.each(["link-to-thread", "unlink-from-thread"])(
  "rechecks %s after a native context menu returns",
  async (action) => {
    state.linkedPullRequest = action === "unlink-from-thread" ? linkedPullRequest : null;
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await renderMarkdown(`[Review](${linkedPullRequest.url})`);
    await openContextMenu();
    expect(offeredActions()).toContain(action);
    await act(async () => {
      state.allowed = false;
      choose(action);
    });
    expect(state.updateMetadata).not.toHaveBeenCalled();

    await setAllowed(true);
    state.choose.mockResolvedValue(action);
    await openContextMenu();
    await vi.waitFor(() =>
      expect(state.updateMetadata).toHaveBeenCalledExactlyOnceWith({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          linkedPullRequest: action === "link-to-thread" ? linkedPullRequest : null,
        },
      }),
    );
  },
);

it("uses a verified thread file for actions, preserves searchable labels, and restores a root file that appears", async () => {
  const candidate = "/other/checkout/docs/readme.md";
  const text = "[Readme](docs/readme.md:12:3) and `test/readme.md`";
  await createTestRoot()(
    <ChatMarkdown cwd="/work" threadRef={threadRef} text={text} />,
    createThreadFilePathIndex([candidate]),
  );
  const normalText = container.textContent;
  const indexedText = (
    searchableMessageSegments({ role: "assistant", text, streaming: false }, "/work") ?? []
  ).join(" ");
  expect(normalText).toContain("work/docs");
  expect(normalText).toContain("work/test");
  const expectPanel = async (path: string) => {
    state.openFile.mockClear();
    await act(async () => anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, path, 12);
    expect(container.textContent).toBe(normalText);
    for (const chip of container.querySelectorAll(".chat-markdown-file-link")) {
      expect(indexedText).toContain(chip.textContent);
    }
  };

  await expectPanel("docs/readme.md");
  await settleMetadata("/work/docs/readme.md", AsyncResult.success(null));
  await expectPanel("docs/readme.md");
  await settleMetadata(candidate, AsyncResult.success(null));
  await expectPanel("docs/readme.md");
  await settleMetadata(candidate, AsyncResult.failure(Cause.fail(new Error("Metadata failed"))));
  await expectPanel("docs/readme.md");
  await settleMetadata(candidate, AsyncResult.success({ kind: "directory" }));
  await expectPanel("docs/readme.md");
  await settleMetadata(candidate, AsyncResult.success({ kind: "other" }));
  await expectPanel("docs/readme.md");
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await expectPanel(candidate);

  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(state.copy).toHaveBeenLastCalledWith(`${candidate}:12:3`);
  state.choose.mockResolvedValue("open");
  await openContextMenu();
  expect(state.openEditor).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: `${candidate}:12:3`, editor: "vscode" },
  });
  state.choose.mockResolvedValue("reveal");
  await openContextMenu();
  expect(state.openEditor).toHaveBeenLastCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: candidate, editor: "file-manager", reveal: true },
  });
  expect(state.search).not.toHaveBeenCalled();

  await settleMetadata("/work/docs/readme.md", AsyncResult.success({ kind: "file" }));
  await expectPanel("docs/readme.md");
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(state.copy).toHaveBeenLastCalledWith("/work/docs/readme.md:12:3");
});

it("keeps an open file menu on its captured target while evidence and sibling selection change", async () => {
  const candidate = "/other/docs/guide.md";
  const sibling = "/other/test/sibling.md";
  const render = createTestRoot();
  const markdown = (
    <ChatMarkdown
      cwd="/work"
      threadRef={threadRef}
      text="[Guide](docs/guide.md) and [Sibling](test/sibling.md)"
    />
  );
  await render(markdown, createThreadFilePathIndex([candidate, sibling]));
  const openPendingMenu = async () => {
    let choose: (action: string) => void = () => {
      throw new Error("Menu not opened");
    };
    state.choose.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          choose = resolve;
        }),
    );
    await openContextMenu();
    return async (path: string | null) => {
      state.copy.mockClear();
      await act(async () => choose("copy-full"));
      if (path === null) expect(state.copy).not.toHaveBeenCalled();
      else expect(state.copy).toHaveBeenCalledExactlyOnceWith(path);
    };
  };

  const finishAfterEvidence = await openPendingMenu();
  await render(markdown, createThreadFilePathIndex([candidate, sibling, "/unrelated/new.ts"]));
  await finishAfterEvidence("/work/docs/guide.md");

  const finishAfterSibling = await openPendingMenu();
  await settleMetadata("/work/test/sibling.md", AsyncResult.success(null));
  await settleMetadata(sibling, AsyncResult.success({ kind: "file" }));
  await finishAfterSibling("/work/docs/guide.md");

  const finishAfterOwnSelection = await openPendingMenu();
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null));
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await finishAfterOwnSelection("/work/docs/guide.md");
  state.choose.mockResolvedValue("copy-full");
  await openContextMenu();
  expect(state.copy).toHaveBeenLastCalledWith(candidate);

  const finishAfterOwnerChange = await openPendingMenu();
  await render(
    <ChatMarkdown cwd="/new-root" threadRef={threadRef} text="[Guide](docs/guide.md)" />,
  );
  await finishAfterOwnerChange(null);
});

it("does not treat pending, failed, existing, or disabled root metadata as missing", async () => {
  const candidate = "/other/docs/guide.md";
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await createTestRoot()(
    <ChatMarkdown cwd="/work" threadRef={threadRef} text="`docs/guide.md`" />,
    createThreadFilePathIndex([candidate]),
  );
  const rootResults: Array<AsyncResult.AsyncResult<FilesystemEntryMetadata | null, Error>> = [
    AsyncResult.initial<FilesystemEntryMetadata | null, Error>(true),
    AsyncResult.waiting(AsyncResult.success(null)),
    AsyncResult.failure(Cause.fail(new Error("Disconnected or denied"))),
    AsyncResult.success({ kind: "file" }),
    AsyncResult.success({ kind: "directory" }),
    AsyncResult.success({ kind: "other" }),
  ];
  for (const rootResult of rootResults) {
    await settleMetadata("/work/docs/guide.md", rootResult);
    state.openFile.mockClear();
    await act(async () => anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "docs/guide.md", undefined);
  }
  await act(async () => {
    state.canRead = false;
    for (const listener of state.listeners) listener();
  });
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null));
  state.openFile.mockClear();
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "docs/guide.md", undefined);
  await act(async () => {
    state.canRead = true;
    for (const listener of state.listeners) listener();
  });
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(threadRef, candidate, undefined);
});

it("verifies a rootless candidate before opening its literal path and position", async () => {
  const candidate = "/outside/read%20 #?/docs/guide.ts";
  const render = createTestRoot();
  for (const text of [
    "[Read the file](docs/guide.ts:12:3)",
    "[docs/guide.ts:12:3](docs/guide.ts:12:3)",
    "`docs/guide.ts:12:3`",
    "[](docs/guide.ts:12:3)",
  ]) {
    await settleMetadata(candidate, AsyncResult.initial(true));
    state.openFile.mockClear();
    await render(
      <ChatMarkdown cwd={undefined} threadRef={threadRef} text={text} />,
      createThreadFilePathIndex([candidate]),
    );
    const indexedText = (
      searchableMessageSegments({ role: "assistant", text, streaming: false }) ?? []
    ).join(" ");
    expect(container.textContent).toBe(indexedText);
    await settleMetadata(candidate, AsyncResult.success(null));
    expect(container.textContent).toBe(indexedText);
    expect(state.openFile).not.toHaveBeenCalled();
    await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
    if (indexedText) {
      expect.soft(container.textContent).toBe(indexedText);
      expect.soft(anchor().textContent).toBe(indexedText);
    } else {
      expect.soft(anchor().textContent).toBe("guide.ts · L12:C3");
    }
    await act(async () => anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(threadRef, candidate, 12);
    state.choose.mockResolvedValue("copy-full");
    await openContextMenu();
    expect(state.copy).toHaveBeenLastCalledWith(`${candidate}:12:3`);
    if (!indexedText) {
      await expect.element(anchor()).toHaveAccessibleName("guide.ts · L12:C3");
    }
  }

  const rejectedCandidate = "/outside/scripts/deploy";
  await render(
    <ChatMarkdown cwd={undefined} threadRef={threadRef} text="`scripts/deploy`" />,
    createThreadFilePathIndex([rejectedCandidate]),
  );
  await settleMetadata(rejectedCandidate, AsyncResult.success({ kind: "file" }));
  expect(container.querySelector("a")).toBeNull();
  expect(container.querySelector("code")?.textContent).toBe("scripts/deploy");
});

it("discards verification from a previous thread, environment, root, or evidence scope", async () => {
  const candidate = "/other/docs/guide.md";
  const index = createThreadFilePathIndex([candidate]);
  const render = createTestRoot();
  await render(<ChatMarkdown cwd="/work" threadRef={threadRef} text="`docs/guide.md`" />, index);
  const incoming = {
    environmentId: EnvironmentId.make("incoming"),
    threadId: ThreadId.make("next"),
  };
  await render(
    <ChatMarkdown cwd="/work" threadRef={incoming} text="`docs/guide.md`" />,
    index,
    incoming,
  );
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null));
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(incoming, "docs/guide.md", undefined);
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null), incoming);
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }), incoming);
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(incoming, candidate, undefined);

  await render(
    <ChatMarkdown cwd="/new-root" threadRef={incoming} text="`docs/guide.md`" />,
    index,
    incoming,
  );
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(incoming, "docs/guide.md", undefined);
  await settleMetadata("/new-root/docs/guide.md", AsyncResult.success(null), incoming);
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(incoming, candidate, undefined);
  await render(
    <ChatMarkdown cwd="/new-root" threadRef={incoming} text="`docs/guide.md`" />,
    null,
    incoming,
  );
  await act(async () => anchor().click());
  expect(state.openFile).toHaveBeenLastCalledWith(incoming, "docs/guide.md", undefined);
});

it("keeps file-preview links document-relative even when its directory equals the thread root", async () => {
  const candidate = "/other/docs/guide.md";
  await settleMetadata(candidate, AsyncResult.success({ kind: "file" }));
  await settleMetadata("/work/docs/guide.md", AsyncResult.success(null));
  await settleMetadata("/work/nested/docs/guide.md", AsyncResult.success(null));
  const render = createTestRoot();
  for (const relativePath of ["README.md", "nested/README.md"]) {
    await render(
      <FileMarkdownPreview
        cwd="/work"
        relativePath={relativePath}
        text="[Guide](docs/guide.md)"
        threadRef={threadRef}
        workspaceMutationId={null}
      />,
      createThreadFilePathIndex([candidate]),
    );
    state.openFile.mockClear();
    await act(async () => anchor().click());
    expect(state.openFile).toHaveBeenCalledExactlyOnceWith(
      threadRef,
      relativePath === "README.md" ? "docs/guide.md" : "nested/docs/guide.md",
      undefined,
    );
  }
});
