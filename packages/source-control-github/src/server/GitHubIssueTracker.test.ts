import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubIssueTracker from "./GitHubIssueTracker.ts";

const DETAIL_RESPONSE = JSON.stringify({
  data: {
    viewer: { login: "julius" },
    repository: {
      viewerPermission: "TRIAGE",
      issue: {
        __typename: "Issue",
        number: 42,
        title: "Composer loses focus",
        url: "https://github.com/acme/web/issues/42",
        author: {
          __typename: "User",
          login: "octocat",
          avatarUrl: "https://avatars/octocat",
          name: "Octo Cat",
        },
        state: "CLOSED",
        stateReason: "NOT_PLANNED",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-03T00:00:00Z",
        closedAt: "2026-07-03T00:00:00Z",
        comments: {
          totalCount: 3,
          pageInfo: { hasPreviousPage: true, startCursor: "Y3Vyc29y" },
          nodes: [
            {
              __typename: "IssueComment",
              id: "IC_1",
              author: { __typename: "User", login: "julius", avatarUrl: "https://avatars/julius" },
              body: "Repro attached.",
              createdAt: "2026-07-02T00:00:00Z",
              url: "https://github.com/acme/web/issues/42#issuecomment-1",
              reactionGroups: [
                {
                  content: "THUMBS_UP",
                  viewerHasReacted: true,
                  reactors: {
                    totalCount: 2,
                    nodes: [
                      { __typename: "User", login: "julius" },
                      { __typename: "User", login: "theo" },
                    ],
                  },
                },
                {
                  content: "EYES",
                  viewerHasReacted: false,
                  reactors: { totalCount: 0, nodes: [] },
                },
              ],
            },
          ],
        },
        assignees: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{ login: "theo", name: null, avatarUrl: "https://avatars/julius" }],
        },
        labels: {
          pageInfo: { hasNextPage: true, endCursor: "labels-next" },
          nodes: [{ name: "bug", color: "d73a4a" }, null],
        },
        body: "Typing in the composer drops focus after a paste.",
        viewerCanUpdate: false,
        reactionGroups: [],
        closedByPullRequestsReferences: {
          nodes: [
            {
              number: 50,
              title: "fix(web): keep composer focus",
              url: "https://github.com/acme/web/pull/50",
              state: "MERGED",
              isDraft: false,
              repository: { nameWithOwner: "acme/web" },
            },
          ],
        },
        timelineItems: {
          nodes: [
            {
              __typename: "LabeledEvent",
              id: "LE_1",
              createdAt: "2026-07-01T01:00:00Z",
              actor: { __typename: "User", login: "theo", avatarUrl: "https://avatars/theo" },
              label: { name: "bug" },
            },
            {
              __typename: "CrossReferencedEvent",
              id: "CRE_1",
              createdAt: "2026-07-02T01:00:00Z",
              actor: { __typename: "User", login: "julius", avatarUrl: "https://avatars/julius" },
              source: {
                __typename: "PullRequest",
                number: 50,
                title: "fix(web): keep composer focus",
                url: "https://github.com/acme/web/pull/50",
                state: "MERGED",
                isDraft: false,
                repository: { nameWithOwner: "acme/web" },
              },
            },
            { __typename: "MentionedEvent", id: "ME_1", createdAt: "2026-07-02T02:00:00Z" },
            {
              __typename: "ClosedEvent",
              id: "CE_1",
              createdAt: "2026-07-03T00:00:00Z",
              actor: null,
            },
          ],
        },
      },
    },
  },
});

const decodeVariables = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      variables: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

function tracker(onRequest: (variables: unknown) => void, templateRepository?: unknown) {
  return GitHubIssueTracker.make.pipe(
    Effect.provide(
      GitHubRest.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            GitHubQuota.layer,
            SourceControlRateLimit.layer,
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) =>
                Effect.succeed({
                  host,
                  token: Redacted.make("test-token"),
                  source: "gh" as const,
                  fingerprint: "test",
                }),
            }),
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                if (request.body._tag !== "Uint8Array")
                  return Effect.die("Expected a GraphQL JSON request.");
                const { variables } = decodeVariables(new TextDecoder().decode(request.body.body));
                onRequest(variables);
                const body =
                  templateRepository !== undefined
                    ? JSON.stringify({ data: { repository: templateRepository } })
                    : "labelsCursor" in variables
                      ? JSON.stringify({
                          data: {
                            repository: {
                              issue: {
                                labels: {
                                  pageInfo: { hasNextPage: false, endCursor: null },
                                  nodes: [{ name: "needs repro", color: "ffffff" }],
                                },
                                assignees: {
                                  pageInfo: { hasNextPage: false, endCursor: null },
                                  nodes: [],
                                },
                              },
                            },
                          },
                        })
                      : DETAIL_RESPONSE;
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(body, {
                      headers: { "content-type": "application/json" },
                    }),
                  ),
                );
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

