import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => {
  const state = {
    calls: [] as Array<unknown>,
    respond: (): unknown => undefined,
    refresh: async (input: unknown) => {
      state.calls.push(input);
      return state.respond();
    },
  };
  return state;
});

vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: "refresh" } }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => harness.refresh,
}));

import { useProjectModelsRefresh } from "./use-project-models-refresh";

type Props = Parameters<typeof useProjectModelsRefresh>[0];

function Consumer(props: Props) {
  useProjectModelsRefresh(props);
  return null;
}

const project = {
  environmentId: "environment-1",
  cwd: "/repo",
  instanceId: "opencode",
} as unknown as Omit<Props, "connected">;

let root: Root | null = null;

async function render(props: Props) {
  await act(async () => {
    root!.render(<Consumer {...props} />);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.calls = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
});

describe("useProjectModelsRefresh", () => {
  it("asks again after a failed request once the environment reconnects", async () => {
    harness.respond = () => AsyncResult.failure(Cause.fail(new Error("socket closed")));
    await render({ ...project, connected: true });
    await render({ ...project, connected: false });
    expect(harness.calls).toHaveLength(1);

    harness.respond = () => AsyncResult.success([]);
    await render({ ...project, connected: true });
    expect(harness.calls).toHaveLength(2);

    await render({ ...project, connected: false });
    await render({ ...project, connected: true });
    expect(harness.calls).toHaveLength(2);
  });
});
