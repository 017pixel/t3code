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
  progress.complete(1024 ** 3, 512 * 1024 ** 2);
  expect(output).toContain("Compacting history");
  expect(output).toContain("Reclaiming disk space");
  expect(output).toContain("s");
  expect(output).toContain("Repair complete");
  expect(output).toContain("Reclaimed  512.00 MiB");
  expect(output).not.toContain("");
});

it("emphasizes recommendations and results in a color terminal", () => {
  const previous = process.env.NO_COLOR;
  const previousTerm = process.env.TERM;
  process.env.TERM = "xterm-256color";
  delete process.env.NO_COLOR;
  let output = "";
  try {
    const progress = createDoctorProgress({
      isTTY: true,
      columns: 80,
      write(chunk: string | Uint8Array) {
        output += chunk;
        return true;
      },
    });
    progress.intro(1024 ** 3, 512 * 1024 ** 2);
    progress.complete(1024 ** 3, 512 * 1024 ** 2);
    expect(output).toContain("\x1b[1;96mT3 Doctor");
    expect(output).toContain("\x1b[1;32m512.00 MiB");
    expect(output).toContain("\x1b[1;32m✓ Repair complete");
  } finally {
    if (previousTerm === undefined) delete process.env.TERM;
    else process.env.TERM = previousTerm;
    if (previous === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previous;
  }
});
