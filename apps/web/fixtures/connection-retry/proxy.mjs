// Disposable network fault injector. Only request method/path and relative times are logged.
import http from "node:http";
import net from "node:net";
const [listenPort = "14274", targetPort = "14273", controlPort = "14275"] = process.argv.slice(2);
let mode = "pass";
const sockets = new Set();
const started = performance.now();
const log = (event, extra = {}) =>
  console.log(JSON.stringify({ ms: Math.round(performance.now() - started), event, ...extra }));
const server = http.createServer((req, res) => {
  log("request", {
    method: req.method,
    path: req.url.startsWith("/api/assets/") ? "/api/assets/[redacted]" : req.url.split("?")[0],
    mode,
  });
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Allow-Private-Network": "true",
    });
    res.end();
    return;
  }
  if (mode === "hold") return;
  if (mode === "fail") {
    res.writeHead(503, { "Access-Control-Allow-Origin": "*" });
    res.end("Synthetic remote temporarily unavailable");
    return;
  }
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: Number(targetPort),
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    },
  );
  upstream.on("error", () => {
    res.writeHead(503);
    res.end();
  });
  req.pipe(upstream);
});
server.on("connection", (s) => {
  s.on("error", () => s.destroy());
  sockets.add(s);
  s.on("close", () => sockets.delete(s));
});
server.on("upgrade", (req, socket, head) => {
  log("upgrade", { mode });
  if (mode === "hold") return;
  if (mode === "fail") {
    socket.destroy();
    return;
  }
  const upstream = net.connect(Number(targetPort), "127.0.0.1", () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((a, v, i) => a + (i % 2 ? `${v}\r\n` : `${v}: `), "")}\r\n`,
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  socket.on("close", () => upstream.destroy());
  upstream.on("error", () => socket.destroy());
});
server.listen(Number(listenPort), "127.0.0.1");
http
  .createServer((req, res) => {
    const next = req.url.slice(1);
    if (["pass", "fail", "hold"].includes(next)) {
      mode = next;
      for (const s of sockets) s.destroy();
      log("mode", { mode });
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ mode }));
  })
  .listen(Number(controlPort), "127.0.0.1");
