import http from "node:http";
import net from "node:net";

// Full-app fixture: proxy the real Vite server, installing deterministic browser
// Date and Intl defaults before modules load. Native Chrome input locale is unchanged.
// Run: node scripts/custom-snooze-proof.mjs <vite-port> <fixture-port>
// Open /?proofLocale=en-US (or en-GB), pair normally, then in the preview:
// await import('/__proof/fixture.js'); await proof.seed();
// proof.reset() only unsnoozes the two fixture IDs; proof.cleanup() deletes them.
const upstreamPort = Number(process.argv[2]);
const port = Number(process.argv[3]);
const upstreamHost = process.env.PROOF_UPSTREAM_HOST || "::1";
if (![upstreamPort, port].every((value) => Number.isInteger(value) && value > 1024)) {
  throw new Error("Usage: node scripts/custom-snooze-proof.mjs <vite-port> <fixture-port>");
}

function bootstrap() {
  const requested = new URL(location.href).searchParams.get("proofLocale");
  if (requested) sessionStorage.setItem("proofLocale", requested);
  const locale = sessionStorage.getItem("proofLocale") || "en-US";
  if (!["en-US", "en-GB"].includes(locale)) throw Error("Unsupported proof locale");
  const RealDate = Date;
  const fixed = RealDate.parse("2030-01-15T16:30:00.000Z");
  window.Date = new Proxy(RealDate, {
    construct(target, args) {
      return Reflect.construct(target, args.length ? args : [fixed]);
    },
    apply() {
      return new RealDate(fixed).toString();
    },
    get(target, key) {
      return key === "now" ? () => fixed : Reflect.get(target, key);
    },
  });
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = new Proxy(Original, {
    construct(target, args) {
      return Reflect.construct(target, [args[0] ?? locale, args[1]]);
    },
    apply(target, self, args) {
      return Reflect.apply(target, self, [args[0] ?? locale, args[1]]);
    },
  });
  const trace = [];
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      this.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(event.data);
          if (
            JSON.stringify(message).includes("thread.snoozed") ||
            JSON.stringify(message).includes("thread.unsnoozed")
          ) {
            trace.push({ direction: "projection", at: performance.now(), message });
          }
        } catch {}
      });
    }
    send(data) {
      try {
        const message = JSON.parse(data);
        if (["thread.snooze", "thread.unsnooze"].includes(message.payload?.type)) {
          trace.push({ direction: "command", at: performance.now(), message });
        }
      } catch {}
      return super.send(data);
    }
  };
  window.proof = {
    locale,
    clock: new Date().toISOString(),
    trace,
    NativeSocket,
    runtime: () => ({
      clock: new Date().toISOString(),
      localeEmulation: locale,
      intl: Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).resolvedOptions(),
      nativeLanguage: navigator.language,
      userAgent: navigator.userAgent,
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      visualScale: visualViewport.scale,
      font: getComputedStyle(document.body).font,
      theme: document.documentElement.className,
    }),
  };
}

