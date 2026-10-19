import { describe, expect, it } from "vite-plus/test";
import {
  mcpServerDraftFrom,
  mcpServerFromDraft,
  mcpServerForTarget,
  mcpServerTransportForTarget,
  parseMcpServerJson,
} from "./toolsSettings.logic";

describe("MCP server editor", () => {
  it("saves a pasted command with quoted arguments and secret variables", () => {
    const args = ["--dir", "/work/My Projects", 'say "hi"', ""];
    const draft = parseMcpServerJson(
      JSON.stringify({
        mcpServers: {
          Docs: { command: "node", args, env: { API_TOKEN: "new-token" } },
        },
      }),
    );
    expect(draft).not.toBeNull();
    if (draft === null) throw new Error("Expected a server draft");
    expect(mcpServerFromDraft(draft, new Set())).toEqual({
      ok: true,
      name: "docs",
      transport: {
        type: "stdio",
        command: "node",
        args,
        env: [{ name: "API_TOKEN", value: "new-token", sensitive: true }],
      },
    });
    for (const name of ["command", "url", "serverUrl", "httpUrl"]) {
      for (const server of [
        { command: "npx", args: ["my-mcp"] },
        { command: ["npx", "my-mcp"] },
        ...["url", "serverUrl", "httpUrl"].map((key) => ({
          [key]: "https://example.com/mcp",
        })),
      ]) {
        const imported = parseMcpServerJson(JSON.stringify({ [name]: server }));
        expect(imported).not.toBeNull();
        if (!imported) throw new Error("Expected a named server draft");
        const transport =
          "command" in server
            ? { type: "stdio", command: "npx", args: ["my-mcp"], env: [] }
            : { type: "http", url: "https://example.com/mcp", headers: [] };
        expect(mcpServerFromDraft(imported, new Set())).toEqual({
          ok: true,
          name: name.toLowerCase(),
          transport,
        });
        const single = parseMcpServerJson(JSON.stringify(server));
        expect(single).not.toBeNull();
        if (!single) throw new Error("Expected a single server draft");
        expect(mcpServerFromDraft({ ...single, name: "single" }, new Set())).toEqual({
          ok: true,
          name: "single",
          transport,
        });
      }
    }
    for (const invalid of [
      null,
      [],
      { command: 42 },
      { command: {} },
      { command: [] },
      { command: ["npx", 42] },
      { url: false },
      { serverUrl: {} },
      { httpUrl: [] },
    ]) {
      expect(parseMcpServerJson(JSON.stringify({ invalid }))).toBeNull();
      const imported = parseMcpServerJson(
        JSON.stringify({ invalid, valid: { command: "npx", args: ["my-mcp"] } }),
      );
      expect(imported).toMatchObject({ name: "valid", command: "npx", args: "my-mcp" });
    }
    expect(mcpServerFromDraft(draft, new Set(["docs"]))).toMatchObject({
      ok: false,
      field: "name",
    });
    expect(
      mcpServerFromDraft(
        {
          ...draft,
          env: [...draft.env, { ...draft.env[0]!, id: "duplicate", name: " API_TOKEN " }],
        },
        new Set(),
      ),
    ).toMatchObject({
      ok: false,
      field: "variables",
      message: "Duplicate environment variable name: API_TOKEN.",
    });
    for (const transport of [
      {
        type: "stdio" as const,
        command: "node",
        args: [],
        env: [
          { name: "API_TOKEN", value: "", sensitive: true, valueRedacted: true },
          { name: "REGION", value: "east", sensitive: false },
        ],
      },
      {
        type: "http" as const,
        url: "https://example.com/mcp",
        headers: [
          { name: "Authorization", value: "", sensitive: true, valueRedacted: true },
          { name: "X-Region", value: "east", sensitive: false },
        ],
      },
    ]) {
      const draft = mcpServerDraftFrom("docs", { enabled: true, transport });
      const key = draft.type === "stdio" ? "env" : "headers";
      for (const variable of draft[key]) {
        expect(
          mcpServerFromDraft({ ...draft, [key]: [{ ...variable, name: "  " }] }, new Set(), "docs"),
        ).toEqual({
          ok: false,
          field: "variables",
          message: "Enter a variable name or remove the row.",
        });
      }
      const empty = { id: "unused", name: "  ", value: "", sensitive: true, stored: false };
      expect(
        mcpServerFromDraft(
          {
            ...draft,
            [key]: [
              ...draft[key],
              empty,
              { ...empty, id: "plain", sensitive: false, storedName: draft[key][0]!.name },
            ],
            [draft.type === "stdio" ? "headers" : "env"]: [
              { ...empty, value: "inactive-transport-value", stored: true },
            ],
          },
          new Set(),
          "docs",
        ),
      ).toEqual({ ok: true, name: "docs", transport });
    }
  });

  it("preserves an untouched secret and its original identity through an editor rename", () => {
    const server = {
      enabled: true,
      transport: {
        type: "http" as const,
        url: "https://example.com/mcp",
        headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
      },
    };
    const draft = mcpServerDraftFrom("docs", server);
    const unchanged = mcpServerFromDraft(draft, new Set(), "docs");
    expect(unchanged).toEqual({
      ok: true,
      name: "docs",
      transport: server.transport,
    });
    if (!unchanged.ok) throw new Error("Expected an unchanged server");
    expect(
      mcpServerTransportForTarget(unchanged.transport, server.transport, server.transport),
    ).toEqual(server.transport);
    const renamed = {
      ...draft,
      name: "docs-work",
      headers: draft.headers.map((header) => ({ ...header, name: "X-Api-Key" })),
    };
    const moved = mcpServerFromDraft(renamed, new Set(), "docs");
    expect(moved).toEqual({
      ok: true,
      name: "docs-work",
      transport: {
        ...server.transport,
        headers: [
          {
            name: "X-Api-Key",
            value: "",
            sensitive: true,
            valueRedacted: true,
            storedAs: { server: "docs", variable: "Authorization" },
          },
        ],
      },
    });
    if (!moved.ok) throw new Error("Expected a valid secret rename");
    expect(
      mcpServerTransportForTarget(moved.transport, server.transport, server.transport, "docs"),
    ).toEqual(moved.transport);
    expect(
      mcpServerFromDraft(
        {
          ...draft,
          headers: [
            ...draft.headers,
            { ...draft.headers[0]!, id: "duplicate", name: " authorization " },
          ],
        },
        new Set(),
        "docs",
      ),
    ).toMatchObject({
      ok: false,
      field: "variables",
      message: "Duplicate header name: authorization.",
    });
    const replaced = {
      ...renamed,
      headers: renamed.headers.map((header) => ({
        ...header,
        value: "replacement-token",
        stored: false,
      })),
    };
    const result = mcpServerFromDraft(replaced, new Set(), "docs");
    expect(result.ok && result.transport.type === "http" && result.transport.headers).toEqual([
      { name: "X-Api-Key", value: "replacement-token", sensitive: true },
    ]);
    const cleared = mcpServerFromDraft(
      {
        ...draft,
        headers: [
          { id: "replacement", name: "Authorization", value: "", sensitive: true, stored: false },
        ],
      },
      new Set(),
      "docs",
    );
    if (!cleared.ok) throw new Error("Expected a valid empty replacement");
    const emptyTransport = {
      ...server.transport,
      headers: [{ name: "Authorization", value: "", sensitive: true }],
    };
    expect(cleared.transport).toEqual(emptyTransport);
    for (const renamedFrom of [undefined, "docs"]) {
      expect(
        mcpServerTransportForTarget(
          cleared.transport,
          server.transport,
          server.transport,
          renamedFrom,
        ),
      ).toEqual(emptyTransport);
    }
  });
});

