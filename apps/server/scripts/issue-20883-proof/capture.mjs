// T3 functions orchestration adapter. Supply the exposed tools and one public fixture config.
export async function capture(tools, { tabId, config }) {
  const results = [];
  const load = (k) =>
    k === "tab" ? tabId : k === "captureCfg" ? config : k === "records" ? [] : undefined;
  const store = () => {};
  const text = (v) => results.push(v);
  const tab = load("tab");
  const cfg = load("captureCfg");
  const events = [];
  const mark = (action) => events.push({ action, at: new Date().toISOString() });
  const check = (r) => {
    if (r.isError) throw Error(JSON.stringify(r));
    return r.structuredContent?.value ?? r.structuredContent;
  };
  const ensureSidebar = async () => {
    const visible = check(
      await tools.mcp__t3_code__preview_evaluate({
        tabId: tab,
        expression:
          "[...document.querySelectorAll('[data-testid=sidebar-row-card]')].some(n=>n.checkVisibility() && n.getBoundingClientRect().x>=0)",
      }),
    );
    if (!visible)
      check(
        await tools.mcp__t3_code__preview_click({
          tabId: tab,
          selector: 'button:has-text("Toggle Sidebar")',
        }),
      );
  };
  mark("prepare");
  await ensureSidebar();
  check(
    await tools.mcp__t3_code__preview_evaluate({
      tabId: tab,
      expression:
        "document.querySelectorAll('button[aria-label=\"Dismiss notification\"]').forEach(b=>b.click());",
    }),
  );
  check(
    await tools.mcp__t3_code__preview_click({
      tabId: tab,
      selector: '[role="button"][aria-label^="Quiet destination,"]',
    }),
  );
  check(
    await tools.exec_command({
      cmd:
        "python3 - <<'PY'\nfrom pathlib import Path\nPath('/tmp/issue-20883-gate').unlink(missing_ok=True)\nPath('/tmp/issue-20883-gate.ready').unlink(missing_ok=True)\nPath('/tmp/issue-20883-clock').write_text('" +
        cfg.clock +
        "')\nPY",
      max_output_tokens: 100,
    }),
  );
  const sent = check(
    await tools.mcp__t3_code__preview_evaluate({
      tabId: tab,
      expression: "proof.send('proof-" + cfg.kind + "','" + cfg.kind + "')",
    }),
  );
  if (sent._tag !== "Success") throw Error(JSON.stringify(sent));
  const ready = await tools.exec_command({
    cmd: "python3 - <<'PY'\nimport time,pathlib\np=pathlib.Path('/tmp/issue-20883-gate.ready')\nt=time.monotonic()+15\nwhile not p.exists() and time.monotonic()<t:time.sleep(.05)\nassert p.exists(), 'fixture not ready'\nprint(p.read_text())\nPY",
    max_output_tokens: 100,
  });
  if (ready.exit_code !== 0) throw Error(ready.output);
  const start = check(await tools.mcp__t3_code__preview_recording_start({ tabId: tab }));
  mark("recording start");
  check(await tools.exec_command({ cmd: "touch /tmp/issue-20883-gate", max_output_tokens: 100 }));
  mark("provider release");
  check(
    await tools.mcp__t3_code__preview_wait_for({ tabId: tab, text: cfg.title, timeoutMs: 12000 }),
  );
  mark("toast visible");
  check(
    await tools.mcp__t3_code__preview_hover({
      tabId: tab,
      selector: 'button:has-text("Open thread")',
    }),
  );
  mark("hover expands notification");
  check(
    await tools.mcp__t3_code__preview_evaluate({
      tabId: tab,
      expression: "new Promise(r=>setTimeout(r,650))",
    }),
  );
  if (cfg.action === "sidebar" || cfg.action === "keyboard") await ensureSidebar();
  const pre = check(await tools.mcp__t3_code__preview_snapshot({ tabId: tab, save: true }));
  mark("pre checkpoint");
  if (cfg.action === "sidebar" || cfg.action === "keyboard") await ensureSidebar();
  if (cfg.action === "unmount") {
    check(
      await tools.mcp__t3_code__preview_evaluate({
        tabId: tab,
        expression:
          "(async()=>{const s=await import('/src/hooks/useSettings.ts');await s.updateClientSettings({inAppNotificationsEnabled:false,notificationMode:'off'});await new Promise(r=>setTimeout(r,100));await s.updateClientSettings({inAppNotificationsEnabled:true});await new Promise(r=>setTimeout(r,100));})()",
      }),
    );
    mark("disable then re-enable notifications, unmount/remount");
    await ensureSidebar();
    {
      const p = check(
        await tools.mcp__t3_code__preview_evaluate({
          tabId: tab,
          expression:
            "(()=>{const n=[...document.querySelectorAll('[data-testid=sidebar-row-card]')].find(n=>n.getAttribute('aria-label').startsWith(" +
            JSON.stringify(cfg.prefix + ",") +
            "));const r=n.getBoundingClientRect();return {x:r.x+3,y:r.bottom-10}})()",
        }),
      );
      check(await tools.mcp__t3_code__preview_click({ tabId: tab, x: p.x, y: p.y }));
    }
    mark("navigate after remount");
  } else if (cfg.action === "dismiss") {
    check(
      await tools.mcp__t3_code__preview_click({
        tabId: tab,
        selector: 'button[aria-label="Dismiss notification"]',
      }),
    );
    mark("manual dismiss");
  } else if (cfg.action === "expiry") {
    mark("wait natural expiry 7 seconds");
    check(
      await tools.mcp__t3_code__preview_hover({
        tabId: tab,
        selector: 'button:has-text("Toggle Sidebar")',
      }),
    );
    check(
      await tools.mcp__t3_code__preview_evaluate({
        tabId: tab,
        expression: "new Promise(r=>setTimeout(r,7000))",
      }),
    );
  } else if (cfg.action === "toast-action") {
    check(
      await tools.mcp__t3_code__preview_click({
        tabId: tab,
        selector: 'button:has-text("Open thread")',
      }),
    );
    mark("toast Open thread action");
  } else if (cfg.action === "keyboard") {
    const idx = check(
      await tools.mcp__t3_code__preview_evaluate({
        tabId: tab,
        expression:
          "[...document.querySelectorAll('[data-testid=sidebar-row-card]')].findIndex(x=>x.getAttribute('aria-label').startsWith(" +
          JSON.stringify(cfg.prefix + ",") +
          "))+1",
      }),
    );
    const binding = check(
      await tools.mcp__t3_code__preview_evaluate({
        tabId: tab,
        expression:
          "proof.rpc('server.upsertKeybinding',{key:'ctrl+alt+shift+9',command:'thread.jump." +
          idx +
          "'})",
      }),
    );
    if (binding._tag !== "Success") throw Error(JSON.stringify(binding));
    check(
      await tools.mcp__t3_code__preview_press({
        tabId: tab,
        key: "9",
        modifiers: ["Control", "Alt", "Shift"],
      }),
    );
    mark("configured thread.jump." + idx + " keyboard");
  } else {
    {
      const p = check(
        await tools.mcp__t3_code__preview_evaluate({
          tabId: tab,
          expression:
            "(()=>{const n=[...document.querySelectorAll('[data-testid=sidebar-row-card]')].find(n=>n.getAttribute('aria-label').startsWith(" +
            JSON.stringify(cfg.prefix + ",") +
            "));const r=n.getBoundingClientRect();return {x:r.x+3,y:r.bottom-10}})()",
        }),
      );
      check(await tools.mcp__t3_code__preview_click({ tabId: tab, x: p.x, y: p.y }));
    }
    mark("sidebar open target");
  }
  check(
    await tools.mcp__t3_code__preview_evaluate({
      tabId: tab,
      expression: "new Promise(r=>setTimeout(()=>r(location.pathname),1200))",
    }),
  );
  const post = check(await tools.mcp__t3_code__preview_snapshot({ tabId: tab, save: true }));
  mark("post checkpoint");
  const state = check(
    await tools.mcp__t3_code__preview_evaluate({
      tabId: tab,
      expression:
        "({url:location.pathname,toast:document.body.innerText.includes(" +
        JSON.stringify(cfg.title) +
        "),pending:proof.snapshot().threads.find(t=>t.id==='proof-" +
        cfg.kind +
        "')?.pendingRuntimeRequest})",
    }),
  );
  const video = check(await tools.mcp__t3_code__preview_recording_stop({ tabId: tab }));
  mark("recording stop");
  const result = { ...cfg, start, pre, post, state, video, events };
  store("records", [...load("records"), result]);
  const dst = "/tmp/issue-20883-evidence/" + cfg.phase + "-" + cfg.cell + "-" + cfg.row;
  const cmd =
    "python3 - <<'PY'\nimport shutil,json\nr=" +
    JSON.stringify(JSON.stringify(result)) +
    "\nd=json.loads(r)\np=" +
    JSON.stringify(dst) +
    '\nfor key,suffix in [("pre","-pre.png"),("post","-post.png"),("video",".mp4")]:shutil.copy2(d[key].get("screenshotPath",d[key].get("path")),p+suffix)\nopen(p+".json","w").write(json.dumps(d,indent=2))\nPY';
  text(await tools.exec_command({ cmd, max_output_tokens: 100 }));
  text({ row: cfg.row, cell: cfg.cell, state });
  return result;
}
