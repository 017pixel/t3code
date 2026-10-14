import { expect, it } from "vite-plus/test";
import { createDoctorProgress } from "./doctorProgress.ts";

it("reports stages and elapsed time as readable lines when redirected", () => {
  let output = "";
  const progress = createDoctorProgress({
    isTTY: false,
    columns: 80,
    write(chunk: string | Uint8Array) {
      output += chunk;
      return true;
    },
  });
  progress.report("compacting-history");
  progress.report("reclaiming-space");
  progress.complete();
  expect(output).toContain("Compacting history");
  expect(output).toContain("Reclaiming disk space (this may take several minutes)");
  expect(output).toContain("elapsed");
  expect(output).toContain("Repair complete");
  expect(output).not.toContain("");
});
