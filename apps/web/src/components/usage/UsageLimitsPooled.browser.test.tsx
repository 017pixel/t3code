import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

// Real pointer clicks need the dialog's stacking styles to land above Base UI's modal overlay.
import "~/index.css";

const consume = vi.hoisted(() => vi.fn());
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { consumeResetCredit: null } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => consume }));
vi.mock("../../hooks/useSettings", () => ({ usePrimarySettings: () => "24h" }));
vi.mock("../settings/RedactedSensitiveText", () => ({ RedactedSensitiveText: () => null }));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const presentations: LimitPresentations = new Map([
  [
    EnvironmentId.make("env-a"),
    {
      entry: { target: { label: "Test" } },
      serverConfig: {
        usageLimitSources: [],
        providers: [
          {
            instanceId: ProviderInstanceId.make("alpha"),
            driver: ProviderDriverKind.make("codex"),
            displayName: "Alpha",
            enabled: true,
            installed: true,
            version: null,
            status: "ready",
            auth: { status: "authenticated", email: "alpha@example.com" },
            checkedAt: "2026-09-03T11:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            usageLimits: {
              checkedAt: "2026-09-03T11:00:00Z",
              resetCredits: { availableCount: 1 },
              windows: [
                {
                  id: "five_hour",
                  kind: "session",
                  label: "Session",
                  usedPercent: 40,
                  windowDurationMins: 300,
                  resetsAt: "2026-09-03T14:00:00Z",
                },
              ],
            },
          } satisfies ServerProvider,
        ],
      },
    },
  ],
]);

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  consume.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(() => root.render(<UsageLimitsPooled presentations={presentations} now={0} />));
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(label: string) {
  const button = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label")?.startsWith(label),
  );
  expect(button).toBeDefined();
  await act(() => userEvent.click(button!));
}

it("keeps the account badge identity when pooling fresher credits from another named instance", async () => {
  const environmentId = EnvironmentId.make("env-a");
  const presentation = presentations.get(environmentId)!;
  const alpha = presentation.serverConfig!.providers[0]!;
  const beta = {
    ...alpha,
    instanceId: ProviderInstanceId.make("beta"),
    displayName: "Beta",
    auth: { ...alpha.auth, email: "beta@example.com" },
    usageLimits: {
      ...alpha.usageLimits!,
      checkedAt: "2026-09-03T11:30:00Z",
      resetCredits: { availableCount: 2 },
    },
  } satisfies ServerProvider;
  async function renderProviders(providers: ServerProvider[]) {
    const input = new Map([
      [
        environmentId,
        { ...presentation, serverConfig: { ...presentation.serverConfig, providers } },
      ],
    ]);
    await act(() => root.render(<UsageLimitsPooled presentations={input} now={0} />));
  }
  function popupIdentity() {
    const popup = document.querySelector('[data-slot="popover-popup"]')!;
    const icon = popup.querySelector("[data-provider-accent-color]")!;
    const badge = icon.querySelector("span[aria-hidden]")!;
    return {
      name: icon.nextElementSibling?.textContent,
      initials: badge.textContent,
      color: getComputedStyle(badge).backgroundColor,
    };
  }

  await renderProviders([alpha, beta]);
  await click("Alpha:");
  const original = popupIdentity();
  expect(original).toMatchObject({ name: "Alpha", initials: "AL" });
  expect(original.color).not.toBe("rgba(0, 0, 0, 0)");
  await act(() => userEvent.keyboard("{Escape}"));
  await expect.poll(() => document.querySelector('[data-slot="popover-popup"]')).toBeNull();

  await renderProviders([alpha, { ...beta, auth: alpha.auth }]);
  expect(container.querySelectorAll('button[aria-label^="Beta:"]')).toHaveLength(0);
  const pooled = container.querySelector('button[aria-label^="Alpha:"]')!;
  expect(pooled.getAttribute("aria-label")).toContain("2 reset credits banked");
  await click("Alpha:");
  expect(popupIdentity()).toEqual(original);
});

it.each([
  {
    label: "success",
    result: { _tag: "Success", value: { outcome: "reset" } },
    text: "Reset applied. Your windows have cleared.",
  },
  {
    label: "failure",
    result: { _tag: "Failure", cause: { error: new Error("Codex rejected the credit.") } },
    text: "Codex rejected the credit.",
  },
])("keeps pending feedback outside the closed popup until $label", async ({ result, text }) => {
  let answer!: (result: unknown) => void;
  consume.mockReturnValue(new Promise((resolve) => (answer = resolve)));
  await click("Alpha:");
  await click("Use reset");
  expect(consume).not.toHaveBeenCalled();
  await click("Cancel");
  expect(consume).not.toHaveBeenCalled();
  await click("Alpha:");
  await click("Use reset");
  await click("Use credit");
  expect(consume).toHaveBeenCalledOnce();
  // Both popups unmount once their exit animations finish.
  await expect.poll(() => document.querySelector('[role="alertdialog"]')).toBeNull();
  await expect.poll(() => document.querySelector('[data-slot="popover-popup"]')).toBeNull();
  const status = document.querySelector('[role="status"]');
  expect(status?.textContent).toBe("Alpha Using reset credit…");
  await click("Alpha:");
  const using = Array.from(document.querySelectorAll("button")).find(
    (node) => node.textContent === "Using…",
  );
  expect(using?.disabled).toBe(true);
  await act(async () => answer(result));
  expect(status?.textContent).toBe(`Alpha ${text}`);
});
