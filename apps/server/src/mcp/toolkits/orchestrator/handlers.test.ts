import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Project,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";

import * as MeshForwarding from "../../../mesh/MeshForwarding.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as Handlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const decodeFailure = Schema.decodeUnknownEffect(OrchestratorMcpFailure);

const project = (id: string, title: string, repository: string): Project => ({
  id: ProjectId.make(id),
  title,
  workspaceRoot: `/projects/${id}`,
  repositoryIdentity: {
    canonicalKey: repository,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: `https://${repository}.git` },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
  deletedAt: null,
});

it.effect(
  "a remote thread list with no repository match names the machine's project IDs and titles",
  () =>
    Effect.gen(function* () {
      const local = project("project:mcp-test", "App", "github.com/t3/app");
      const remote = [
        project("box:one", "Other app", "github.com/t3/other"),
        project("box:two", "Tools", "github.com/t3/tools"),
      ];
      const machine = { environmentId: EnvironmentId.make("box"), label: "Build box" };
      const calls = yield* Ref.make<
        ReadonlyArray<{ readonly name: string; readonly args: Readonly<Record<string, unknown>> }>
      >([]);
      const dependencies = Layer.mergeAll(
        McpToolAccessTestkit.liveThreadsLayer,
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({}),
        Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => Effect.succeed(id === local.id ? Option.some(local) : Option.none()),
        }),
        Layer.mock(MeshForwarding.MeshForwarding)({
          resolveMachine: () => Effect.succeed({ _tag: "remote", machine }),
          callTool: (_machine, name, args) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (recorded) => [...recorded, { name, args }]);
              return name === "t3_project_list"
                ? { projects: remote, nextCursor: null }
                : { projectId: args.projectId, threads: [], nextCursor: null };
            }),
        }),
      );
      const toolkit = yield* OrchestratorToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(Layer.provide(dependencies)),
        ),
      );
      const scope: McpInvocationContext.McpInvocationScope = {
        environmentId: EnvironmentId.make("local"),
        requestNamespace: "provider-session:test",
        thread: {
          threadId: ThreadId.make("caller"),
          providerSessionId: "test",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration"]),
      };
      const call = (input: { readonly machine: string; readonly projectId?: ProjectId }) =>
        toolkit
          .handle("t3_thread_list", input)
          .pipe(
            Stream.unwrap,
            Stream.runCollect,
            Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
            Effect.provide(dependencies),
          );
      const response = yield* call({ machine: "box" });
      expect(response.at(-1)?.isFailure).toBe(true);
      const refused = yield* decodeFailure(response.at(-1)?.encodedResult);
      expect(refused.code).toBe("invalid_request");
      for (const part of [
        machine.label,
        "box:one",
        "Other app",
        "box:two",
        "Tools",
        "Pass projectId",
      ]) {
        expect(refused.message).toContain(part);
      }
      expect((yield* Ref.get(calls)).map((call) => call.name)).toEqual(["t3_project_list"]);
      yield* call({ machine: "box", projectId: remote[1]!.id });
      expect((yield* Ref.get(calls)).at(-1)).toEqual({
        name: "t3_thread_list",
        args: { projectId: remote[1]!.id },
      });
    }),
);
