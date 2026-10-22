// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalFetch:off globalConsole:off globalConsoleInEffect:off preferSchemaOverJson:off - Host-side evidence driver retains raw wire evidence and owns its stub forge.
/**
 * Runtime evidence for PR #22987: `pullRequests.detail` degrades to the check rollup when a GitHub
 * credential cannot read check contexts.
 *
 * Every forge answer is STUBBED. An HTTPS server on [::1] plays a GitHub Enterprise host
 * (`github.localtest.me`, which resolves to ::1), and each pull request number selects one fixture
 * row from `fixtures.json`. The real server (`apps/server/src/bin.ts start`) runs against an
 * isolated home under `--out`, never `~/.t3/userdata`, and the driver calls
 * `pullRequests.detail` over the authenticated WebSocket RPC for each row.
 *
 * Run from the repository root (one command, all rows):
 *
 *   node apps/server/scripts/evidence/pr-22987/driver.ts --label after --out /tmp/ev-22987/after
 *
 * One row: add `--rows F2`. Rewrite fixtures.json from the builders below: `--emit-fixtures`.
 * Writes `<out>/requests.jsonl` (every stub request), `<out>/results.json` (what the client
 * received per row) and `<out>/server.log`.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { Socket } from "effect/socket";
import { RpcClient, RpcSerialization } from "effect/rpc";
import {
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  ProjectId,
  WsRpcGroup,
} from "@t3tools/contracts";

const { values } = NodeUtil.parseArgs({
  options: {
    label: { type: "string", default: "run" },
    out: { type: "string" },
    rows: { type: "string" },
    "stub-port": { type: "string", default: "443" },
    "in-namespace": { type: "boolean", default: false },
    "emit-fixtures": { type: "boolean", default: false },
  },
});

const here = import.meta.dirname;
const root = NodePath.resolve(here, "../../../../..");
const HOST = "github.localtest.me";
const PAT = "Resource not accessible by personal access token";
const INTEGRATION = "Resource not accessible by integration";
const contextsPath = [
  "repository",
  "pullRequest",
  "commits",
  "nodes",
  0,
  "commit",
  "statusCheckRollup",
  "contexts",
];
const reviewerPath = [
  "repository",
  "pullRequest",
  "reviewRequests",
  "nodes",
  0,
  "requestedReviewer",
];

const checkRun = (name: string, conclusion: string, workflow = "ci") => ({
  __typename: "CheckRun",
  name,
  status: "COMPLETED",
  conclusion,
  startedAt: "2026-10-01T00:00:00Z",
  completedAt: "2026-10-01T00:05:00Z",
  detailsUrl: `https://${HOST}/acme/web/actions/runs/1`,
  checkSuite: { workflowRun: { workflow: { name: workflow } } },
});

type Rollup = { state: string; contexts?: unknown } | null;

/** A `PullRequestCore` answer for pull request `number`, with `rollup` as its head's checks. */
const core = (number: number, rollup: Rollup, extra: Record<string, unknown> = {}) => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      autoMergeAllowed: false,
      viewerPermission: "WRITE",
      pullRequest: {
        number,
        title: `Fixture pull request ${number}`,
        url: `https://${HOST}/acme/web/pull/${number}`,
        body: "Stubbed body",
        state: "OPEN",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
        reviewDecision: null,
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-02T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        headRefName: `feature-${number}`,
        baseRefName: "main",
        headRefOid: "a".repeat(40),
        isCrossRepository: false,
        headRepositoryOwner: { __typename: "Organization", login: "acme" },
        headRepository: { nameWithOwner: "acme/web", viewerPermission: "WRITE" },
        headRef: { id: `ref-${number}` },
        author: {
          __typename: "User",
          login: "octo",
          avatarUrl: `https://${HOST}/octo.png`,
          id: "u1",
          name: "Octo",
        },
        autoMergeRequest: null,
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        viewerCanUpdateBranch: true,
        baseRef: { compare: { behindBy: 0 } },
        reviewRequests: {
          nodes: [{ requestedReviewer: { __typename: "User", login: "reviewer", name: null } }],
        },
        labels: { nodes: [{ name: "bug", color: "ff0000" }] },
        commits: { nodes: [{ commit: { statusCheckRollup: rollup } }] },
        ...extra,
      },
    },
  },
});

