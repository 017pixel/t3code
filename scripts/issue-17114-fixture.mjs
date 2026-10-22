import * as NodeHttp from "node:http";
const port = Number(process.env.PORT ?? 18914);
const log = (route, status) => console.log(JSON.stringify({ route, status }));
NodeHttp.createServer((req, res) => {
  const route = new URL(req.url, "http://fixture").pathname;
  res.setHeader("Cache-Control", "no-store");
  if (route.startsWith("/basic")) {
    const realm =
      route === "/basic-empty"
        ? ""
        : route === "/basic-long"
          ? `Long realm ${"unbroken".repeat(40)}`
          : route === "/basic-other"
            ? "Other realm"
            : "Evidence fixture";
    if (req.headers.authorization !== `Basic ${Buffer.from("test:test").toString("base64")}`) {
      res.writeHead(401, { "WWW-Authenticate": `Basic realm="${realm}"` });
      log(route, 401);
      return res.end("Basic Auth required");
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  log(route, 200);
  res.end(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Evidence fixture</title><style>body{font:20px system-ui;margin:24px;background:#fff;color:#111}button{font:inherit;margin:8px}</style><h1>${route.startsWith("/basic") ? "Protected page loaded" : "Public fixture"}</h1><p>Fixture version 1</p><button onclick="out.textContent='Interaction released'">Interact</button><button onclick="out.textContent='Prompt: '+prompt('Fixture prompt','Default draft')">Prompt</button><button onclick="out.textContent='Confirm: '+confirm('Fixture confirm')">Confirm</button><button onclick="alert('Fixture alert');out.textContent='Alert closed'">Alert</button><button onclick="window.onbeforeunload=e=>{e.preventDefault();e.returnValue=''};out.textContent='Leave guard enabled'">Enable leave guard</button><a href="/public">Public page</a><pre id="out">Ready</pre>`,
  );
}).listen(port, "127.0.0.1", () =>
  console.log(
    `Fixture version 1 listening on ${port}; dummy credentials test:test; use a fresh loopback origin/port for uncached challenge`,
  ),
);
