import type { DatabaseRepairStage } from "../persistence/DatabaseMaintenance.ts";

export type DoctorStage = DatabaseRepairStage | "stopping-service" | "restarting-service";
const stages: ReadonlyArray<DoctorStage> = [
  "stopping-service",
  "checking-database",
  "compacting-history",
  "verifying-history",
  "reclaiming-space",
  "checkpointing",
  "restarting-service",
];
const labels: Record<DoctorStage, string> = {
  "stopping-service": "Stopping background service",
  "checking-database": "Checking database",
  "compacting-history": "Compacting history",
  "verifying-history": "Verifying retained history",
  "reclaiming-space": "Reclaiming disk space",
  checkpointing: "Finishing database writes",
  "restarting-service": "Restarting background service",
};

export function formatDoctorBytes(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? "GiB" : "MiB";
  return `${(bytes / 1024 ** (unit === "GiB" ? 3 : 2)).toFixed(2)} ${unit}`;
}

export function doctorEmphasis(text: string) {
  return process.stderr.isTTY && process.env.TERM !== "dumb" && !process.env.NO_COLOR
    ? `\x1b[1m${text}\x1b[22m`
    : text;
}

/** The bar counts repair stages, not elapsed time or bytes processed. */
export function createDoctorProgress(
  output: Pick<NodeJS.WriteStream, "write" | "isTTY" | "columns"> = process.stderr,
) {
  const interactive = output.isTTY && process.env.TERM !== "dumb";
  const color = interactive && !process.env.NO_COLOR;
  const style = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const line = (text = "") => output.write(`${text}\n`);
  let lineOpen = false;
  let started = performance.now();
  const finish = () => {
    if (lineOpen) output.write("\r\x1b[2K");
    lineOpen = false;
  };
  return {
    finish,
    intro(databaseBytes: number, reclaimableBytes: number) {
      line();
      line(`  ${style("1;96", "T3 Doctor")}`);
      line(`  ${style("2", "Check and repair this environment")}`);
      line();
      line(`  Database          ${style("1", formatDoctorBytes(databaseBytes))}`);
      line(`  Space to reclaim  ${style("1;32", formatDoctorBytes(reclaimableBytes))}`);
      line();
    },
    repairs(
      repairs: ReadonlyArray<{
        title: string;
        description: string;
        recommended: boolean;
        details: ReadonlyArray<string>;
      }>,
    ) {
      line(`  ${style("1", "Available repairs")}`);
      line();
      for (const repair of repairs) {
        line(
          `  ${style("1", repair.title)}  ${style(repair.recommended ? "1;32" : "2", repair.recommended ? "Recommended" : "Optional")}`,
        );
        line(`  ${repair.description}`);
        for (const detail of repair.details) line(`  ${style("2", detail)}`);
        line();
      }
    },
    note(message: string) {
      line(`  ${message}`);
      line();
    },
    start() {
      started = performance.now();
      line(`  ${style("1", "Repairing")}`);
      line();
    },
    report(stage: DoctorStage) {
      finish();
      const index = stages.indexOf(stage);
      const bar = style("96", "━".repeat(index)) + style("2", "─".repeat(stages.length - index));
      const elapsed = `${((performance.now() - started) / 1000).toFixed(1)}s`;
      const text = `  ${bar}  ${style("1", labels[stage])}  ${style("2", elapsed)}`;
      output.write(interactive ? `\r${text}` : `${text}\n`);
      lineOpen = Boolean(interactive);
    },
    complete(beforeBytes: number, afterBytes: number) {
      finish();
      line(
        `  ${style("1;32", "✓ Repair complete")}  ${style("2", `${((performance.now() - started) / 1000).toFixed(1)}s`)}`,
      );
      line();
      line(
        `  Database   ${formatDoctorBytes(beforeBytes)} → ${style("1", formatDoctorBytes(afterBytes))}`,
      );
      line(
        `  Reclaimed  ${style("1;32", formatDoctorBytes(Math.max(0, beforeBytes - afterBytes)))}`,
      );
      line();
    },
  };
}
