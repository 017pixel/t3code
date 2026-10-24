import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as never[],
  navigate: vi.fn(async (): Promise<void> => undefined),
  openScratchProject: vi.fn(async () => null),
  scratchRoots: {} as Record<string, string>,
}));

// One connected primary environment that can read pull requests. Its project list and
// discovery flag start empty so a test can deliver links before they arrive.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useRouter: (() => ({ navigate: state.navigate, state: { matches: [] } })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "local" as EnvironmentId,
  usePrimaryEnvironment: (() => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: {},
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const capabilities = { pullRequests: true, threadPullRequests: true };
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(
      new Map([["local", { environment: { capabilities } }]]),
    ) as never,
  };
});
vi.mock(import("../../state/shell"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return { ...(await original()), allReachableShellsLiveAtom: Atom.make(false) };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: () => state.projects,
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  // Mirrors the real hook: the only machine with a scratch root takes project-free work.
  useScratchProject: (() => ({
    scratchWorkspaceRootFor: (id: string | null) => (id && state.scratchRoots[id]) || null,
    scratchEnvironmentId: () => Object.keys(state.scratchRoots)[0] ?? null,
    openScratchProject: state.openScratchProject,
  })) as never,
}));

import { toastManager } from "../ui/toast";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { allReachableShellsLiveAtom } from "../../state/shell";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const discoverySettled = allReachableShellsLiveAtom as Atom.Writable<boolean>;
const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");
const project = {
  id: projectId,
  environmentId,
  repositoryIdentity: {
    provider: "github",
    displayName: "Effect-TS/effect",
    canonicalKey: "github.com/effect-ts/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
} as never;
const pullRequestUrl = "https://github.com/Effect-TS/effect/pull/9339";
const pullRequestView = {
  to: "/pull-requests",
  search: {
    involvement: "all",
    state: "all",
    repository: "effect-ts/effect",
    number: 9339,
    selectedHost: "github.com",
    selectedProjectId: projectId,
    selectedEnvironmentId: environmentId,
  },
};

function setup() {
  vi.clearAllMocks();
  state.projects = [];
  state.scratchRoots = { local: "/scratch" };
  appAtomRegistry.set(discoverySettled, false);
}

/** Mounts the coordinator behind a desktop bridge that hands over `urls` once the renderer is ready. */
async function mount(...urls: string[]) {
  let deliver: ((url: string) => void) | undefined;
  await using stack = new AsyncDisposableStack();
  stack.use(
    stubGlobal("desktopBridge", {
      getClientSettings: async () => null,
      webLinks: {
        onOpen: (listener: (url: string) => void) => {
          deliver = listener;
          return () => undefined;
        },
        setReady: async (ready: boolean) => {
          if (ready) for (const url of urls.splice(0)) deliver?.(url);
        },
      },
    }),
  );
  stack.use(
    await render(
      <AppAtomRegistryProvider>
        <DesktopWebLinkCoordinator />
      </AppAtomRegistryProvider>,
    ),
  );
  return stack.move();
}

it("holds a launch PR link until project discovery settles, then opens the PR view", async () => {
  setup();
  await using _coordinator = await mount(pullRequestUrl);
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openScratchProject).not.toHaveBeenCalled();

  state.projects = [project];
  const navigated = new Promise<void>((resolve) => {
    state.navigate.mockImplementationOnce(async () => resolve());
  });
  await act(async () => {
    appAtomRegistry.set(discoverySettled, true);
    await navigated;
  });
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith(pullRequestView);
  expect(state.openScratchProject).not.toHaveBeenCalled();
});

describe("when only a remote machine can start a project-free thread", () => {
  const useRemoteScratch = () => {
    setup();
    state.scratchRoots = { remote: "/scratch" };
  };

  it("refuses a native file instead of opening it on the remote", async () => {
    useRemoteScratch();
    const toast = vi.spyOn(toastManager, "add");
    await using _coordinator = await mount("file:///tmp/page.html");
    await vi.waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not open the link" }),
      ),
    );
    expect(state.openScratchProject).not.toHaveBeenCalled();
  });

  it("still opens a web link there", async () => {
    useRemoteScratch();
    await using _coordinator = await mount("https://example.com/");
    await vi.waitFor(() =>
      expect(state.openScratchProject).toHaveBeenCalledWith("remote", "Could not open the link"),
    );
  });
});