const contexts = (nodes: ReadonlyArray<unknown>, hasNextPage = false) => ({
  nodes,
  pageInfo: { hasNextPage },
});
const readable = (state = "FAILURE") => ({
  state,
  contexts: contexts([checkRun("build", "SUCCESS"), checkRun("test", "FAILURE")]),
});
const refused = (message: string, path: ReadonlyArray<string | number> = contextsPath) => ({
  type: "FORBIDDEN",
  message,
  path,
  locations: [{ line: 1, column: 1 }],
});
const contextsPage = (
  nodes: ReadonlyArray<unknown>,
  endCursor: string | null,
  headRefOid = "a".repeat(40),
) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid,
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } },
                },
              },
            },
          ],
        },
      },
    },
  },
});
const manyChecks = (count: number, offset = 0) =>
  Array.from({ length: count }, (_, index) => checkRun(`job-${offset + index}`, "SUCCESS"));

/** One stub answer. `match` fields are compared against the request; missing means any. */
interface Answer {
  readonly match: {
    readonly operation: string;
    readonly detailedChecks?: boolean;
    readonly requestedReviewers?: number;
    readonly after?: string | null;
  };
  readonly status?: number;
  readonly body?: unknown;
  readonly destroySocket?: boolean;
}
interface Fixture {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly answers: ReadonlyArray<Answer>;
}

const coreOp = "PullRequestCore";
const walkOp = "PullRequestCheckContexts";
const degradedRetry = (number: number, state = "SUCCESS"): Answer => ({
  match: { operation: coreOp, detailedChecks: false },
  body: core(number, { state }),
});

const buildFixtures = (): ReadonlyArray<Fixture> => [
  {
    id: "F1",
    number: 101,
    title: "readable checks",
    answers: [{ match: { operation: coreOp }, body: core(101, readable()) }],
  },
  {
    id: "F2",
    number: 102,
    title: "contexts refused, HTTP 200, PAT message, path length 8",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true },
        body: { data: null, errors: [refused(PAT)] },
      },
      degradedRetry(102),
    ],
  },
  {
    id: "F2b",
    number: 112,
    title: "as F2 with rollup FAILURE",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true },
        body: { data: null, errors: [refused(PAT)] },
      },
      degradedRetry(112, "FAILURE"),
    ],
  },
  {
    id: "F3",
    number: 103,
    title: "contexts refused, HTTP 403, integration message",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true },
        status: 403,
        body: { errors: [refused(INTEGRATION)] },
      },
      degradedRetry(103),
    ],
  },
  {
    id: "F3b",
    number: 113,
    title: "per-node refusal, path length 10, partial data",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true },
        body: {
          ...core(113, { state: "PENDING", contexts: contexts([null, null]) }),
          errors: [
            refused(PAT, [...contextsPath, "nodes", 0]),
            refused(PAT, [...contextsPath, "nodes", 1]),
          ],
        },
      },
      degradedRetry(113, "PENDING"),
    ],
  },
  {
    id: "F4",
    number: 104,
    title: "reviewers and contexts refused together (200)",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true, requestedReviewers: 100 },
        body: { data: null, errors: [refused(INTEGRATION, reviewerPath), refused(PAT)] },
      },
      {
        match: { operation: coreOp, detailedChecks: false, requestedReviewers: 0 },
        body: core(104, { state: "SUCCESS" }, { reviewRequests: { nodes: [] } }),
      },
    ],
  },
  {
    id: "F4b",
    number: 114,
    title: "reviewers refused only (regression guard)",
    answers: [
      {
        match: { operation: coreOp, requestedReviewers: 100 },
        body: { ...core(114, readable()), errors: [refused(INTEGRATION, reviewerPath)] },
      },
      {
        match: { operation: coreOp, requestedReviewers: 0 },
        body: core(114, readable(), { reviewRequests: { nodes: [] } }),
      },
    ],
  },
  {
    id: "F4c",
    number: 124,
    title: "reviewers and contexts refused at HTTP 403 (stays an error)",
    answers: [
      {
        match: { operation: coreOp },
        status: 403,
        body: { errors: [refused(INTEGRATION, reviewerPath), refused(PAT)] },
      },
    ],
  },
  {
    id: "F5a",
    number: 105,
    title: "unrelated: generic Forbidden message at contexts",
    answers: [
      {
        match: { operation: coreOp },
        body: { data: null, errors: [refused("Forbidden")] },
      },
    ],
  },
  {
    id: "F5b",
    number: 115,
    title: "unrelated: HTTP 500 INTERNAL",
    answers: [
      {
        match: { operation: coreOp },
        status: 500,
        body: { errors: [{ type: "INTERNAL", message: "Something went wrong" }] },
      },
    ],
  },
  {
    id: "F5c",
    number: 125,
    title: "unrelated: PAT message at contexts.totalCount (bad path)",
    answers: [
      {
        match: { operation: coreOp },
        body: { data: null, errors: [refused(PAT, [...contextsPath, "totalCount"])] },
      },
    ],
  },
  {
    id: "F5d",
    number: 135,
    title: "unrelated: contexts refusal plus an INTERNAL error",
    answers: [
      {
        match: { operation: coreOp },
        body: {
          data: null,
          errors: [refused(PAT), { type: "INTERNAL", message: "Something went wrong" }],
        },
      },
    ],
  },
  {
    id: "F5t",
    number: 145,
    title: "transport failure (socket destroyed)",
    answers: [{ match: { operation: coreOp }, destroySocket: true }],
  },
  {
    id: "F6",
    number: 106,
    title: "more than 100 checks, walked",
    answers: [
      {
        match: { operation: coreOp },
        body: core(106, { state: "SUCCESS", contexts: contexts(manyChecks(100), true) }),
      },
      { match: { operation: walkOp, after: null }, body: contextsPage(manyChecks(100), "c1") },
      { match: { operation: walkOp, after: "c1" }, body: contextsPage(manyChecks(5, 100), null) },
    ],
  },
  {
    id: "F6b",
    number: 116,
    title: "walk refused mid-pagination",
    answers: [
      {
        match: { operation: coreOp, detailedChecks: true },
        body: core(116, { state: "FAILURE", contexts: contexts(manyChecks(100), true) }),
      },
      {
        match: { operation: walkOp },
        body: { data: null, errors: [refused(PAT)] },
      },
      degradedRetry(116, "FAILURE"),
    ],
  },
  {
    id: "F7",
    number: 107,
    title: "head changed during the walk",
    answers: [
      {
        match: { operation: coreOp },
        body: core(107, { state: "SUCCESS", contexts: contexts(manyChecks(100), true) }),
      },
      {
        match: { operation: walkOp },
        body: contextsPage(manyChecks(100), null, "b".repeat(40)),
      },
    ],
  },
  {
    id: "F8",
    number: 108,
    title: "not found",
    answers: [
      {
        match: { operation: coreOp },
        body: {
          data: { repository: { pullRequest: null } },
          errors: [
            {
              type: "NOT_FOUND",
              message: "Could not resolve to a PullRequest with the number of 108.",
              path: ["repository", "pullRequest"],
            },
          ],
        },
      },
    ],
  },
];

