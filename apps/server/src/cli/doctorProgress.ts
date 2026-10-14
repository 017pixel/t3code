import type { DatabaseRepairStage } from "../persistence/DatabaseMaintenance.ts";
import { createUpdateProgress } from "./updateProgress.ts";

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
  "reclaiming-space": "Reclaiming disk space (this may take several minutes)",
  checkpointing: "Finishing database writes",
  "restarting-service": "Restarting background service",
};

/** The bar counts repair stages, not elapsed time or bytes processed. */
export function createDoctorProgress(output?: Parameters<typeof createUpdateProgress>[0]) {
  const progress = createUpdateProgress(output);
  const started = performance.now();
  return {
    finish: progress.finish,
    report(stage: DoctorStage) {
      const index = stages.indexOf(stage);
      const bar = "■".repeat(index) + "·".repeat(stages.length - index);
      progress.status(
        `[${bar}] ${labels[stage]} · ${((performance.now() - started) / 1000).toFixed(1)}s elapsed`,
      );
    },
    complete() {
      progress.success(`Repair complete in ${((performance.now() - started) / 1000).toFixed(1)}s`);
    },
  };
}
