import { expect, it } from "@effect/vitest";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import { Tool } from "effect/ai";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

// Independent review rounds start a fresh child, but a follow-up that needs the same
// child's conversation goes to its childThreadId. Every surface must say both.
it("separates independent review rounds from same-conversation follow-ups", () => {
  const guidance = {
    instructions: T3_CODE_ORCHESTRATION_INSTRUCTIONS,
    delegate_task: OrchestratorToolkit.tools.delegate_task.description,
    t3_thread_send: OrchestratorToolkit.tools.t3_thread_send.description,
  };
  for (const [name, text] of Object.entries(guidance)) {
    expect.soft(text, name).toMatch(/independent review rounds?/i);
    expect.soft(text, name).toMatch(/follow-up that needs the same child's conversation/i);
  }
});
