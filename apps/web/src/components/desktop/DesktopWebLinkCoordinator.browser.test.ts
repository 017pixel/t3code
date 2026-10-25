import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as never[],
  navigate: vi.fn(async (): Promise<void> => undefined),
  openScratchProject: vi.fn(async () => null),
}));

// One connected primary environment that can read pull requests, with the app past the
// first-run gate. Its project list and discovery flag start empty so a test can deliver
// links before they arrive.
vi.mock(import("../onboarding/firstRunGateStore"), async (original) => ({
  ...(await original()),
  whileFirstRunAppOpen: (start: () => () => void) => start(),
}));
vi.mock(import("../../state/primaryEnvironment"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(EnvironmentId.make("local")),
  };
});
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
  createRouterScratchProject: (() => ({
    scratchEnvironmentId: () => "local",
    openScratchProject: state.openScratchProject,
  })) as never,
}));

import type { AppRouter } from "../../router";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { allReachableShellsLiveAtom } from "../../state/shell";
import { startDesktopWebLinks } from "./DesktopWebLinkCoordinator";

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
  appAtomRegistry.set(discoverySettled, false);
}

/** Starts the service behind a desktop bridge that hands over `urls` once the renderer is ready. */
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
  const router = { navigate: state.navigate, state: { matches: [] } } as unknown as AppRouter;
  // The app keeps discovery mounted; without a subscriber a write to it would not stick.
  stack.defer(appAtomRegistry.mount(discoverySettled));
  stack.defer(startDesktopWebLinks(router));
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
  appAtomRegistry.set(discoverySettled, true);
  await navigated;
  expect(state.navigate).toHaveBeenCalledExactlyOnceWith(pullRequestView);
  expect(state.openScratchProject).not.toHaveBeenCalled();
});
