import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";

import { runServicePreflight } from "./servicePreflight.ts";

it.each([1, 2])("blocks legacy launcher protocol %i", (launcherProtocol) => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "blocked",
    version: "1.2.3",
    reason:
      "This release requires a newer T3 Code service launcher. Update it on the server machine.",
  });
});

it("accepts the deployed protocol 3 launcher without requiring a service reinstall", () => {
  expect(
    runServicePreflight({
      databasePath: "/missing/state.sqlite",
      launcherProtocol: 3,
      version: "1.2.3",
    }),
  ).toEqual({
    status: "ready",
    version: "1.2.3",
    launcherProtocol: 3,
    orchestrationProtocol: ORCHESTRATION_PROTOCOL_VERSION,
  });
});
