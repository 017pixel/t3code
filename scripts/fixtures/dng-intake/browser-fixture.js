// CC0-1.0. Browser-only fixture helpers; evaluate through the T3 preview tools.
// These create synthetic File/clipboard/drop metadata, never native OS evidence.
// Reset local draft/theme, reload, then install in an authenticated disposable sandbox.
export function resetCapture(theme = "light") {
  localStorage.setItem("t3code:theme", "t3-chat");
  localStorage.setItem("t3code:theme-follow-system", "false");
  localStorage.setItem("t3code:theme-appearance-mode", theme);
  localStorage.removeItem("t3code:composer-drafts:v1");
  location.reload();
}
export async function installCapture() {
  return await (async () => {
    await document.fonts.ready;
    window.__evidence = { started: performance.now(), events: [], uploads: [], captions: [] };
    const RealDate = window.Date;
    window.__RealDate = RealDate;
    window.Date = class extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : ["2026-10-22T12:00:00.000Z"]));
      }
      static now() {
        return 1792670400000;
      }
    };
    const op = XMLHttpRequest.prototype.open,
      ss = XMLHttpRequest.prototype.send,
      sh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function (method, url, ...args) {
      this.__ev = { method, url, headers: {} };
      return op.call(this, method, url, ...args);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (this.__ev) this.__ev.headers[k] = v;
      return sh.call(this, k, v);
    };
    XMLHttpRequest.prototype.send = function (body) {
      if (this.__ev && String(this.__ev.url).includes("attachment")) {
        const x = this.__ev;
        x.atMs = Math.round(performance.now() - __evidence.started);
        x.body =
          body instanceof Blob
            ? { type: body.type, size: body.size, name: body.name }
            : String(body);
        __evidence.uploads.push(x);
        this.addEventListener("loadend", () => {
          x.status = this.status;
          x.response = this.responseText;
        });
      }
      return ss.call(this, body);
    };
    window.__caption = (text) => {
      let x = document.getElementById("evidence-caption");
      if (!x) {
        x = document.createElement("div");
        x.id = "evidence-caption";
        x.style =
          "position:fixed;left:8px;top:55px;z-index:2147483647;background:#111;color:#fff;padding:5px 8px;font:12px monospace;max-width:calc(100vw - 16px);pointer-events:none";
        document.body.append(x);
      }
      const ms = Math.round(performance.now() - __evidence.started);
      x.textContent = (ms / 1000).toFixed(1) + "s | " + text;
      __evidence.captions.push({ atMs: ms, text });
    };
    return {
      ua: navigator.userAgent,
      uaData: navigator.userAgentData?.toJSON(),
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      zoom: visualViewport.scale,
      locale: navigator.language,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      font: getComputedStyle(document.body).fontFamily,
      fonts: [...document.fonts].map((f) => ({ family: f.family, status: f.status })),
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      scroll: [scrollX, scrollY],
      clock: new Date().toISOString(),
    };
  })();
}
export function installSyntheticEvents() {
  return (() => {
    window.__file = (name = "IMG_3921_7-50-59.DNG", type = "image/x-adobe-dng", size) =>
      new File(
        [
          size === undefined
            ? Uint8Array.from(
                atob(
                  "SUkqAAgAAAANAAABBAABAAAAAgAAAAEBBAABAAAAAgAAAAIBAwABAAAAEAAAAAMBAwABAAAAAQAAAAYBAwABAAAAI4AAABEBBAABAAAAqgAAABUBAwABAAAAAQAAABYBBAABAAAAAgAAABcBBAABAAAACAAAAI2CAwACAAAAAgACAI6CAQAEAAAAAAEBAhLGAQAEAAAAAQQAABPGAQAEAAAAAQEAAAAAAAAAAABAAID//w==",
                ),
                (c) => c.charCodeAt(0),
              )
            : new Uint8Array(size),
        ],
        name,
        { type, lastModified: 0 },
      );
    window.__png = (type = "image/png") =>
      new File(
        [
          Uint8Array.from(
            atob(
              "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGP4z8DAAMIM/4EAAB/uBfsL2WiLAAAAAElFTkSuQmCC",
            ),
            (c) => c.charCodeAt(0),
          ),
        ],
        "control.png",
        { type, lastModified: 0 },
      );
    window.__input = (files, entry = "synthetic input") => {
      const input = document.querySelector("input[type=file]");
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const descriptor = Object.getOwnPropertyDescriptor(input, "files");
      Object.defineProperty(input, "files", { configurable: true, value: dt.files });
      __evidence.events.push({
        entry,
        atMs: Math.round(performance.now() - __evidence.started),
        syntheticMetadata: true,
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
      });
      try {
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        if (descriptor) Object.defineProperty(input, "files", descriptor);
        else delete input.files;
      }
    };
    window.__drop = (files) => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      const target = document.querySelector("[role=textbox][contenteditable=true]");
      const e = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      target.dispatchEvent(e);
      __evidence.events.push({
        entry: "synthetic drop",
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
        prevented: e.defaultPrevented,
        atMs: Math.round(performance.now() - __evidence.started),
      });
    };
    window.__paste = (files, text = "") => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      if (text) dt.setData("text/plain", text);
      const target = document.querySelector("[role=textbox][contenteditable=true]");
      target.focus();
      const e = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: dt });
      target.dispatchEvent(e);
      __evidence.events.push({
        entry: "synthetic paste",
        files: files.map((f) => ({ name: f.name, type: f.type, size: f.size })),
        text,
        prevented: e.defaultPrevented,
        atMs: Math.round(performance.now() - __evidence.started),
      });
      return { prevented: e.defaultPrevented };
    };
    window.__reset = async () => {
      const d = await import("/src/composerDraftStore.ts");
      const [, route, id] = location.pathname.split("/");
      const environmentId =
        route === "draft"
          ? d.useComposerDraftStore.getState().getDraftSession(decodeURIComponent(id))
              ?.environmentId
          : route;
      if (!environmentId) throw new Error("Cannot resolve the active draft environment");
      d.clearComposerDraftsEnvironment(environmentId);
      document.querySelector("[role=textbox][contenteditable=true]")?.focus();
    };
    window.__state = async () => {
      const d = await import("/src/composerDraftStore.ts"),
        u = await import("/src/lib/attachmentUploadQueue.ts");
      return {
        drafts: JSON.parse(
          JSON.stringify(d.useComposerDraftStore.getState().draftsByThreadKey, (k, v) =>
            k === "file" ? undefined : v,
          ),
        ),
        uploads: u.useAttachmentUploadStore.getState().uploadsByImageId,
      };
    };
    // Pass the expected total staged attachments after intake; image preparation is asynchronous.
    window.__settle = async (expectedCount) => {
      if (!Number.isSafeInteger(expectedCount) || expectedCount <= 0) {
        throw new TypeError("__settle requires a positive integer expected attachment count");
      }
      const d = await import("/src/composerDraftStore.ts"),
        u = await import("/src/lib/attachmentUploadQueue.ts");
      return new Promise((resolve) => {
        let unsubscribeDraft = () => {};
        let unsubscribeUpload = () => {};
        const check = () => {
          const files = Object.values(d.useComposerDraftStore.getState().draftsByThreadKey).flatMap(
            (d) => [...(d.files ?? []), ...(d.images ?? [])],
          );
          const s = u.useAttachmentUploadStore.getState().uploadsByImageId;
          if (
            files.length >= expectedCount &&
            files.every((f) => ["ready", "failed"].includes(s[f.id]?.status))
          ) {
            unsubscribeDraft();
            unsubscribeUpload();
            resolve(s);
          }
        };
        unsubscribeDraft = d.useComposerDraftStore.subscribe(check);
        unsubscribeUpload = u.useAttachmentUploadStore.subscribe(check);
        check();
      });
    };
    return "helpers ready: synthetic browser events; no native clipboard/drop assertion";
  })();
}
export function overrideNextPickerMime() {
  return (() => {
    document.querySelector("input[type=file]").addEventListener(
      "change",
      (e) => {
        const original = [...e.target.files];
        const dt = new DataTransfer();
        for (const f of original)
          dt.items.add(new File([f], f.name, { type: "image/x-adobe-dng", lastModified: 0 }));
        const input = e.target;
        const descriptor = Object.getOwnPropertyDescriptor(input, "files");
        Object.defineProperty(input, "files", { configurable: true, value: dt.files });
        // Bubble handlers copy the FileList synchronously before preparing attachments.
        queueMicrotask(() => {
          if (descriptor) Object.defineProperty(input, "files", descriptor);
          else delete input.files;
        });
        __evidence.events.push({
          atMs: Math.round(performance.now() - __evidence.started),
          entry: "picker",
          syntheticMetadata: true,
          original: original.map((f) => ({ name: f.name, type: f.type, size: f.size })),
          effective: [...dt.files].map((f) => ({ name: f.name, type: f.type, size: f.size })),
        });
      },
      { capture: true, once: true },
    );
    return "one-shot metadata override installed; original bytes retained";
  })();
}
