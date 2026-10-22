// HTTPS CONNECT proxy that only admits github.invalid:443 and serves a minimal GitHub
// Enterprise API there. Every request (and every refused CONNECT) is appended to a JSONL log.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodePath from "node:path";

const HOST = "github.invalid";

export function ensureCertificates(caDir) {
  const leafKey = NodePath.join(caDir, "leaf.key");
  if (NodeFS.existsSync(leafKey)) return;
  NodeFS.mkdirSync(caDir, { recursive: true });
  const openssl = (...args) => NodeChildProcess.execFileSync("openssl", args, { stdio: "pipe" });
  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=pr-22943 throwaway CA",
    "-keyout",
    NodePath.join(caDir, "ca.key"),
    "-out",
    NodePath.join(caDir, "ca.pem"),
  );
  NodeFS.writeFileSync(NodePath.join(caDir, "leaf.ext"), `subjectAltName=DNS:${HOST}\n`);
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${HOST}`,
    "-keyout",
    leafKey,
    "-out",
    NodePath.join(caDir, "leaf.csr"),
  );
  openssl(
    "x509",
    "-req",
    "-in",
    NodePath.join(caDir, "leaf.csr"),
    "-CA",
    NodePath.join(caDir, "ca.pem"),
    "-CAkey",
    NodePath.join(caDir, "ca.key"),
    "-CAcreateserial",
    "-days",
    "2",
    "-extfile",
    NodePath.join(caDir, "leaf.ext"),
    "-out",
    NodePath.join(caDir, "leaf.pem"),
  );
}

/** @param {{ caDir: string, logFile: string, repoInfo: "ok" | "404" }} options */
export async function startForgeStub({ caDir, logFile, repoInfo }) {
  ensureCertificates(caDir);
  const log = (entry) =>
    NodeFS.appendFileSync(
      logFile,
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
    );
  let created = null;

  const api = NodeHttps.createServer(
    {
      key: NodeFS.readFileSync(NodePath.join(caDir, "leaf.key")),
      cert: NodeFS.readFileSync(NodePath.join(caDir, "leaf.pem")),
    },
    (req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        let body = null;
        try {
          body = raw ? JSON.parse(raw) : null;
        } catch {
          body = raw;
        }
        const json = (status, value) => {
          log({ kind: "request", method: req.method, url: req.url, body, status, response: value });
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
        };
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && path === "/api/v3/repos/acme/demo") {
          return repoInfo === "404"
            ? json(404, { message: "Not Found" })
            : json(200, {
                id: 1,
                node_id: "R_1",
                name: "demo",
                full_name: "acme/demo",
                private: false,
                owner: { login: "acme", type: "Organization" },
                html_url: `https://${HOST}/acme/demo`,
                clone_url: `https://${HOST}/acme/demo.git`,
                ssh_url: `git@${HOST}:acme/demo.git`,
                default_branch: "main",
              });
        }
        if (req.method === "POST" && path === "/api/graphql") {
          const query = String(body?.query ?? "");
          if (query.includes("pullRequests(")) {
            // Batched queries alias each field as `_<n>_repository` with `_<n>_head` variables.
            const prefixes = [
              ...query.matchAll(/(_\d+_)?repository:repository\(|repository\(/g),
            ].map((match) => match[1] ?? "");
            const data = {};
            for (const prefix of new Set(prefixes)) {
              const head = body?.variables?.[`${prefix}head`];
              const nodes = created && created.head === head ? [created.node] : [];
              data[`${prefix}repository`] = {
                pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes },
              };
            }
            return json(200, { data });
          }
          return json(200, { errors: [{ message: "stub: unsupported query" }] });
        }
        if (req.method === "POST" && path === "/api/v3/repos/acme/demo/pulls") {
          const node = {
            number: 7,
            title: body.title,
            url: `https://${HOST}/acme/demo/pull/7`,
            baseRefName: body.base,
            headRefName: body.head,
            headRefOid: "0".repeat(40),
            state: "OPEN",
            isDraft: false,
            mergedAt: null,
            closedAt: null,
            updatedAt: new Date().toISOString(),
            isCrossRepository: false,
            headRepository: { name: "demo", nameWithOwner: "acme/demo" },
            headRepositoryOwner: { __typename: "Organization", login: "acme" },
          };
          created = { head: body.head, node };
          log({ kind: "forge-create-pr", body });
          return json(201, {
            number: 7,
            html_url: node.url,
            base: { ref: body.base },
            head: { ref: body.head },
            title: body.title,
          });
        }
        return json(404, { message: "stub: not handled" });
      });
    },
  );
  api.on("tlsClientError", (error) => log({ kind: "tls-error", message: error.message }));

  const proxy = NodeHttp.createServer((req, res) => {
    log({ kind: "plain-http-refused", method: req.method, url: req.url });
    res.writeHead(403).end();
  });
  proxy.on("connect", (req, socket, head) => {
    if (req.url !== `${HOST}:443`) {
      log({ kind: "connect-refused", target: req.url });
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    log({ kind: "connect", target: req.url });
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) socket.unshift(head);
    api.emit("connection", socket);
  });
  proxy.listen(0, "127.0.0.1");
  await new Promise((done) => proxy.once("listening", done));
  return {
    port: proxy.address().port,
    close: () =>
      new Promise((done) => {
        proxy.closeAllConnections?.();
        api.closeAllConnections?.();
        proxy.close(() => done());
      }),
  };
}