it("preserves different destination headers in a URL-only bulk edit", () => {
  const initial = {
    type: "http" as const,
    url: "https://example.com/mcp",
    headers: [{ name: "Authorization", value: "", sensitive: true, valueRedacted: true }],
  };
  const local = {
    ...initial,
    headers: [{ name: "X-Api-Key", value: "", sensitive: true, valueRedacted: true }],
  };
  const edited = { ...initial, url: "https://changed.example/mcp" };
  expect(mcpServerTransportForTarget(edited, initial, initial)).toEqual(edited);
  expect(mcpServerTransportForTarget(edited, initial, local)).toEqual({
    ...local,
    url: edited.url,
  });
  expect(mcpServerTransportForTarget(edited, initial, local, "docs")).toEqual({
    ...local,
    url: edited.url,
    headers: [{ ...local.headers[0], storedAs: { server: "docs", variable: "X-Api-Key" } }],
  });

  for (const enabled of [true, false]) {
    const destination = { enabled, transport: local };
    for (const renamedFrom of [undefined, "docs"]) {
      expect(
        mcpServerForTarget(
          { enabled: !enabled, transport: edited },
          initial,
          destination,
          renamedFrom,
        ).enabled,
      ).toBe(enabled);
    }
  }
  expect(
    mcpServerForTarget({ enabled: false, transport: edited }, undefined, undefined).enabled,
  ).toBe(false);
  expect(
    mcpServerForTarget({ enabled: true, transport: edited }, undefined, undefined).enabled,
  ).toBe(true);

  const imported = parseMcpServerJson(JSON.stringify({ docs: { url: "https://new.example/mcp" } }));
  if (!imported) throw new Error("Expected an added server draft");
  const added = mcpServerFromDraft(imported, new Set());
  if (!added.ok) throw new Error("Expected a valid added server");
  const addedConfig = { enabled: true, transport: added.transport };
  const remainingB = { docs: { enabled: false, transport: initial } };
  const beforeB = structuredClone(remainingB);
  // Retry maps the remaining destination against its latest snapshot.
  for (const previousName of [undefined, "old-docs"]) {
    const source = { enabled: false, transport: local };
    const beforeCollision = previousName ? { [previousName]: source } : {};
    const identity = { name: added.name, ...(previousName ? { previousName } : {}) };
    const initialTransport = previousName ? local : undefined;
    const mapped = mcpServerForTarget(
      addedConfig,
      initialTransport,
      previousName ? source : undefined,
      previousName,
      { ...identity, servers: beforeCollision },
    );
    expect(mapped).toEqual({
      ...addedConfig,
      enabled: previousName ? source.enabled : true,
    });
    const afterCollision = { ...beforeCollision, ...remainingB };
    expect(() =>
      mcpServerForTarget(
        addedConfig,
        initialTransport,
        previousName ? source : afterCollision.docs,
        previousName,
        { ...identity, servers: afterCollision },
      ),
    ).toThrow("A server with this name already exists.");
    expect(afterCollision.docs).toEqual(beforeB.docs);
  }
  expect(remainingB).toEqual(beforeB);
  expect(
    mcpServerForTarget({ enabled: true, transport: edited }, initial, remainingB.docs, undefined, {
      name: "docs",
      previousName: "docs",
      servers: remainingB,
    }),
  ).toEqual({ enabled: false, transport: edited });
  expect(
    mcpServerForTarget(addedConfig, undefined, { enabled: false }, undefined, {
      name: "docs",
      servers: { docs: { enabled: false } },
    }),
  ).toEqual(addedConfig);

  const sameHeader = {
    ...initial,
    headers: [{ name: "Authorization", value: "local-token", sensitive: false }],
  };
  expect(mcpServerTransportForTarget(edited, initial, sameHeader)).toEqual({
    ...sameHeader,
    url: edited.url,
  });

  expect(() =>
    mcpServerTransportForTarget(edited, initial, {
      type: "stdio",
      command: "native-tool",
      args: [],
      env: [{ name: "API_KEY", value: "", sensitive: true, valueRedacted: true }],
    }),
  ).toThrow("each environment");

  const replaced = {
    ...edited,
    headers: [{ name: "Authorization", value: "replacement", sensitive: true }],
  };
  expect(() => mcpServerTransportForTarget(replaced, initial, local)).toThrow("each environment");
  expect(mcpServerTransportForTarget(replaced, initial, initial)).toEqual(replaced);
  expect(mcpServerTransportForTarget({ ...edited, headers: [] }, initial, initial)).toEqual({
    ...edited,
    headers: [],
  });
  const renamed = {
    ...edited,
    headers: [
      {
        ...initial.headers[0]!,
        name: "New-Authorization",
        storedAs: { server: "docs", variable: "Authorization" },
      },
    ],
  };
  expect(mcpServerTransportForTarget(renamed, initial, initial)).toEqual(renamed);
  const mixedInitial = {
    ...initial,
    headers: [
      { name: "Authorization", value: "public-value", sensitive: false },
      { name: "X-Region", value: "east", sensitive: false },
    ],
  };
  const mixedTarget = {
    ...initial,
    headers: [
      { name: "Authorization", value: "", sensitive: true, valueRedacted: true },
      { name: "X-Region", value: "west", sensitive: false },
    ],
  };
  const mixedEdit = {
    ...mixedInitial,
    headers: [mixedInitial.headers[0]!, { ...mixedInitial.headers[1]!, value: "north" }],
  };
  expect(mcpServerTransportForTarget(mixedEdit, mixedInitial, mixedTarget, "docs")).toEqual({
    ...mixedEdit,
    headers: [
      {
        name: "Authorization",
        value: "",
        sensitive: true,
        valueRedacted: true,
        storedAs: { server: "docs", variable: "Authorization" },
      },
      { name: "X-Region", value: "north", sensitive: false },
    ],
  });
  const plainDraft = mcpServerDraftFrom("docs", { enabled: true, transport: mixedInitial });
  const plainRename = mcpServerFromDraft(
    {
      ...plainDraft,
      headers: plainDraft.headers.map((variable, index) =>
        index === 0 ? { ...variable, name: "X-Account" } : variable,
      ),
    },
    new Set(),
    "docs",
  );
  if (!plainRename.ok) throw new Error("Expected a valid plain variable rename");
  expect(
    mcpServerForTarget({ enabled: true, transport: plainRename.transport }, mixedInitial, {
      enabled: false,
      transport: mixedInitial,
    }).transport,
  ).toEqual(plainRename.transport);
  const differentPlainTarget = {
    ...mixedInitial,
    headers: mixedInitial.headers.map((variable, index) =>
      index === 0 ? { ...variable, value: "destination-value" } : variable,
    ),
  };
  expect(() =>
    mcpServerForTarget({ enabled: true, transport: plainRename.transport }, mixedInitial, {
      enabled: false,
      transport: differentPlainTarget,
    }),
  ).toThrow("each environment");
  expect(() =>
    mcpServerForTarget({ enabled: true, transport: plainRename.transport }, mixedInitial, {
      enabled: false,
      transport: mixedTarget,
    }),
  ).toThrow("each environment");

  const blankInitial = {
    ...initial,
    headers: [{ name: "Authorization", value: "", sensitive: true }],
  };
  const blankDraft = mcpServerDraftFrom("docs", { enabled: true, transport: blankInitial });
  const blankRename = mcpServerFromDraft(
    {
      ...blankDraft,
      headers: blankDraft.headers.map((variable) => ({ ...variable, name: "X-Auth" })),
    },
    new Set(),
    "docs",
  );
  if (!blankRename.ok) throw new Error("Expected a valid empty variable rename");
  for (const renamedFrom of [undefined, "docs"]) {
    expect(
      mcpServerTransportForTarget(blankRename.transport, blankInitial, blankInitial, renamedFrom),
    ).toEqual(blankRename.transport);
    expect(() =>
      mcpServerTransportForTarget(blankRename.transport, blankInitial, initial, renamedFrom),
    ).toThrow("each environment");
  }
});
