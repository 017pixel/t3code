import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";

const state = vi.hoisted(() => ({
  environments: [] as Array<{
    environmentId: string;
    connection: { phase: string };
    serverConfig: { scratchWorkspaceRoot: string };
  }>,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: state.environments })) as never,
}));
vi.mock(import("../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("./useHandleNewThread"), async (original) => ({
  ...(await original()),
  useNewThreadHandler: (() => vi.fn()) as never,
}));

import { useScratchProject } from "./useScratchProject";

const LOCAL = EnvironmentId.make("local");
const REMOTE = EnvironmentId.make("remote");
const OTHER = EnvironmentId.make("other");

function environment(environmentId: EnvironmentId, phase: "connected" | "reconnecting") {
  return {
    environmentId,
    connection: { phase },
    serverConfig: { scratchWorkspaceRoot: `/scratch/${environmentId}` },
  };
}

function Probe({ current }: { current: EnvironmentId }) {
  return <output>{useScratchProject().scratchEnvironmentId(current) ?? "none"}</output>;
}

async function scratchTargetFrom(current: EnvironmentId) {
  await using screen = await render(<Probe current={current} />, { router: false });
  return screen.container.textContent;
}

it("falls back to the only connected machine when the remembered one is disconnected", async () => {
  state.environments = [environment(REMOTE, "reconnecting"), environment(LOCAL, "connected")];
  expect(await scratchTargetFrom(REMOTE)).toBe(LOCAL);
});

it("keeps the current machine while it can start a project-free thread", async () => {
  state.environments = [environment(REMOTE, "connected"), environment(LOCAL, "connected")];
  expect(await scratchTargetFrom(REMOTE)).toBe(REMOTE);
});

it("does not guess between several connected machines", async () => {
  state.environments = [
    environment(REMOTE, "reconnecting"),
    environment(LOCAL, "connected"),
    environment(OTHER, "connected"),
  ];
  expect(await scratchTargetFrom(REMOTE)).toBe("none");
});
