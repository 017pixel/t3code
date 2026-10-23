import {
  applyTerminalAttachStreamEvent,
  DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
  EMPTY_TERMINAL_BUFFER_STATE,
  nextTerminalAttachSeedState,
  terminalOutputText,
} from "@t3tools/client-runtime/state/terminal";
import { expect, it, vi } from "vite-plus/test";

import { createTerminalOutputWriter } from "./terminalOutputWriter";

function append(
  state: typeof EMPTY_TERMINAL_BUFFER_STATE,
  data: string,
  limit = DEFAULT_MAX_TERMINAL_BUFFER_BYTES,
) {
  return applyTerminalAttachStreamEvent(
    state,
    { type: "output", data, threadId: "thread", terminalId: "term-1" },
    limit,
  );
}

it("appends 2 MiB across retention rollover without replaying history or resetting the emulator", async () => {
  const write = vi.fn(async (_data: string, _reset: boolean) => {});
  const writer = createTerminalOutputWriter(write);
  let state = EMPTY_TERMINAL_BUFFER_STATE;
  await writer.write(state.output);
  for (let index = 0; index < 128; index += 1) {
    const chunk = `${index}\r\n`.padEnd(16 * 1024, "x");
    state = append(state, chunk);
    await writer.write(state.output);
    expect(write).toHaveBeenLastCalledWith(chunk, false);
  }
  expect(state.output.retainedBytes).toBe(DEFAULT_MAX_TERMINAL_BUFFER_BYTES);
  expect(write.mock.calls.filter(([, reset]) => reset)).toEqual([["", true]]);
  expect(write.mock.calls.reduce((total, [data]) => total + data.length, 0)).toBe(2 * 1024 * 1024);
});

it("starts with exactly the retained output and replays it on a fresh mount", async () => {
  const state = append(EMPTY_TERMINAL_BUFFER_STATE, "discarded\r\n🌍retained", 12);
  const write = vi.fn(async () => {});
  await createTerminalOutputWriter(write).write(state.output);
  await createTerminalOutputWriter(write).write(state.output);
  expect(write.mock.calls).toEqual([
    [terminalOutputText(state.output), true],
    [terminalOutputText(state.output), true],
  ]);
});

it("serializes writes and coalesces pending snapshots without dropping unread chunks", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  const writer = createTerminalOutputWriter(write);
  const first = append(EMPTY_TERMINAL_BUFFER_STATE, "first");
  const draining = writer.write(first.output);
  await started.promise;
  const second = append(first, "second");
  void writer.write(second.output);
  const third = append(second, "third");
  void writer.write(third.output);
  expect(write).toHaveBeenCalledTimes(1);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["first", true],
    ["secondthird", false],
  ]);
  await writer.write(third.output);
  expect(write).toHaveBeenCalledTimes(2);
  await writer.write(append(third, "fourth").output);
  expect(write).toHaveBeenLastCalledWith("fourth", false);
});

it("resets to retained history if a slow native write misses already dropped chunks", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
  });
  const writer = createTerminalOutputWriter(write);
  const draining = writer.write(append(EMPTY_TERMINAL_BUFFER_STATE, "old", 4).output);
  await started.promise;
  const state = append(append(EMPTY_TERMINAL_BUFFER_STATE, "old", 4), "missed-new", 4);
  void writer.write(state.output);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["old", true],
    ["-new", true],
  ]);
});

it("resets on clear and attach generation changes even when the new text has the old prefix", async () => {
  const write = vi.fn(async () => {});
  const writer = createTerminalOutputWriter(write);
  let state = append(EMPTY_TERMINAL_BUFFER_STATE, "same");
  await writer.write(state.output);
  state = applyTerminalAttachStreamEvent(state, {
    type: "cleared",
    threadId: "thread",
    terminalId: "term-1",
  });
  await writer.write(state.output);
  state = append(state, "same");
  await writer.write(state.output);
  await writer.write(append(nextTerminalAttachSeedState(), "same-new session").output);
  expect(write.mock.calls).toEqual([
    ["same", true],
    ["", true],
    ["same", false],
    ["same-new session", true],
  ]);
});

