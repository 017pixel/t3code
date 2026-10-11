import type { ServerConfigStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createKeybindingsUpdateToastController,
  KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS,
} from "./KeybindingsUpdateToast.logic";

function keybindingsEvent(
  overrides: Partial<Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }>> = {},
): Extract<ServerConfigStreamEvent, { type: "keybindingsUpdated" }> {
  return {
    version: 1,
    type: "keybindingsUpdated",
    payload: {
      keybindings: [],
      issues: [],
    },
    ...overrides,
  };
}

describe("keybindings update toast policy", () => {
  it("coalesces repeated successful reload notifications during the cooldown", () => {
    let now = 1_000;
    const controller = createKeybindingsUpdateToastController({
      now: () => now,
    });

    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });

    now += KEYBINDINGS_SUCCESS_TOAST_COOLDOWN_MS - 1;
    expect(controller.handle(keybindingsEvent())).toBeNull();

    now += 1;
    expect(controller.handle(keybindingsEvent())).toEqual({ _tag: "Success" });
  });

  it("surfaces keybinding configuration issues", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle(
        keybindingsEvent({
          payload: {
            keybindings: [],
            issues: [
              {
                kind: "keybindings.malformed-config",
                message: "Expected JSON array",
              },
            ],
          },
        }),
      ),
    ).toEqual({
      _tag: "InvalidConfiguration",
      message: "Expected JSON array",
    });
  });

  it("reads keybinding reloads from config deltas", () => {
    const controller = createKeybindingsUpdateToastController({});
    const delta = (
      changes: Extract<ServerConfigStreamEvent, { type: "configDelta" }>["changes"],
    ): ServerConfigStreamEvent => ({
      version: 1,
      type: "configDelta",
      configVersion: "v2",
      changes,
      removed: [],
      providerChanges: [],
    });
    const malformed = {
      kind: "keybindings.malformed-config",
      message: "Expected JSON array",
    } as const;

    expect(controller.handle(delta({ keybindings: [] }))).toEqual({ _tag: "Success" });
    expect(controller.handle(delta({ issues: [malformed] }))).toEqual({
      _tag: "InvalidConfiguration",
      message: "Expected JSON array",
    });
    // Another issue changes while the file is still malformed.
    expect(
      controller.handle(
        delta({
          issues: [malformed, { kind: "keybindings.invalid-entry", message: "Unknown", index: 3 }],
        }),
      ),
    ).toBeNull();
    expect(controller.handle(delta({ cwd: "/repo" }))).toBeNull();
  });

  it("reports a fixed file whose bindings did not change", () => {
    const controller = createKeybindingsUpdateToastController({});
    const malformed = {
      kind: "keybindings.malformed-config",
      message: "Expected JSON array",
    } as const;
    const issues = (
      next: NonNullable<
        Extract<ServerConfigStreamEvent, { type: "configDelta" }>["changes"]["issues"]
      >,
    ): ServerConfigStreamEvent => ({
      version: 1,
      type: "configDelta",
      configVersion: "v2",
      changes: { issues: next },
      removed: [],
      providerChanges: [],
    });

    // The file was already malformed when the config arrived.
    expect(
      controller.handle({
        version: 1,
        type: "snapshot",
        config: { issues: [malformed] } as never,
      }),
    ).toBeNull();
    expect(controller.handle(issues([]))).toEqual({ _tag: "Success" });
    // An unrelated issue clearing later is not a keybindings update.
    expect(controller.handle(issues([]))).toBeNull();
  });

  it("ignores unrelated server config notifications", () => {
    const controller = createKeybindingsUpdateToastController({});

    expect(
      controller.handle({
        version: 1,
        type: "settingsUpdated",
        payload: { settings: {} as never },
      }),
    ).toBeNull();
  });
});
