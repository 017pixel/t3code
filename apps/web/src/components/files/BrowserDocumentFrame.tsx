import {
  type KeybindingCommand,
  type KeybindingShortcut,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  THREAD_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import {
  type HtmlRenderShortcut,
  htmlRenderShortcutsMessage,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  htmlRenderResult,
  readHtmlRenderContentHeight,
  readHtmlRenderImageRequest,
  readHtmlRenderKeyDown,
  readHtmlRenderLinkRequest,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import {
  isMacPlatform,
  matchesKeybindingShortcut,
  normalizeEventKey,
} from "@t3tools/shared/keybindings";
import { useState } from "react";

import { useOpenLink } from "~/browser/useOpenLink";
import { ExpandedImageDialog } from "~/components/chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "~/components/chat/ExpandedImagePreview";
import {
  getHtmlRenderTheme,
  subscribeHtmlRenderTheme,
  useHtmlRenderTheme,
} from "~/hooks/useHtmlRenderTheme";
import { shortcutConflictKey } from "~/keybindings";
import { useOpenChangeRequestLink } from "~/lib/openPullRequestLink";
import { readLocalApi } from "~/localApi";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryServerKeybindingsAtom, serverEnvironment } from "~/state/server";

/**
 * The page reports the keys, and a page script can report any key it likes,
 * so only commands that change what the reader sees are here, never one that
 * changes a thread.
 */
const HTML_RENDER_SHORTCUT_COMMANDS: ReadonlySet<KeybindingCommand> = new Set([
  "commandPalette.toggle",
  "filePicker.toggle",
  "projectSearch.toggle",
  "chat.find",
  "sidebar.toggle",
  "rightPanel.toggle",
  "rightPanel.toggleMaximized",
  "threadPanel.toggle",
  "terminal.toggle",
  "preview.toggle",
  "navigation.back",
  "navigation.forward",
  "thread.previous",
  "thread.next",
  ...THREAD_JUMP_KEYBINDING_COMMANDS,
  ...MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
]);

/**
 * The app resolves a replayed key in its live context, so every allowed binding
 * counts whatever its `when`, and a key that any binding gives to another
 * command stays with the page. Only Cmd/Ctrl chords: a printable key would type
 * into the composer instead.
 */
function resolveFrameShortcuts(
  keybindings: ResolvedKeybindingsConfig,
  environmentKeybindings: ResolvedKeybindingsConfig | undefined,
) {
  const mac = isMacPlatform(navigator.platform);
  const resolve = (shortcut: KeybindingShortcut): HtmlRenderShortcut => ({
    key: shortcut.key,
    metaKey: shortcut.metaKey || (shortcut.modKey && mac),
    ctrlKey: shortcut.ctrlKey || (shortcut.modKey && !mac),
    shiftKey: shortcut.shiftKey,
    altKey: shortcut.altKey,
  });
  const blocked = [...keybindings, ...(environmentKeybindings ?? [])]
    .filter((binding) => !HTML_RENDER_SHORTCUT_COMMANDS.has(binding.command))
    .map((binding) => resolve(binding.shortcut));
  const shortcutsByKey = new Map<string, HtmlRenderShortcut>();
  for (const { command, shortcut } of keybindings) {
    if (
      HTML_RENDER_SHORTCUT_COMMANDS.has(command) &&
      (shortcut.metaKey || shortcut.ctrlKey || shortcut.modKey)
    ) {
      shortcutsByKey.set(shortcutConflictKey(shortcut), resolve(shortcut));
    }
  }
  return { shortcuts: [...shortcutsByKey.values()], blocked };
}

export const isPdfPreviewFile = (path: string): boolean =>
  /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

/**
 * HTML runs in a sandboxed frame with an opaque origin, so a page cannot reach
 * the app's session or storage. PDFs use the browser's native viewer.
 */
const postedThemes = new WeakMap<HTMLIFrameElement, HtmlRenderTheme>();

export function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
  readonly htmlRender?: boolean;
  readonly threadRef?: ScopedThreadRef | undefined;
  /** Stable resource identity and revision; defaults to src for callers that reload on URL changes. */
  readonly documentKey?: string | undefined;
}) {
  const key = props.documentKey ?? props.src;
  return props.pdf ? (
    <embed
      key={props.src}
      src={props.src}
      type="application/pdf"
      title={props.title}
      className="min-h-0 w-full flex-1 border-0"
    />
  ) : props.htmlRender ? (
    <HtmlRenderDocument
      key={key}
      src={props.src}
      title={props.title}
      threadRef={props.threadRef}
      className="min-h-0 flex-1"
    />
  ) : (
    <FileDocument key={key} src={props.src} title={props.title} />
  );
}

// URL renewals must not discard form input or scroll; a new key mounts a fresh document.
function FileDocument(props: { readonly src: string; readonly title: string }) {
  const [src] = useState(props.src);
  return (
    <iframe
      src={src}
      title={props.title}
      className="min-h-0 flex-1 border-0 bg-white"
      sandbox="allow-scripts allow-forms allow-popups allow-downloads"
    />
  );
}

