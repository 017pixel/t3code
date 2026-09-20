// @effect-diagnostics nodeBuiltinImport:off - Exercises the real shell installer against a local HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const missingAtomicError =
  "t3: error while loading shared libraries: libatomic.so.1: cannot open shared object file: No such file or directory";

// Stub uname so the Linux diagnostic can also be exercised on macOS.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "installer executable validation",
  () => {
    it.each([
      {
        platform: "Linux",
        diagnostic: missingAtomicError,
        exitCode: 127,
        hint: true,
      },
      {
        platform: "Linux",
        diagnostic:
          "t3: error while loading shared libraries: libatomic.so.1: cannot open shared object file: Permission denied",
        exitCode: 127,
        hint: false,
      },
      {
        platform: "Darwin",
        diagnostic: missingAtomicError,
        exitCode: 127,
        hint: false,
      },
      {
        platform: "Linux",
        diagnostic: "t3: startup warning",
        exitCode: 0,
        hint: false,
      },
    ])(
      "handles $platform validation: $diagnostic",
      async ({ platform, diagnostic, exitCode, hint }) => {
        const root = await NodeFSP.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "t3-install-validation-"),
        );
        const version = "1.2.3";
        const stem = `t3-${version}-${platform.toLowerCase()}-x64`;
        const archiveName = `${stem}.tar.gz`;
        const home = NodePath.join(root, "home");
        const bin = NodePath.join(root, "bin");
        const versions = NodePath.join(home, "runtime/versions");
        const server = NodeHttp.createServer((request, response) => {
          if (request.url?.endsWith("/SHA256SUMS")) {
            response.end(`${checksum}  ${archiveName}\n`);
          } else if (request.url?.endsWith(`/${archiveName}`)) {
            response.end(archive);
          } else {
            response.writeHead(404).end();
          }
        });
        let archive: Buffer;
        let checksum: string;
        try {
          await NodeFSP.mkdir(NodePath.join(root, stem));
          await NodeFSP.writeFile(
            NodePath.join(root, stem, "t3"),
            `#!/bin/sh\nprintf '%s\\n' '${diagnostic}' >&2\nexit ${exitCode}\n`,
            { mode: 0o755 },
          );
          NodeChildProcess.execFileSync("tar", [
            "-czf",
            NodePath.join(root, archiveName),
            "-C",
            root,
            stem,
          ]);
          archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
          checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
          await NodeFSP.mkdir(bin);
          await NodeFSP.writeFile(
            NodePath.join(bin, "uname"),
            `#!/bin/sh\ncase "$1" in -s) echo '${platform}';; -m) echo x86_64;; *) exit 1;; esac\n`,
            { mode: 0o755 },
          );
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
          const result = await new Promise<{
            code: number | null;
            stdout: string;
            stderr: string;
          }>((resolve, reject) => {
            const child = NodeChildProcess.spawn(
              "sh",
              [NodePath.resolve(import.meta.dirname, "install.sh")],
              {
                env: {
                  ...process.env,
                  PATH: `${bin}:${process.env.PATH}`,
                  T3CODE_VERSION: version,
                  T3CODE_HOME: home,
                  T3CODE_INSTALL_BIN_DIR: bin,
                  T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
                },
                stdio: ["ignore", "pipe", "pipe"],
              },
            );
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (chunk: Buffer) => {
              stdout += chunk.toString();
            });
            child.stderr.on("data", (chunk: Buffer) => {
              stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          });
          expect(result.stderr).toContain(diagnostic);
          expect(result.stderr.includes("providing libatomic.so.1")).toBe(hint);
          expect(result.stdout).not.toContain(diagnostic);
          if (exitCode === 0) {
            expect(result.code).toBe(0);
            expect(await NodeFSP.readdir(NodePath.join(versions, version))).not.toContain(
              "version.errors",
            );
          } else {
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
              hint ? "rerun the installer" : "the downloaded executable does not run",
            );
          }
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await NodeFSP.rm(root, { recursive: true, force: true });
        }
      },
    );
  },
);
