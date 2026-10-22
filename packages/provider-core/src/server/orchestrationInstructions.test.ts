import { expect, it } from "@effect/vitest";

import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "./orchestrationInstructions.ts";

// schedule_task binds to the current thread by default only in that thread's project.
it("describes schedule_task's default thread binding as project-conditional", () => {
  const scheduleTask = T3_CODE_ORCHESTRATION_INSTRUCTIONS.split("\n").find((line) =>
    line.startsWith("- `schedule_task`"),
  );
  expect(scheduleTask).toBeDefined();
  expect(scheduleTask).not.toContain("By default runs return to the current thread");
  expect(scheduleTask).toMatch(/this thread's project/i);
  expect(scheduleTask).toMatch(/elsewhere|other project|no calling thread/i);
});
