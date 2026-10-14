import type { DatabaseStorageStatus } from "@t3tools/contracts";

/** Only suggest the offline conversion when it can reclaim at least 1 GiB. */
export function shouldRecommendDatabaseCompaction(status: DatabaseStorageStatus): boolean {
  return !status.incrementalVacuumEnabled && status.reclaimableBytes >= 1024 ** 3;
}
