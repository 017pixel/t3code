import { ProviderInstanceId } from "@t3tools/contracts";

import type { OrchestratorFixtureInput } from "../shared.ts";

// Hand-ported from Codex rust-v0.156.1; no live account was driven into Reserve.
// Ordinary frames use the recorded multi_turn fixture. Reserve responses follow
// tui/src/app/tests/luna_reserve_recovery_tests.rs and account_processor.rs.

export const LUNA_RESERVE_PROMPTS = [
  "Respond with exactly: ordinary quota turn complete",
  "Respond with exactly: exhausted quota turn complete",
  "Respond with exactly: luna reserve turn complete",
  "Respond with exactly: recovered quota turn complete",
] as const;

export const LUNA_RESERVE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-luna",
  options: [{ id: "reasoningEffort", value: "medium" }],
};

export function codexLunaReserveInput(): OrchestratorFixtureInput {
  return { steps: LUNA_RESERVE_PROMPTS.map((text) => ({ type: "message", text })) };
}
