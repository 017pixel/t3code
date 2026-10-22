import http from "node:http";
import { execFileSync } from "node:child_process";

// Standalone fixture: run from either revision, keeping app state isolated in .t3/desktop.
const port = Number(process.env.FIXTURE_PORT ?? 14807);
const gates = new Set();
const html = (path) =>
  `<!doctype html><meta charset="utf-8"><title>16901 ${path}</title><style>body{margin:0;padding:32px;font:20px Arial;background:#fff;color:#111}h1{font-size:32px}a,button{margin:12px;padding:12px}#marker{padding:40px;border:4px solid black}</style><h1>Issue 16901 deterministic fixture</h1><div id="marker">PAGE ${path} / STEP initial</div><p><a href="/A">Page A</a><a href="/B">Page B</a><button onclick="window.open('/POPUP')">Popup</button><a href="/document.pdf">PDF</a><a href="/download">Download</a><a href="/failure">Failure</a><a href="/gate">Gated response</a></p>`;
const stream = "BT /F1 24 Tf 50 100 Td (ISSUE 16901 PDF) Tj ET";
const objects = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
];
let pdf = "%PDF-1.4\n";
const offsets = [0];
for (const [i, object] of objects.entries()) {
  offsets.push(Buffer.byteLength(pdf));
  pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
}
const xref = Buffer.byteLength(pdf);
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
  .slice(1)
  .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
  .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const server = http.createServer((req, res) => {
  console.log(JSON.stringify({ event: "request", path: req.url, at: new Date().toISOString() }));
  if (req.url === "/release") {
    for (const response of gates) response.end(html("/gate"));
    gates.clear();
    res.end("released");
  } else if (req.url === "/gate") {
    res.setHeader("Content-Type", "text/html");
    gates.add(res);
    res.on("close", () => gates.delete(res));
  } else if (req.url === "/failure") req.socket.destroy();
  else if (req.url === "/document.pdf") {
    res.setHeader("Content-Type", "application/pdf");
    res.end(pdf);
  } else if (req.url === "/download") {
    res.setHeader("Content-Disposition", 'attachment; filename="16901.txt"');
    res.end("16901 fixture download");
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(html(req.url));
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(
    JSON.stringify({
      event: "ready",
      sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      url: `http://127.0.0.1:${port}/A`,
      scenarios: ["late-attach", "native-hidden", "idle-capture", "stream-states"],
      state: ".t3/desktop",
      lateAttach:
        "H1 actually captured https://example.com (not the local fixture): submit Claude sleep 5 then preview_open {url:https://example.com,open:false,reuseExistingTab:false}. Immediately CDP-evaluate setTimeout(() => { const end = Date.now() + 45000; while (Date.now() < end) {} }, 200) on the t3code:// APP renderer. After recovery preview_open same tabId open:true; evaluate body background red and innerHTML <h1>ISSUE 16901 / STEP RED</h1>, then blue/STEP BLUE. preview_snapshot {tabId,includeImage:true,save:true}.",
      nativeHidden:
        "C1 actually captured http://127.0.0.1:14807/A: preview_open {url:http://127.0.0.1:14807/A,open:true,reuseExistingTab:false}; select its panel tab and verify hosted webview exists. Submit Claude sleep 10, evaluate background red and #marker NATIVE HIDDEN RED, preview_snapshot {tabId,includeImage:true,save:true}, sleep 12, evaluate blue/NATIVE HIDDEN BLUE, preview_snapshot again. Immediately hide panel/floating and select thread B before first capture. Observe data-preview-rendering through turn end. Never enable built-in recording.",
    }),
  ),
);
