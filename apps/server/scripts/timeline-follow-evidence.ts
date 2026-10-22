// @effect-diagnostics nodeBuiltinImport:off - Evidence driver for timeline follow captures.
// Drives a running isolated dev server through headless Chromium (Playwright from the given
// worktree) for the PR #22788 matrix: W1 (PageUp), W1p (PageUp + pill), W2 (wheel), W3 (no input),
// and ST (stills). Thread hydration is delayed by a labelled test-driver WebSocket hold injected
// with addInitScript; no app source changes. Run it from outside the worktree:
//   node timeline-follow-evidence.ts --wt <worktree> --home <home> --bar <barrier-root> \
//     --ws <workspace> --row W1 --out <dir> [--width 1440 --height 900 --scheme light --video]
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i++) {
  const key = process.argv[i]!.replace(/^--/, "");
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith("--")) args.set(key, "1");
  else args.set(key, process.argv[++i]!);
}
const need = (key: string) => {
  const value = args.get(key);
  if (!value) throw new Error(`missing --${key}`);
  return NodePath.resolve(value);
};
const wt = NodeFS.realpathSync(need("wt"));
const home = need("home");
const barRoot = need("bar");
const ws = need("ws");
const out = need("out");
const row = args.get("row") ?? "W1";
const width = Number(args.get("width") ?? 1440);
const height = Number(args.get("height") ?? 900);
const scheme = (args.get("scheme") ?? "light") as "light" | "dark";
const video = args.has("video");
// Also hold the HTTP thread snapshot (GET /api/orchestration/threads/<id>...), which this
// client loads before it opens orchestration.subscribeThread.
const holdHttp = args.has("hold-http");
const holdMs = Number(args.get("hold-ms") ?? 2500);
const minFrames = Number(args.get("min-frames") ?? 30);
NodeFS.mkdirSync(out, { recursive: true });

// TEST-DRIVER INJECTION: identical on both revisions. Holds the fixture thread's
// orchestration.subscribeThread frames until __fx.release(), counts RAF ticks during the
// hold, and logs the timeline follow listeners by function name (Vite dev keeps names).
export const holdScript = String.raw`(() => {
  const fx = (window.__fx = { holdThreadId: null, held: [], ids: new Set(), holding: false,
    frames: 0, holdStartedAt: null, releasedAt: null, listeners: [], marks: [], sockets: new Set() });
  const tick = () => { if (fx.holding) fx.frames++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  fx.mark = (name) => fx.marks.push({ name, t: performance.now() });
  const NativeWS = window.WebSocket;
  const matches = (raw) => { try { const m = JSON.parse(raw); return (Array.isArray(m) ? m : [m])
    .some((x) => x && fx.ids.has(String(x.requestId))); } catch { return false; } };
  class HoldWS extends NativeWS {
    send(data) {
      try { for (const m of [].concat(JSON.parse(data))) if (m?._tag === "Request" &&
        m.tag === "orchestration.subscribeThread" && fx.holdThreadId &&
        JSON.stringify(m.payload).includes(fx.holdThreadId)) {
          fx.ids.add(String(m.id)); fx.holding = true; fx.frames = 0;
          fx.holdStartedAt = performance.now(); fx.mark("hold-start"); } } catch {}
      return super.send(data);
    }
    constructor(...a) { super(...a);
      super.addEventListener("message", (e) => { if (fx.holding && matches(e.data)) {
        e.stopImmediatePropagation(); fx.held.push({ socket: this, data: e.data }); } }, { capture: true }); }
  }
  fx.release = () => { fx.holding = false; fx.holdThreadId = null; fx.releasedAt = performance.now(); fx.mark("hold-release");
    for (const h of fx.held.splice(0)) h.socket.dispatchEvent(new MessageEvent("message", { data: h.data })); };
  fx.httpHoldStart = () => { if (fx.holding) return; fx.holding = true; fx.frames = 0;
    fx.holdStartedAt = performance.now(); fx.mark("hold-start"); };
  window.WebSocket = new Proxy(HoldWS, { construct(T, a) { const s = new T(...a); fx.sockets.add(s); return s; } });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  const log = (op) => function (type, fn, o) {
    if (fn && /^handle(Wheel|TouchMove|PointerDown|Scroll|KeyDown)$/.test(fn.name))
      fx.listeners.push({ op, type, name: fn.name, t: performance.now(),
        target: this === document ? "document" : (this.closest?.("[data-assistant-citation-viewport]") ? "timeline" : "other") });
    return (op === "add" ? add : rem).call(this, type, fn, o); };
  EventTarget.prototype.addEventListener = log("add");
  EventTarget.prototype.removeEventListener = log("remove");
})();`;