if (values["emit-fixtures"]) {
  NodeFS.writeFileSync(
    NodePath.join(here, "fixtures.json"),
    `${JSON.stringify(buildFixtures(), null, 2)}\n`,
  );
  console.log(`Wrote ${NodePath.join(here, "fixtures.json")}`);
  process.exit(0);
}

NodeAssert.ok(values.out, "--out is required");
const out = NodePath.resolve(values.out);
NodeFS.mkdirSync(out, { recursive: true });

// The GitHub driver keys a project by its remote's host without the port, so the stub has to
// answer on 443 for `github.localtest.me`. An unprivileged user and network namespace gives the
// run its own loopback, port 443 and /etc/hosts without touching the machine.
if (!values["in-namespace"]) {
  const hosts = NodePath.join(out, "hosts");
  NodeFS.writeFileSync(hosts, `127.0.0.1 localhost\n::1 localhost ${HOST}\n`);
  const result = NodeChildProcess.spawnSync(
    "unshare",
    [
      "-rnm",
      "sh",
      "-c",
      'mount --bind "$0" /etc/hosts && ip link set lo up && exec "$@"',
      hosts,
      process.execPath,
      import.meta.filename,
      ...process.argv.slice(2),
      "--in-namespace",
    ],
    { cwd: root, stdio: "inherit" },
  );
  process.exit(result.status ?? 1);
}

const fixtures: ReadonlyArray<Fixture> = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "fixtures.json"), "utf8"),
);
const selected = values.rows
  ? fixtures.filter((fixture) => values.rows?.split(",").includes(fixture.id))
  : fixtures;
NodeAssert.ok(selected.length > 0, "no rows selected");

// Stub forge: a self-signed certificate for the fake Enterprise host, trusted by the server only.
const certDir = NodePath.join(out, "tls");
NodeFS.mkdirSync(certDir, { recursive: true });
const certFile = NodePath.join(certDir, "cert.pem");
const keyFile = NodePath.join(certDir, "key.pem");
NodeChildProcess.execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    `/CN=${HOST}`,
    "-addext",
    `subjectAltName=DNS:${HOST}`,
    "-keyout",
    keyFile,
    "-out",
    certFile,
  ],
  { stdio: "ignore" },
);
const caBundle = NodePath.join(certDir, "ca-bundle.pem");
const systemBundle = process.env.NODE_EXTRA_CA_CERTS;
NodeFS.writeFileSync(
  caBundle,
  (systemBundle && NodeFS.existsSync(systemBundle)
    ? NodeFS.readFileSync(systemBundle, "utf8")
    : "") + NodeFS.readFileSync(certFile, "utf8"),
);