describe("GitHubIssueTracker", () => {
  it.effect("offers YAML issue forms when blank issues are disabled", () =>
    Effect.gen(function* () {
      const form = {
        __typename: "Blob",
        isTruncated: false,
        text: `name: Bug report
description: Report broken behavior.
title: "[Bug]: "
labels: [bug, needs-triage]
assignees: "octocat, theo"
body:
  - type: markdown
    attributes:
      value: Search existing issues first.
  - type: checkboxes
    attributes:
      label: Before submitting
      options:
        - label: I searched existing issues.
          required: true
  - type: dropdown
    attributes:
      label: Area
      description: Which part is affected?
      options: [Web, Server]
      default: 1
    validations:
      required: true
  - type: textarea
    attributes:
      label: Steps to reproduce
      placeholder: Start the app.
  - type: input
    attributes:
      label: Version
      value: main
  - type: upload
    attributes:
      label: Supporting files
      description: Redact secrets before uploading.
`,
      };
      const config = {
        __typename: "Blob",
        isTruncated: false,
        text: '"blank_issues_enabled": false # use a template',
      };
      const repository = {
        issueTemplates: [],
        templateDirectory: {
          __typename: "Tree",
          entries: [
            { name: "config.yml", object: config },
            { name: "bug_report.yml", object: form },
            {
              name: "invalid.yml",
              object: { ...form, text: "name: Missing required metadata\nbody: []" },
            },
          ],
        },
      };
      const api = yield* tracker(() => {}, repository);
      const input = { cwd: "/w", host: "github.com", scope: "acme/web" };
      const result = yield* api.listTemplates!(input);
      expect(result.blankIssuesEnabled).toBe(false);
      expect(result.templates).toHaveLength(1);
      expect(result.templates[0]).toMatchObject({
        key: "bug_report.yml",
        name: "Bug report",
        about: "Report broken behavior.",
        title: "[Bug]: ",
        labels: ["bug", "needs-triage"],
        assignees: ["octocat", "theo"],
      });
      expect(result.templates[0]?.body).toBe(`Search existing issues first.

### Before submitting

- [ ] I searched existing issues. (required)

### Area

Which part is affected?

Required.

Choose one:

- Web
- Server (default)

### Steps to reproduce

Example:
> Start the app.

### Version

main

### Supporting files

Redact secrets before uploading.`);
      config.isTruncated = true;
      expect(yield* Effect.flip(api.listTemplates!(input))).toMatchObject({
        reason: "failed",
        detail: "GitHub returned incomplete issue template contents.",
      });
    }),
  );

  it.effect("maps a detail read to the neutral issue shape", () =>
    Effect.gen(function* () {
      const seen: unknown[] = [];
      const api = yield* tracker((variables) => {
        seen.push(variables);
      });
      const issue = yield* api.getIssue({
        cwd: "/w",
        host: "github.com",
        scope: "acme/web",
        key: "42",
      });
      expect(seen).toEqual([
        { owner: "acme", name: "web", number: 42 },
        {
          owner: "acme",
          name: "web",
          number: 42,
          labelsCursor: "labels-next",
          assigneesCursor: null,
        },
      ]);
      expect(issue).toMatchObject({
        key: "42",
        displayKey: "#42",
        title: "Composer loses focus",
        body: "Typing in the composer drops focus after a paste.",
        state: { category: "closed", name: "closed", closeReason: "not-planned" },
        author: {
          login: "octocat",
          name: "Octo Cat",
          avatarUrl: "https://avatars/octocat",
        },
        assignees: [{ login: "theo" }],
        labels: [
          { name: "bug", color: "d73a4a" },
          { name: "needs repro", color: "ffffff" },
        ],
        commentCount: 3,
        viewer: "julius",
        // Triage may label and assign; `viewerCanUpdate: false` withholds state and edits.
        viewerPermissions: {
          setState: false,
          edit: false,
          labels: true,
          assignees: true,
          comment: true,
        },
        commentsCursor: "Y3Vyc29y",
      });
      // The viewer is left out of `actors` and shown as "You"; an empty group is dropped.
      expect(issue.comments[0]?.reactions).toEqual([
        { content: "thumbs-up", count: 2, actors: ["theo"], viewerHasReacted: true },
      ]);
      // The closing reference wins over the cross-reference sighting of the same pull request.
      expect(issue.linkedPullRequests).toEqual([
        {
          repository: "acme/web",
          number: 50,
          title: "fix(web): keep composer focus",
          url: "https://github.com/acme/web/pull/50",
          state: "merged",
          isDraft: false,
          closesIssue: true,
        },
      ]);
      // An event kind this page has no vocabulary for is dropped rather than guessed at.
      expect(issue.events.map((event) => [event.kind, event.detail])).toEqual([
        ["labeled", "bug"],
        ["referenced", "acme/web#50"],
        ["closed", null],
      ]);
    }),
  );
});
