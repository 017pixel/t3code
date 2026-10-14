import { expect, test } from "vitest";
import { shouldRecommendDatabaseCompaction } from "./databaseStorage.ts";

test("suggests offline conversion only for substantial free space on unconverted databases", () => {
  const status = {
    databaseBytes: 10 * 1024 ** 3,
    reclaimableBytes: 1024 ** 3,
    incrementalVacuumEnabled: false,
    compactCommand: "t3 database compact",
  };
  expect(shouldRecommendDatabaseCompaction(status)).toBe(true);
  expect(shouldRecommendDatabaseCompaction({ ...status, reclaimableBytes: 1024 ** 3 - 1 })).toBe(
    false,
  );
  expect(shouldRecommendDatabaseCompaction({ ...status, incrementalVacuumEnabled: true })).toBe(
    false,
  );
});