const requestLog = NodePath.join(out, "requests.jsonl");
NodeFS.writeFileSync(requestLog, "");
let currentRow = "setup";
const stubPort = Number(values["stub-port"]);
const stubHost = stubPort === 443 ? HOST : `${HOST}:${stubPort}`;
const stub = NodeHttps.createServer(
  { cert: NodeFS.readFileSync(certFile), key: NodeFS.readFileSync(keyFile) },
  (req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk.toString()));
    req.on("end", () => {
      const url = req.url ?? "";
      let entry: Record<string, unknown> = { row: currentRow, method: req.method, url };
      let answer: Answer | undefined;
      if (req.method === "POST" && url === "/api/graphql") {
        const body = JSON.parse(raw) as { query?: string; variables?: Record<string, unknown> };
        const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query ?? "")?.[1] ?? "unknown";
        const variables = body.variables ?? {};
        entry = {
          ...entry,
          operation,
          variables: {
            number: variables.number,
            detailedChecks: variables.detailedChecks,
            requestedReviewers: variables.requestedReviewers,
            after: variables.after,
          },
          queryHasDetailedChecks: (body.query ?? "").includes("$detailedChecks"),
        };
        if (operation === "RoutingIdentityViewer") {
          answer = {
            match: { operation },
            body: { data: { viewer: { databaseId: 1, login: "stub" } } },
          };
        } else {
          const fixture = fixtures.find((candidate) => candidate.number === variables.number);
          // A server without `$detailedChecks` always reads the contexts.
          const detailedChecks = variables.detailedChecks ?? true;
          answer = fixture?.answers.find(
            ({ match }) =>
              match.operation === operation &&
              (match.detailedChecks === undefined || match.detailedChecks === detailedChecks) &&
              (match.requestedReviewers === undefined ||
                match.requestedReviewers === variables.requestedReviewers) &&
              (match.after === undefined || match.after === (variables.after ?? null)),
          );
        }
      } else if (req.method === "GET" && url.startsWith("/api/v3/user")) {
        answer = { match: { operation: "rest:user" }, body: { login: "stub", id: 1 } };
      }
      if (answer?.destroySocket) {
        NodeFS.appendFileSync(
          requestLog,
          `${JSON.stringify({ ...entry, answer: "socket destroyed" })}\n`,
        );
        req.socket.destroy();
        return;
      }
      const status = answer ? (answer.status ?? 200) : 404;
      NodeFS.appendFileSync(
        requestLog,
        `${JSON.stringify({ ...entry, status, unmatched: answer === undefined || undefined })}\n`,
      );
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer?.body ?? { message: "Not Found (stub)" }));
    });
  },
);
stub.listen(stubPort, "::1");
await new Promise<void>((done) => stub.once("listening", done));

// Scratch project whose origin names the stub host.
const project = NodePath.join(out, "project");
NodeFS.rmSync(project, { recursive: true, force: true });
NodeFS.mkdirSync(project, { recursive: true });
const git = (...args: string[]) => NodeChildProcess.execFileSync("git", args, { cwd: project });
git("init", "-q", "-b", "main");
git("remote", "add", "origin", `https://${stubHost}/acme/web.git`);
git(
  "-c",
  "user.name=ev",
  "-c",
  "user.email=ev@example.com",
  "commit",
  "-q",
  "--allow-empty",
  "-m",
  "init",
);

