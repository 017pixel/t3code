import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Keep captures reproducible without copying conversation or application state.
const output = path.resolve(process.argv[2] ?? path.join(tmpdir(), "source-selection-fixtures"));
await mkdir(output, { recursive: true });
const lines = Array.from({ length: 226 }, (_, index) => {
  const id = String(index + 1).padStart(3, "0");
  return `SELECT ${id} AS line_number; -- clipboard fixture ${id}`;
});
const lf = `${lines.join("\n")}\n`;
const fixtures = {
  "issue-15927.sql": lf,
  "issue-15927-crlf.sql": lf.replaceAll("\n", "\r\n"),
  "issue-15927-cr.sql": lf.replaceAll("\n", "\r"),
  "issue-15927-mixed.sql": lines.map((line, i) => line + ["\n", "\r\n", "\r"][i % 3]).join(""),
  "issue-15927-no-final.sql": lines.join("\n"),
  "issue-15927-blanks.sql": `\n\n${lf}\n\n`,
  "issue-15927-empty.txt": "",
  "issue-15927-unicode.txt": "\tastral: 🦊 combining: e\u0301 RTL: שלום\tend",
  "issue-15927-long.sql": `${lines[0]}\n${"SELECT 'long 🦊 é' AS value; ".repeat(150)}\n${lf}`,
  "issue-15927-large.sql": lf.repeat(100),
  "issue-15927-a.sql": lf,
  "issue-15927-b.sql": lf.replaceAll("clipboard fixture", "alternate fixture"),
  "issue-15927.md": "# Source fixture\n\n**literal Markdown**\n\n" + lf,
  "issue-15927.html": "<!doctype html>\n<html><body><h1>Source fixture</h1></body></html>\n",
  "issue-15927.csv": "id,label\n1,alpha\n2,beta\n",
};
const manifest = {};
for (const [name, text] of Object.entries(fixtures)) {
  await writeFile(path.join(output, name), text);
  manifest[name] = {
    bytes: Buffer.byteLength(text),
    utf16Length: text.length,
    sha256: createHash("sha256").update(text).digest("hex"),
    crlf: (text.match(/\r\n/g) ?? []).length,
    loneCr: (text.match(/\r(?!\n)/g) ?? []).length,
    loneLf: (text.match(/(?<!\r)\n/g) ?? []).length,
    prefix: text.slice(0, 80),
    suffix: text.slice(-80),
    firstTwoStatements: name.endsWith(".sql") ? text.slice(0, text.indexOf("SELECT 003")) : null,
  };
}
await writeFile(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(output);
