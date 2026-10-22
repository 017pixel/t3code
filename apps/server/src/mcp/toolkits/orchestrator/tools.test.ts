import { expect, it } from "@effect/vitest";
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

// The server defaults bindToCurrentThread to true only for the caller's own project;
// elsewhere, or with no calling thread, each run launches a fresh thread.
it("states schedule_task's bindToCurrentThread default is conditional on the project", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.schedule_task) as {
    readonly properties: Readonly<
      Record<
        string,
        {
          readonly description?: string;
          readonly anyOf?: ReadonlyArray<{ readonly description?: string }>;
        }
      >
    >;
  };
  const property = schema.properties.bindToCurrentThread;
  const description = property?.description ?? property?.anyOf?.[0]?.description ?? "";
  expect(description).not.toMatch(/^True \(default\)/);
  expect(description).toMatch(/this thread's project/i);
  expect(description).toMatch(/elsewhere|other project|no calling thread/i);
});