const fixture = String.raw`
const ids = ["proof-19930-primary", "proof-19930-bulk-peer"];
const names = ["Proof 19930 — primary", "Proof 19930 — bulk peer"];
let socket, sequence = 0;
const pending = new Map();
async function rpc(tag, payload) {
  if (!socket) {
    socket = new proof.NativeSocket(location.origin.replace("http", "ws") + "/ws?orchestrationProtocol=2");
    socket.addEventListener("message", event => {
      const frame = JSON.parse(event.data);
      for (const item of Array.isArray(frame) ? frame : [frame]) {
        if (item._tag === "Exit" && pending.has(String(item.requestId))) {
          const {resolve, reject, timer} = pending.get(String(item.requestId));
          clearTimeout(timer); pending.delete(String(item.requestId));
          item.exit._tag === "Success" ? resolve(item.exit.value) : reject(Error(JSON.stringify(item.exit)));
        }
      }
    });
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  }
  const id = String(++sequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error("RPC deadline: " + tag)); }, 20000);
    pending.set(id, {resolve, reject, timer});
    socket.send(JSON.stringify({_tag:"Request",id,tag,payload,headers:[]}));
  });
}
async function snapshot() {
  const response = await fetch("/api/orchestration/shell", { headers: {"x-t3-orchestration-protocol":"2"} });
  if (!response.ok) throw Error("Shell snapshot HTTP " + response.status);
  return response.json();
}
async function dispatch(command) {
  const result = await rpc("orchestration.dispatchCommand", {commandId:crypto.randomUUID(), ...command});
  proof.trace.push({direction:"fixture-command",at:performance.now(),command,result});
  return result;
}
Object.assign(proof, {
  ids, snapshot, rpc,
  async seed() {
    const state = await snapshot();
    const project = state.projects[0];
    if (!project || state.projects.length !== 1) throw Error("Fixture requires one isolated default project");
    const existing = state.threads[0];
    if (!existing) throw Error("Fixture requires the isolated default stopped thread");
    for (let i=0;i<ids.length;i++) {
      if (!state.threads.some(thread => thread.id === ids[i])) {
        await dispatch({type:"thread.create",threadId:ids[i],projectId:project.id,title:names[i],
          modelSelection:existing.modelSelection,runtimeMode:existing.runtimeMode,interactionMode:"default",
          branch:null,worktreePath:null,createdBy:"user",creationSource:"web"});
      }
    }
    return (await snapshot()).threads.filter(thread => ids.includes(thread.id));
  },
  async reset() {
    for (const thread of (await snapshot()).threads.filter(thread => ids.includes(thread.id))) {
      if (thread.snoozedUntil) await dispatch({type:"thread.unsnooze",threadId:thread.id,reason:"user"});
    }
    return (await snapshot()).threads.filter(thread => ids.includes(thread.id));
  },
  async cleanup() {
    for (const thread of (await snapshot()).threads.filter(thread => ids.includes(thread.id))) {
      await dispatch({type:"thread.delete",threadId:thread.id});
    }
  },
  async settings(timestampFormat) {
    const settings = await import("/src/hooks/useSettings.ts");
    await settings.ensureClientSettingsHydrated();
    await settings.updateClientSettings({timestampFormat});
    return {persisted:JSON.parse(localStorage.getItem("t3code:client-settings:v1")), runtime:proof.runtime()};
  },
});
`;

const server = http.createServer((request, response) => {
  if (request.url === "/__proof/fixture.js") {
    response.writeHead(200, { "content-type": "text/javascript" });
    response.end(fixture);
    return;
  }
  const headers = { ...request.headers, host: `localhost:${upstreamPort}` };
  delete headers["accept-encoding"];
  const upstream = http.request(
    {
      hostname: upstreamHost,
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers,
    },
    (incoming) => {
      if (incoming.headers["content-type"]?.includes("text/html")) {
        let body = "";
        incoming.setEncoding("utf8");
        incoming.on("data", (chunk) => {
          body += chunk;
        });
        incoming.on("end", () => {
          const outputHeaders = { ...incoming.headers };
          delete outputHeaders["content-length"];
          delete outputHeaders["content-security-policy"];
          response.writeHead(incoming.statusCode, outputHeaders);
          response.end(
            body.replace("<head>", `<head><script>(${bootstrap.toString()})()</script>`),
          );
        });
      } else {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      }
    },
  );
  upstream.on("error", () => {
    response.writeHead(502);
    response.end("Fixture upstream unavailable");
  });
  request.pipe(upstream);
});
server.on("upgrade", (request, socket, head) => {
  const upstream = net.connect(upstreamPort, upstreamHost, () => {
    upstream.write(
      `${request.method} ${request.url} HTTP/1.1\r\n` +
        Object.entries({ ...request.headers, host: `localhost:${upstreamPort}` })
          .map(([key, value]) => `${key}: ${value}\r\n`)
          .join("") +
        "\r\n",
    );
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Full-app proof fixture http://localhost:${port}; upstream ${upstreamPort}`),
);
