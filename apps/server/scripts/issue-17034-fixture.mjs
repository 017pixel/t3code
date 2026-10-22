/**
 * Actual-app update-permission evidence fixture; never starts a server or browser.
 * Run from any directory with Node 26:
 *   node apps/server/scripts/issue-17034-fixture.mjs init /tmp/t3-issue-17034-proof
 *   node apps/server/scripts/issue-17034-fixture.mjs sessions /tmp/t3-issue-17034-private HOME_A HOME_B HOME_C
 *   node apps/server/scripts/issue-17034-fixture.mjs projects /tmp/t3-issue-17034-project HOME_A HOME_B HOME_C
 *   node apps/server/scripts/issue-17034-fixture.mjs descriptor-apply /tmp/t3-issue-17034-descriptor.json 16471 16472 16473 16474
 *   node apps/server/scripts/issue-17034-fixture.mjs descriptor-restore /tmp/t3-issue-17034-descriptor.json 16471 16472 16473 16474
 *
 * Coordinate ALL servers sharing this checkout with their owner before apply/restore.
 * Ports must include every such server. Both commands refuse listening ports and
 * live runtime PIDs in this worktree's .t3. Apply requires the committed source;
 * restore requires the exact patched source. Never stage the descriptor or backup.
 * Metadata advertises an update; it does not install a boot service. Do not infer
 * successful updates from it. Pending/races/desktop branches still need a harness.
 *
 * init is for NEW homes only; existing lead-owned homes can go directly to sessions
 * or projects. Sessions are minted privately by the supported auth CLI (not fixed
 * tokens). Re-running sessions creates new credentials, so revoke old sessions via
 * the auth CLI when finished. Output is private mode-0600 JSON; never publish it.
 * projects uses the real project CLI and an empty Git repository shared by all homes.
 * Select its new draft and Auto balance in the real client; no draft/catalog writes.
 * Labels below are capture inputs, NOT a server-label override: the server descriptor
 * derives its label from the OS. No supported server-label setting exists here.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const source = NodePath.join(root, "apps/server/src/environment/ServerEnvironment.ts");
const cli = NodePath.join(root, "apps/server/src/bin.ts");
const oldVersion = "0.0.46-nightly.20261007.2761";
const labels = [
  "Office",
  "Laptop",
  `Studio ${"X".repeat(48)} ${"remote-room-".repeat(4)}`.slice(0, 96),
];
const scopes = ["orchestration:read", "orchestration:operate", "terminal:operate", "relay:read"];
const digest = (value) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const run = (args) =>
  NodeChildProcess.execFileSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
function safePath(value) {
  if (!value || !NodePath.isAbsolute(value)) throw new Error("Use an absolute isolated path.");
  const resolved = NodePath.resolve(value);
  const allowed =
    resolved.startsWith("/tmp/t3-issue-17034-") || resolved === NodePath.join(root, ".t3");
  if (!allowed) throw new Error("Only /tmp/t3-issue-17034-* or this checkout's .t3 is permitted.");
  let ancestor = resolved;
  while (!NodeFS.existsSync(ancestor)) ancestor = NodePath.dirname(ancestor);
  if (NodeFS.realpathSync(ancestor) !== ancestor)
    throw new Error("Symlinked fixture paths are forbidden.");
  return resolved;
}
function homesFrom(args) {
  if (args.length !== 3) throw new Error("Supply exactly three distinct existing isolated homes.");
  const homes = args.map(safePath);
  const ids = homes.map((home) =>
    NodeFS.readFileSync(NodePath.join(home, "userdata/environment-id"), "utf8").trim(),
  );
  if (ids.some((id) => !id) || new Set(ids).size !== 3)
    throw new Error("Three distinct initialized environment IDs are required.");
  return homes;
}
function patch(original) {
  const version = "serverVersion: packageJson.version,";
  const capability = "      ...(serverSelfUpdate === null ? {} : { serverSelfUpdate }),";
  if (original.split(version).length !== 2 || original.split(capability).length !== 2) {
    throw new Error("Descriptor source changed or is already patched; coordinate with its owner.");
  }
  return original
    .replace(version, `serverVersion: "${oldVersion}",`)
    .replace(capability, '      serverSelfUpdate: "boot-service",');
}
async function assertStopped(ports) {
  if (
    ports.length < 4 ||
    ports.some((port) => !/^\d+$/.test(port) || +port < 1024 || +port > 65535)
  ) {
    throw new Error("List at least all four proof backend ports explicitly.");
  }
  for (const home of [
    NodePath.join(root, ".t3"),
    ...fs
      .readdirSync("/tmp")
      .filter((name) => name.startsWith("t3-issue-17034-"))
      .map((name) => NodePath.join("/tmp", name)),
  ]) {
    const runtime = NodePath.join(home, "userdata/server-runtime.json");
    if (!NodeFS.existsSync(runtime)) continue;
    const { pid } = JSON.parse(NodeFS.readFileSync(runtime, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("Invalid runtime PID.");
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") continue;
      throw error;
    }
    throw new Error(`Stop the fixture server owned by ${home} before changing source.`);
  }
  for (const port of ports) {
    await new Promise((resolve, reject) => {
      const socket = NodeNet.connect({ host: "127.0.0.1", port: +port });
      socket.setTimeout(1000);
      socket.once("connect", () => {
        socket.destroy();
        reject(new Error(`Port ${port} is listening; owner must stop it.`));
      });
      socket.once("timeout", () => {
        socket.destroy();
        reject(new Error(`Port ${port} could not be checked.`));
      });
      socket.once("error", (error) => (error.code === "ECONNREFUSED" ? resolve() : reject(error)));
    });
  }
}
const [command, destination, ...args] = process.argv.slice(2);
try {
  if (command === "init") {
    const base = safePath(destination);
    NodeFS.mkdirSync(base, { mode: 0o700 });
    const entries = labels.map((label, index) => {
      const home = NodePath.join(base, `environment-${index + 1}`);
      NodeFS.mkdirSync(NodePath.join(home, "userdata"), { recursive: true, mode: 0o700 });
      const environmentId = `17034000-0000-4000-8000-00000000000${index + 1}`;
      NodeFS.writeFileSync(NodePath.join(home, "userdata/environment-id"), `${environmentId}\n`, {
        mode: 0o600,
        flag: "wx",
      });
      return {
        home,
        environmentId,
        requestedLabel: label,
        defaultPermission: index === 1 ? "permitted" : "denied",
      };
    });
    NodeFS.writeFileSync(
      NodePath.join(base, "manifest.json"),
      `${JSON.stringify(entries, null, 2)}\n`,
      {
        mode: 0o600,
        flag: "wx",
      },
    );
    console.log("Created three isolated homes and non-secret manifest. No server started.");
  } else if (command === "sessions") {
    const homes = homesFrom(args);
    const output = safePath(destination);
    NodeFS.mkdirSync(output, { mode: 0o700 });
    for (const [index, home] of homes.entries()) {
      for (const permission of ["denied", "permitted"]) {
        const granted = permission === "permitted" ? [...scopes, "environment:maintain"] : scopes;
        const result = run([
          "auth",
          "session",
          "issue",
          "--base-dir",
          home,
          ...granted.flatMap((scope) => ["--scope", scope]),
          "--label",
          `proof-${index + 1}-${permission}`,
          "--json",
        ]);
        JSON.parse(result);
        NodeFS.writeFileSync(NodePath.join(output, `${index + 1}-${permission}.json`), result, {
          mode: 0o600,
          flag: "wx",
        });
      }
    }
    console.log(
      "Issued allowed/denied sessions for all three identities; credentials saved privately.",
    );
  } else if (command === "projects") {
    const homes = homesFrom(args);
    const workspace = safePath(destination);
    NodeFS.mkdirSync(workspace, { mode: 0o700 });
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main", workspace], {
      stdio: "ignore",
    });
    for (const home of homes)
      run(["project", "add", workspace, "--title", "Update permission proof", "--base-dir", home]);
    console.log(
      "Added the same empty Git workspace to three environments. Select its draft and Auto balance in the client.",
    );
  } else if (command === "descriptor-apply" || command === "descriptor-restore") {
    const backup = safePath(destination);
    await assertStopped(args);
    if (command === "descriptor-apply") {
      const original = NodeFS.readFileSync(source, "utf8");
      const committed = NodeChildProcess.execFileSync(
        "git",
        ["show", "HEAD:apps/server/src/environment/ServerEnvironment.ts"],
        { cwd: root, encoding: "utf8" },
      );
      if (original !== committed)
        throw new Error("Descriptor has uncommitted changes; do not overwrite them.");
      const patched = patch(original);
      NodeFS.writeFileSync(backup, JSON.stringify({ original, patchedHash: digest(patched) }), {
        mode: 0o600,
        flag: "wx",
      });
      NodeFS.writeFileSync(source, patched);
    } else {
      const { original, patchedHash } = JSON.parse(NodeFS.readFileSync(backup, "utf8"));
      if (
        digest(NodeFS.readFileSync(source)) !== patchedHash ||
        digest(patch(original)) !== patchedHash
      )
        throw new Error("Descriptor changed since apply; refusing to overwrite.");
      NodeFS.writeFileSync(source, original);
      NodeFS.unlinkSync(backup);
    }
    console.log("Descriptor fixture operation completed. No server started.");
  } else {
    throw new Error(
      "Commands: init, sessions, projects, descriptor-apply, descriptor-restore. See file header for usage.",
    );
  }
} catch (error) {
  // CLI stderr/stdout can contain credentials; report only the operation failure.
  console.error(
    error?.status !== undefined
      ? "Fixture CLI failed; inspect the isolated environment privately."
      : error.message,
  );
  process.exitCode = 1;
}
