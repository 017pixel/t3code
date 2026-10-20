import { RunId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { formatShortTimestamp } from "../../timestampFormat";
import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

describe("usageLimitRecoveryBannerItem", () => {
  const resetAt = new Date(2026, 9, 20, 17, 30).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 20, 12, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["locale", "12-hour", "24-hour"] as const)(
    "formats the reset time with the %s setting",
    (timestampFormat) => {
      const item = usageLimitRecoveryBannerItem({
        runId: RunId.make("run-1"),
        resetAt,
        stoppedAt: new Date(2026, 9, 20, 12, 0).toISOString(),
        snoozedUntil: null,
        recovery: null,
        timestampFormat,
        onChange: async () => {},
      });

      expect(item.description).toBe(`Resets ${formatShortTimestamp(resetAt, timestampFormat)}`);
    },
  );
});
