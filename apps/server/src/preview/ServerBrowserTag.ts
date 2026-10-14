// @effect-diagnostics deterministicKeys:off -- Preserve the service key while moving its lazy interface.
import {
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewReportProfilesInput,
  type PreviewClearProfileError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Queue from "effect/Queue";
import type * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewManager from "./Manager.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

export type ServerBrowserViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      readonly ack: Effect.Effect<void>;
    }
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly canOperate: boolean;
      readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
      readonly generation: number;
      readonly dialog: {
        readonly type: string;
        readonly message: string;
        readonly defaultValue: string;
      } | null;
    }
  | {
      readonly _tag: "probe";
      readonly x: number;
      readonly y: number;
      readonly editable: boolean;
    }
  | { readonly _tag: "clipboard"; readonly text: string }
  | {
      readonly _tag: "pointer";
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
      readonly sequence: number;
    }
  | {
      readonly _tag: "fileChooser";
      readonly id: string;
      readonly multiple: boolean;
      readonly accept: string;
    }
  | { readonly _tag: "fileChooserClosed"; readonly id: string }
  /** The page this viewer controls opened a new tab; the viewer shows it, as a browser would. */
  | { readonly _tag: "popup"; readonly tabId: string }
  | {
      readonly _tag: "download";
      readonly id: string;
      readonly fileName: string;
      readonly sizeBytes: number;
    }
  | { readonly _tag: "gone" }
  /** The page is still open, but this connection to it ended; the viewer reconnects. */
  | { readonly _tag: "reconnect" };

export interface ServerBrowserViewer {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
}

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;
    /**
     * Gives a page's open file picker the files a viewer uploaded, by path, and
     * closes it. No files cancels the pick. False when that picker is gone.
     */
    readonly answerFileChooser: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly chooserId: string;
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly buffer: Buffer;
      }>;
    }) => Effect.Effect<boolean>;
    /** A finished download of a live tab, for the authenticated download route. */
    readonly openDownload: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly downloadId: string;
    }) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;
    /** Deletes a human profile's server-side storage, closing its open tabs first. */
    readonly clearProfile: (profileId: string) => Effect.Effect<void, PreviewClearProfileError>;
    /**
     * Records a client's browser profiles for agents' preview_open. In memory:
     * clients report again on connect and whenever the list changes.
     */
    readonly reportProfiles: (input: PreviewReportProfilesInput) => Effect.Effect<void>;
  }
>()("t3/preview/ServerBrowser") {}

const make = Effect.gen(function* () {
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const manager = yield* PreviewManager.PreviewManager;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  let current: Effect.Success<typeof import("./ServerBrowser.ts").make> | undefined;
  let connectionId: string | undefined;
  let profiles: PreviewReportProfilesInput | undefined;
  const live = yield* cacheInOwnerScope(
    Effect.promise(() => import("./ServerBrowser.ts")).pipe(
      Effect.flatMap((module) => module.make),
      Effect.tap((value) =>
        Effect.gen(function* () {
          current = value;
          if (connectionId !== undefined) yield* value.onHostConnected(connectionId);
          if (profiles !== undefined) yield* value.service.reportProfiles(profiles);
        }),
      ),
    ),
  );
  // Register the host before anyone uses it; acquisition waits for its first request or tab.
  const environmentId = yield* environment.getEnvironmentId;
  const hostSession = broker
    .connect(
      {
        clientId: SERVER_BROWSER_AUTOMATION_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") {
              connectionId = event.connectionId;
              return current?.onHostConnected(event.connectionId) ?? Effect.void;
            }
            return live.pipe(
              Effect.flatMap((value) => value.handleRequest(event.connectionId, event.request)),
              Effect.forkScoped,
              Effect.asVoid,
            );
          }),
        ),
      ),
    );
  yield* hostSession.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep("1 second")),
    Effect.forever,
    Effect.forkScoped,
  );
  // A failed load costs only its event: the next one loads it again.
  yield* manager.events.pipe(
    Stream.runForEach((event) =>
      live.pipe(
        Effect.flatMap((value) => value.mirrorManagerEvent(event)),
        Effect.ignoreCause({ log: true }),
      ),
    ),
    Effect.forkScoped,
  );
  // The channel drops attaches nobody listens for, so listen from boot: a
  // desktop that restores its tabs at startup gets them driven again.
  yield* desktopChannel.attached.pipe(
    Stream.runForEach((key) =>
      live.pipe(
        Effect.flatMap((value) => value.reconnectDesktopTab(key)),
        Effect.ignoreCause({ log: true }),
      ),
    ),
    Effect.forkScoped,
  );
  // Whoever runs the server learns the fix before anyone opens a tab, without loading the browser.
  yield* Effect.gen(function* () {
    if (
      PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment) ||
      !(yield* PreviewBrowserHost.sandboxBlocked)
    ) {
      return;
    }
    const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);
    yield* Effect.logWarning(
      `This host blocks the sandbox T3's browser runs in, so browser tabs and HTML previews will not start. Run \`${setupCommand}\` once to allow it.`,
    );
  }).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);
  return ServerBrowser.of({
    attachViewer: (input) =>
      live.pipe(Effect.flatMap((value) => value.service.attachViewer(input))),
    answerFileChooser: (input) =>
      live.pipe(Effect.flatMap((value) => value.service.answerFileChooser(input))),
    openDownload: (input) =>
      live.pipe(Effect.flatMap((value) => value.service.openDownload(input))),
    clearProfile: (profileId) =>
      live.pipe(Effect.flatMap((value) => value.service.clearProfile(profileId))),
    reportProfiles: (input) =>
      Effect.suspend(() => {
        profiles = input;
        return current?.service.reportProfiles(input) ?? Effect.void;
      }),
  });
});
export const layer = Layer.effect(ServerBrowser, make);