it.each(["snapshot", "restarted"] as const)(
  "resets for a %s with restarted sequence numbers and a matching text prefix",
  async (type) => {
    const write = vi.fn(async () => {});
    const writer = createTerminalOutputWriter(write);
    let state = append(EMPTY_TERMINAL_BUFFER_STATE, "same");
    await writer.write(state.output);
    state = applyTerminalAttachStreamEvent(state, {
      type,
      threadId: "thread",
      terminalId: "term-1",
      snapshot: {
        threadId: "thread",
        terminalId: "term-1",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 1,
        history: "same-new session",
        sequence: 1,
        exitCode: null,
        exitSignal: null,
        label: "Terminal",
        updatedAt: "2026-10-22T00:00:00Z",
      },
    });
    await writer.write(state.output);
    expect(write.mock.calls).toEqual([
      ["same", true],
      ["same-new session", true],
    ]);
  },
);

it("stops queued writes when the native view unmounts or its target changes", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {
    started.resolve();
    await release.promise;
  });
  const writer = createTerminalOutputWriter(write);
  const draining = writer.write(append(EMPTY_TERMINAL_BUFFER_STATE, "old target").output);
  await started.promise;
  void writer.write(append(EMPTY_TERMINAL_BUFFER_STATE, "queued").output);
  writer.dispose();
  release.resolve();
  await draining;
  await writer.write(append(EMPTY_TERMINAL_BUFFER_STATE, "after disposal").output);
  expect(write).toHaveBeenCalledTimes(1);
});

it("recovers a rejected write from retained history without another write", async () => {
  const write = vi.fn(async () => {});
  write.mockRejectedValueOnce(new Error("native failure"));
  const writer = createTerminalOutputWriter(write);
  const state = append(EMPTY_TERMINAL_BUFFER_STATE, "retained");
  await writer.write(state.output);
  expect(write.mock.calls).toEqual([
    ["retained", true],
    ["retained", true],
  ]);
  await writer.write(append(state, "-new").output);
  expect(write).toHaveBeenLastCalledWith("-new", false);
});

it("recovers the newer snapshot queued during a rejected append without a third write", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  const writer = createTerminalOutputWriter(write);
  const initial = append(EMPTY_TERMINAL_BUFFER_STATE, "initial");
  await writer.write(initial.output);
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("partially applied append");
  });
  const first = append(initial, "-first");
  const draining = writer.write(first.output);
  await started.promise;
  const latest = append(first, "-latest");
  expect(writer.write(latest.output)).toBe(draining);
  release.resolve();
  await draining;
  expect(write.mock.calls).toEqual([
    ["initial", true],
    ["-first", false],
    ["initial-first-latest", true],
  ]);
  await writer.write(append(latest, "-next").output);
  expect(write).toHaveBeenLastCalledWith("-next", false);
});

it("bounds persistent rejection to one reset recovery and allows a later write to recover", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {});
  write.mockRejectedValue(new Error("persistent native failure"));
  write.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    throw new Error("first native failure");
  });
  const writer = createTerminalOutputWriter(write);
  const first = append(EMPTY_TERMINAL_BUFFER_STATE, "first");
  const draining = writer.write(first.output);
  await started.promise;
  const latest = append(first, "-latest");
  expect(writer.write(latest.output)).toBe(draining);
  const rejected = expect(draining).rejects.toThrow("persistent native failure");
  release.resolve();
  await rejected;
  expect(write.mock.calls).toEqual([
    ["first", true],
    ["first-latest", true],
  ]);
  write.mockResolvedValue(undefined);
  await writer.write(latest.output);
  expect(write).toHaveBeenLastCalledWith("first-latest", true);
  await writer.write(append(latest, "-next").output);
  expect(write).toHaveBeenLastCalledWith("-next", false);
});

it("cancels recovery when disposed during a rejected native write", async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const write = vi.fn(async () => {
    started.resolve();
    await release.promise;
    throw new Error("disposed native view");
  });
  const writer = createTerminalOutputWriter(write);
  const first = append(EMPTY_TERMINAL_BUFFER_STATE, "first");
  const draining = writer.write(first.output);
  await started.promise;
  void writer.write(append(first, "-latest").output);
  writer.dispose();
  release.resolve();
  await draining;
  await writer.write(first.output);
  expect(write).toHaveBeenCalledTimes(1);
});