const measure = `() => { const v = document.querySelector('[data-assistant-citation-viewport]');
  const n = [...(v?.querySelectorAll('*') ?? [])].find(e => /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
  const p = [...document.querySelectorAll('p')].find(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && /^Paragraph \\d{3}\\./.test(e.textContent); });
  return { top: n?.scrollTop, height: n?.scrollHeight, client: n?.clientHeight,
    gap: n ? n.scrollHeight - n.scrollTop - n.clientHeight : null,
    pill: !!document.querySelector('button[aria-label="Scroll to end"]'),
    firstVisible: p?.textContent.slice(0, 13), firstVisibleY: p?.getBoundingClientRect().top,
    timelineListeners: __fx.listeners.filter(l => l.target === 'timeline' && l.op === 'add').length
                     - __fx.listeners.filter(l => l.target === 'timeline' && l.op === 'remove').length,
    docKeydown: __fx.listeners.filter(l => l.name === 'handleKeyDown' && l.op === 'add').length
              - __fx.listeners.filter(l => l.name === 'handleKeyDown' && l.op === 'remove').length,
    loading: !!document.querySelector('[data-timeline-loading="true"]'),
    frames: __fx.frames, t: performance.now() }; }`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check: () => boolean | Promise<boolean>, label: string, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(20);
  }
};
const cli = (script: string, cliArgs: string[]) => {
  const result = NodeChildProcess.spawnSync(process.execPath, [script, ...cliArgs], {
    cwd: wt,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${script} ${cliArgs[0]} failed: ${result.stderr}`);
  return result.stdout;
};

// Seed a fresh long thread through the real ACP mock and deliver its entry phase.
const barriersBefore = new Set(NodeFS.existsSync(barRoot) ? NodeFS.readdirSync(barRoot) : []);
const fixture = NodePath.join(wt, "apps/server/scripts/timeline-follow-fixture.ts");
let seedStderr = "";
const seedOutput = cli(fixture, ["seed", home, ws, "timeline_fixture", "long"]);
if (!seedOutput.trim()) throw new Error("seed printed nothing: " + seedStderr);
const seed = JSON.parse(seedOutput);
const threadId: string = seed.threadId;
let barrier = "";
await until(() => {
  const fresh = NodeFS.readdirSync(barRoot).filter((name) => !barriersBefore.has(name));
  barrier = fresh.length === 1 ? NodePath.join(barRoot, fresh[0]!) : "";
  return barrier !== "" && NodeFS.existsSync(NodePath.join(barrier, "waiting.json"));
}, "barrier");
const release = async (phase: string) => {
  NodeFS.writeFileSync(NodePath.join(barrier, `${phase}.release`), "release\n");
  await until(() => NodeFS.existsSync(NodePath.join(barrier, `${phase}.done`)), `${phase}.done`);
};
await release("entry");

const pairOutput = cli(NodePath.join(wt, "apps/server/src/bin.ts"), ["pair", "--base-dir", home]);
// oxlint-disable-next-line no-control-regex -- strips ANSI color codes from the pair CLI output
const pairUrl = pairOutput.replace(/\x1b\[[0-9;]*m/g, "").match(/https?:\/\/\S*\/pair\S*/)?.[0];
if (!pairUrl) throw new Error("no pair URL");

const require = NodeModule.createRequire(
  NodePath.join(wt, "node_modules/.pnpm/playwright@1.60.0/node_modules/playwright/package.json"),
);
const { chromium } = require("playwright");
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  colorScheme: scheme,
  reducedMotion: "no-preference",
  locale: "en-US",
  timezoneId: "UTC",
  ...(video ? { recordVideo: { dir: out, size: { width, height } } } : {}),
});
await context.addInitScript(holdScript);
const page = await context.newPage();
const videoStartWall = Date.now();
await page.clock.setFixedTime(new Date("2026-01-01T12:00:00.000Z"));

type Sample = Record<string, unknown> & { mark: string; clip: number };
const samples: Sample[] = [];
const marks: Array<{ name: string; clip: number; index: number }> = [];
const m = async (label: string) => {
  const sample = {
    mark: label,
    clip: (Date.now() - videoStartWall) / 1000,
    ...(await page.evaluate(`(${measure})()`)),
  };
  samples.push(sample);
  return sample as Sample & Record<string, number & boolean & string>;
};
// Recording-only overlay: mark name, clip time, and a solid color block whose color encodes
// the mark index so frame extraction can verify each mark without OCR.
const markColor = (index: number) => [
  (index * 73) % 256,
  (index * 151 + 60) % 256,
  (index * 37 + 120) % 256,
];
const mark = async (name: string) => {
  const clip = (Date.now() - videoStartWall) / 1000;
  const index = marks.length + 1;
  marks.push({ name, clip, index });
  if (video) {
    const [r, g, b] = markColor(index);
    await page.evaluate(
      ([text, color]: [string, string]) => {
        let el = document.getElementById("__ev_overlay");
        if (!el) {
          el = document.createElement("div");
          el.id = "__ev_overlay";
          el.setAttribute(
            "style",
            "position:fixed;right:4px;bottom:4px;z-index:2147483647;pointer-events:none;font:12px monospace;background:#000;color:#fff;padding:2px 4px;display:flex;gap:4px;align-items:center",
          );
          document.documentElement.appendChild(el);
        }
        el.innerHTML = `<span style="display:inline-block;width:24px;height:24px;background:${color}"></span><span>${text}</span>`;
      },
      [`${name} t=${clip.toFixed(1)}s`, `rgb(${r},${g},${b})`],
    );
  }
};
const shot = async (name: string) => {
  if (!video) await page.screenshot({ path: NodePath.join(out, `${name}.png`) });
};
const clickText = async (text: string) => {
  const target = page.getByText(text, { exact: true }).first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`no box for ${text}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
};
const raf = (count: number) =>
  page.evaluate(
    (n: number) =>
      new Promise<void>((resolve) => {
        const step = (left: number) =>
          left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
        step(n);
      }),
    count,
  );

const result: Record<string, unknown> = {
  row,
  threadId,
  runId: seed.runId,
  barrier,
  width,
  height,
  scheme,
};
try {
  await page.goto(pairUrl);
  await page
    .getByText("Timeline fixture short", { exact: true })
    .first()
    .waitFor({ state: "attached", timeout: 120_000 });
  await clickText("Timeline fixture short");
  await page.getByText("The harbor is quiet.").first().waitFor({ timeout: 30_000 });
  await page
    .getByText("Timeline fixture long", { exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await sleep(500);
  await page.evaluate((id: string) => ((window as any).__fx.holdThreadId = id), threadId);
  let releaseHttp = () => {};
  const httpGate = new Promise<void>((resolve) => (releaseHttp = resolve));
  const httpHeld: string[] = [];
  if (holdHttp) {
    await page.route(
      (url: URL) =>
        url.pathname.startsWith(`/api/orchestration/threads/${encodeURIComponent(threadId)}`),
      async (route: any) => {
        httpHeld.push(
          new URL(route.request().url()).pathname.replace(encodeURIComponent(threadId), "<thread>"),
        );
        await page.evaluate(() => (window as any).__fx.httpHoldStart()).catch(() => {});
        await httpGate;
        await route.continue();
      },
    );
  }

  await mark("nav");
  const navAt = await page.evaluate(() => performance.now());
  await clickText("Timeline fixture long");
  await until(() => page.evaluate(() => (window as any).__fx.holding), "hold-start", 10_000);
  const holdStart = await page.evaluate(() => (window as any).__fx.holdStartedAt);
  await mark("hold-start");
  await sleep(100);
  const loadingAt100 = await page.evaluate(
    () => !!document.querySelector('[data-timeline-loading="true"]'),
  );
  const titleInHeader = await page.evaluate(() =>
    [...document.querySelectorAll("body *")].some((e) => {
      const r = e.getBoundingClientRect();
      return (
        e.children.length === 0 &&
        e.textContent?.trim() === "Timeline fixture long" &&
        r.top < 60 &&
        r.left > 260
      );
    }),
  );
  await shot("C-hold");
  const holdBegan = Date.now();
  await until(
    async () =>
      Date.now() - holdBegan >= holdMs - 100 &&
      (await page.evaluate(() => (window as any).__fx.frames)) >= minFrames,
    "hold frames",
    20_000,
  );
  const loadingBeforeRelease = await page.evaluate(
    () => !!document.querySelector('[data-timeline-loading="true"]'),
  );
  const hold = await page.evaluate(() => {
    const fx = (window as any).__fx;
    const frames = fx.frames;
    fx.release();
    return { frames, ms: fx.releasedAt - fx.holdStartedAt, wsRequestsHeld: fx.ids.size };
  });
  releaseHttp();
  await mark("hold-release");
  result.hydration = {
    mechanism: holdHttp
      ? "TEST-DRIVER hold: HTTP thread snapshot route + WS subscribeThread frames"
      : "TEST-DRIVER hold: WS subscribeThread frames only",
    httpHeld,
    navAt,
    holdStart,
    holdAfterNav: holdStart > navAt,
    loadingAt100,
    loadingBeforeRelease,
    titleInHeader,
    ...hold,
  };

  await page
    .getByText("Paragraph 100.", { exact: false })
    .first()
    .waitFor({ state: "attached", timeout: 30_000 });
  await raf(10);
  await mark("mounted");
  let mounted = await m("mounted");
  if (Number(mounted.gap) > 2) {
    await page.keyboard.press("End");
    await sleep(600);
    mounted = await m("mounted-end");
  }
  await shot("C-mounted");

  if (row === "W2") {
    await page.mouse.move(720, 400);
    await mark("move");
    await mark("wheel");
    await page.mouse.wheel(0, -600);
    await sleep(150);
    await page.mouse.wheel(0, -600);
    await sleep(400);
    await m("S_up");
  } else if (row !== "W3") {
    await mark("click-prose");
    await page.mouse.click(720, 400);
    await sleep(200);
    await mark("pageup");
    await page.keyboard.press("PageUp");
    await sleep(300);
    await page.keyboard.press("PageUp");
    await sleep(400);
    await m("S_up");
  }
  for (const phase of ["tool-start", "tool-finish", "prose"]) {
    await mark(phase);
    await release(phase);
    await sleep(500);
    await m(phase === "prose" ? "S_hold" : phase);
  }
  await shot("C-held");
  if (row === "W1") {
    await mark("end");
    await page.keyboard.press("End");
    await sleep(600);
    await m("end");
  } else if (row === "W1p" || row === "W2") {
    await mark("pill");
    const pillLocator = page.locator('button[aria-label="Scroll to end"]');
    const pill = (await pillLocator.count()) > 0 ? await pillLocator.first().boundingBox() : null;
    if (pill) await page.mouse.click(pill.x + pill.width / 2, pill.y + pill.height / 2);
    await sleep(600);
    await m(pill ? "pill" : "pill-absent");
  }
  await mark("resumed");
  await release("resumed");
  await sleep(500);
  await m("S_res");
  await mark("done");
  await sleep(500);
} catch (error) {
  result.error = String(error);
  await page.screenshot({ path: NodePath.join(out, "error.png") }).catch(() => {});
} finally {
  result.listeners = await page.evaluate(() => (window as any).__fx.listeners).catch(() => null);
  result.pageMarks = await page.evaluate(() => (window as any).__fx.marks).catch(() => null);
  const videoHandle = video ? page.video() : null;
  await context.close();
  result.browserVersion = browser.version();
  await browser.close();
  if (videoHandle) result.video = await videoHandle.path();
  result.samples = samples;
  result.marks = marks.map((entry) => ({ ...entry, color: markColor(entry.index) }));
  result.holdSha256 = NodeCrypto.createHash("sha256").update(holdScript).digest("hex");
  NodeFS.writeFileSync(
    NodePath.join(out, "marks.tsv"),
    "clip_s\tindex\tmark\n" +
      marks.map((entry) => `${entry.clip.toFixed(2)}\t${entry.index}\t${entry.name}`).join("\n") +
      "\n",
  );
  NodeFS.writeFileSync(NodePath.join(out, "result.json"), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({ row, out, error: result.error ?? null, hydration: result.hydration }),
  );
}
