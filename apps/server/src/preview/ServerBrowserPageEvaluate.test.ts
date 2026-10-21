import { PreviewAutomationEvaluateInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { CDPSession } from "playwright-core";
import { describe, expect, it, vi } from "vite-plus/test";

import { evaluate } from "./ServerBrowserPage.ts";

const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);

describe("server browser evaluation", () => {
  it.each([false, true, undefined])(
    "returns object contents for legacy returnByValue=%s",
    async (returnByValue) => {
      const value = { answer: 42, nested: { ready: true } };
      const send = vi.fn(async (_method: string, params: { returnByValue: boolean }) => ({
        result: params.returnByValue
          ? { type: "object", value }
          : { type: "object", description: "Object", objectId: "remote-object" },
      }));
      const cdp = { send } as unknown as CDPSession;
      const input = decodeEvaluateInput({
        expression: "({ answer: 42, nested: { ready: true } })",
        ...(returnByValue === undefined ? {} : { returnByValue }),
      });

      await expect(evaluate(cdp, input, 1_000)).resolves.toEqual(value);
      expect(send).toHaveBeenCalledWith("Runtime.evaluate", {
        expression: input.expression,
        awaitPromise: true,
        returnByValue: true,
      });
    },
  );
});