const home = NodePath.join(out, "home");
NodeFS.rmSync(home, { recursive: true, force: true });
NodeFS.mkdirSync(home, { recursive: true });
const reservation = NodeHttp.createServer();
reservation.listen(0, "127.0.0.1");
await new Promise<void>((done) => reservation.once("listening", done));
const address = reservation.address();
NodeAssert.ok(address && typeof address !== "string");
await new Promise<void>((done) => reservation.close(() => done()));
const port = address.port;
const origin = `http://127.0.0.1:${port}`;
const bootstrap = NodeCrypto.randomUUID();
const server = NodeChildProcess.spawn(
  process.execPath,
  ["apps/server/src/bin.ts", "start", "--bootstrap-fd", "3"],
  {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      T3CODE_HOME: home,
      GH_HOST: stubHost,
      GH_ENTERPRISE_TOKEN: "stub-token",
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      NODE_EXTRA_CA_CERTS: caBundle,
      NO_PROXY: `localhost,127.0.0.1,::1,${HOST}`,
      no_proxy: `localhost,127.0.0.1,::1,${HOST}`,
    },
  },
);
console.log(`server pid ${server.pid}, port ${port}, stub [::1]:${stubPort}`);
const bootstrapPipe = server.stdio[3];
NodeAssert.ok(bootstrapPipe && "write" in bootstrapPipe);
// The server closes its end once it has read the bootstrap.
bootstrapPipe.on("error", () => {});
bootstrapPipe.end(
  JSON.stringify({
    mode: "desktop",
    noBrowser: true,
    port,
    t3Home: home,
    host: "127.0.0.1",
    desktopBootstrapToken: bootstrap,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  }),
);
const ready = Promise.withResolvers<void>();
let tail = "";
for (const pipe of [server.stdout, server.stderr])
  pipe?.on("data", (data: Buffer) => {
    const text = data.toString().replaceAll(bootstrap, "[REDACTED]");
    NodeFS.appendFileSync(NodePath.join(out, "server.log"), text);
    tail = (tail + text).slice(-8192);
    if (tail.includes(`Listening on ${origin}`)) ready.resolve();
  });
server.once("exit", (code) => ready.reject(new Error(`Server exited ${code}`)));
const deadline = setTimeout(() => ready.reject(new Error("Server startup timed out")), 90_000);

const describeError = (error: unknown) =>
  error instanceof Error || (typeof error === "object" && error !== null)
    ? {
        ...JSON.parse(JSON.stringify(error)),
        _tag: (error as { _tag?: unknown })._tag,
        message: (error as { message?: unknown }).message,
      }
    : { message: String(error) };
const results: Array<Record<string, unknown>> = [];
try {
  await ready.promise;
  clearTimeout(deadline);
  const tokenResponse = await fetch(`${origin}/oauth/token`, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: bootstrap,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    }),
  });
  NodeAssert.ok(tokenResponse.ok, `Authentication failed: ${tokenResponse.status}`);
  const token = Schema.decodeUnknownSync(Schema.Struct({ access_token: Schema.String }))(
    await tokenResponse.json(),
  );
  const headers = {
    Authorization: `Bearer ${token.access_token}`,
    "Content-Type": "application/json",
    [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
  };
  const projectId = ProjectId.make(NodeCrypto.randomUUID());
  const created = await fetch(`${origin}/api/projects/mutate`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      type: "project.create",
      commandId: NodeCrypto.randomUUID(),
      projectId,
      title: "PR 22987 evidence",
      workspaceRoot: project,
    }),
  });
  NodeAssert.ok(created.ok, `Project creation failed: ${created.status} ${await created.text()}`);
  const ticketResponse = await fetch(`${origin}/api/auth/websocket-ticket`, {
    method: "POST",
    headers,
  });
  NodeAssert.ok(ticketResponse.ok, `WebSocket authentication failed: ${ticketResponse.status}`);
  const ticket = Schema.decodeUnknownSync(Schema.Struct({ ticket: Schema.String }))(
    await ticketResponse.json(),
  );
  const layerSocket = Socket.layerWebSocket(
    `${origin.replace("http:", "ws:")}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
  ).pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal));
  const layerProtocol = RpcClient.layerProtocolSocket().pipe(
    Layer.provide(layerSocket),
    Layer.provide(RpcSerialization.layerJson),
  );
  const program = Effect.gen(function* () {
    const client = yield* RpcClient.make(WsRpcGroup);
    for (const fixture of selected) {
      currentRow = fixture.id;
      const exit = yield* client["pullRequests.detail"]({
        projectId,
        repository: "acme/web",
        number: fixture.number,
      }).pipe(Effect.timeout("60 seconds"), Effect.exit);
      const outcome = Exit.isSuccess(exit)
        ? { ok: true, detail: exit.value }
        : { ok: false, error: describeError(Cause.squash(exit.cause)) };
      results.push({ id: fixture.id, number: fixture.number, title: fixture.title, ...outcome });
      console.log(`${fixture.id} #${fixture.number}: ${outcome.ok ? "detail" : "error"}`);
    }
  }).pipe(Effect.scoped, Effect.provide(layerProtocol));
  await Effect.runPromise(program);
} finally {
  clearTimeout(deadline);
  NodeFS.writeFileSync(
    NodePath.join(out, "results.json"),
    `${JSON.stringify({ label: values.label, results }, null, 2)}\n`,
  );
  server.kill("SIGTERM");
  await new Promise<void>((done) => {
    if (server.exitCode !== null) return done();
    const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
    server.once("exit", () => {
      clearTimeout(force);
      done();
    });
  });
  stub.close();
  stub.closeAllConnections();
}