/** Keep the initial URL while mounted; re-signing must not reload the page. */
export function HtmlRenderDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onContentHeight?: (height: number) => void;
  /** Reports fullscreen changes so virtualized rows can stay mounted. */
  readonly onFullscreenChange?: ((fullscreen: boolean) => void) | undefined;
}) {
  const theme = useHtmlRenderTheme();
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const [expandedImage, setExpandedImage] = useState<ExpandedImagePreview | null>(null);
  const environmentConfigAtom = serverEnvironment.configValueAtom(
    props.threadRef?.environmentId ?? null,
  );
  const readShortcuts = () =>
    resolveFrameShortcuts(
      appAtomRegistry.get(primaryServerKeybindingsAtom),
      appAtomRegistry.get(environmentConfigAtom)?.keybindings,
    );
  const postTheme = (frame: HTMLIFrameElement) => {
    const next = getHtmlRenderTheme();
    postedThemes.set(frame, next);
    frame.contentWindow?.postMessage(htmlRenderThemeMessage(next), "*");
  };
  const postShortcuts = (frame: HTMLIFrameElement) => {
    const { shortcuts, blocked } = readShortcuts();
    frame.contentWindow?.postMessage(htmlRenderShortcutsMessage(shortcuts, blocked), "*");
  };
  // Pages can forge key/code pairs; reject pairs matching other bindings and require named keys to match the
  // shortcut.
  const isShortcut = (key: NonNullable<ReturnType<typeof readHtmlRenderKeyDown>>) => {
    const { shortcuts, blocked } = readShortcuts();
    const matches = (shortcut: HtmlRenderShortcut) =>
      matchesKeybindingShortcut(key, { ...shortcut, modKey: false }, navigator.platform);
    const allowed = shortcuts.filter(matches);
    return (
      allowed.length > 0 &&
      !blocked.some(matches) &&
      (key.key.length === 1 ||
        key.key === "Dead" ||
        allowed.some((shortcut) => shortcut.key === normalizeEventKey(key.key)))
    );
  };
  const openChangeRequestLink = useOpenChangeRequestLink(props.threadRef);
  const openLink = useOpenLink(props.threadRef);
  const open = (url: string, modifiers: { metaKey: boolean; ctrlKey: boolean }) => {
    if (modifiers.metaKey || modifiers.ctrlKey) {
      void readLocalApi()
        ?.shell.openExternal(url)
        .catch((cause: unknown) => console.error(cause));
      return;
    }
    if (
      props.threadRef !== undefined &&
      openChangeRequestLink(
        { ...modifiers, preventDefault: () => undefined, stopPropagation: () => undefined },
        url,
        undefined,
        props.threadRef.environmentId,
      )
    ) {
      return;
    }
    void openLink(url, { event: modifiers }).catch((cause: unknown) => console.error(cause));
  };
  const { onContentHeight, onFullscreenChange } = props;
  const closeExpandedImage = () => {
    setExpandedImage(null);
    onFullscreenChange?.(false);
  };
  // Attached in the commit that inserts the frame, so a fast page's first height
  // post is not missed. Links, keys and images require frame focus and recent
  // reader activity: a page can take focus by script, so this stops opens on
  // load, though not a page that waits for the reader's next input.
  const attachFrame = (frame: HTMLIFrameElement | null) => {
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) {
        onContentHeight?.(height);
        return;
      }
      if (document.activeElement !== frame || navigator.userActivation?.isActive === false) {
        return;
      }
      const linkRequest = readHtmlRenderLinkRequest(event.data);
      if (linkRequest !== undefined) {
        open(linkRequest.url, linkRequest);
        frame.contentWindow?.postMessage(htmlRenderResult(linkRequest.id), "*");
        return;
      }
      const key = readHtmlRenderKeyDown(event.data);
      if (key !== undefined) {
        if (!isShortcut(key)) return;
        frame.dispatchEvent(
          new KeyboardEvent("keydown", { ...key, bubbles: true, cancelable: true }),
        );
        return;
      }
      // A clicked page image opens in the same viewer as chat images.
      const imageRequest = readHtmlRenderImageRequest(event.data);
      if (imageRequest !== undefined) {
        setExpandedImage({
          images: [{ src: imageRequest.src, name: imageRequest.name }],
          index: 0,
        });
        onFullscreenChange?.(true);
      }
    };
    window.addEventListener("message", onMessage);
    // The first post happens on load; these keep a loaded page in step.
    const unsubscribers = [
      // The store also fires on unrelated settings writes; the theme keeps its
      // identity while equal, so only a real change is posted.
      subscribeHtmlRenderTheme(() => {
        if (postedThemes.get(frame) !== getHtmlRenderTheme()) postTheme(frame);
      }),
      appAtomRegistry.subscribe(primaryServerKeybindingsAtom, () => postShortcuts(frame)),
      appAtomRegistry.subscribe(environmentConfigAtom, () => postShortcuts(frame)),
    ];
    return () => {
      window.removeEventListener("message", onMessage);
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  };
  return (
    <>
      <iframe
        ref={attachFrame}
        src={src}
        title={props.title}
        // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
        sandbox="allow-scripts allow-forms"
        loading="lazy"
        onLoad={(event) => {
          setLoaded(true);
          // Covers a theme change that landed while the page was loading.
          postTheme(event.currentTarget);
          postShortcuts(event.currentTarget);
        }}
        // Match the blank document's scheme to avoid dark-mode white flashes, then follow the app after load.
        className={cn("border-0 scheme-light", props.className)}
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
      {expandedImage !== null ? (
        <ExpandedImageDialog preview={expandedImage} onClose={closeExpandedImage} />
      ) : null}
    </>
  );
}
