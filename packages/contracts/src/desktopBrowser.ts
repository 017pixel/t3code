import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

const TabKey = {
  threadId: TrimmedNonEmptyString,
  tabId: TrimmedNonEmptyString,
};

export const DesktopBrowserEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("attached"),
    ...TabKey,
    /**
     * Hosted in a never-shown window rather than a panel `<webview>`, so no
     * panel sizes it and the server must.
     */
    background: Schema.optional(Schema.Boolean),
  }),
  /** Its `<webview>` went away: closed, crashed, swapped, or devtools took the debugger. */
  Schema.Struct({ type: Schema.Literal("detached"), ...TabKey }),
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
]);
export type DesktopBrowserEvent = typeof DesktopBrowserEvent.Type;

export const DesktopBrowserCommand = Schema.Union([
  Schema.Struct({ type: Schema.Literal("cdp"), ...TabKey, message: Schema.String }),
  Schema.Struct({ type: Schema.Literal("release"), ...TabKey }),
  Schema.Struct({
    type: Schema.Literal("pointer"),
    ...TabKey,
    phase: Schema.Literals(["move", "click"]),
    x: Schema.Finite,
    y: Schema.Finite,
  }),
]);
export type DesktopBrowserCommand = typeof DesktopBrowserCommand.Type;
