import { Editor, type EditorOptions } from "@tiptap/core";
import { PureEditorContent, type EditorContentProps } from "@tiptap/react";
import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type DependencyList,
  type ReactNode,
  type RefObject,
} from "react";

import { PortalContainerContext, useOwnPortalContainer } from "~/lib/portalContainer";

/** Activity runs cleanups on hide; held resources release only on eviction or unmount. */
export interface KeptViewLifetime {
  /** Runs `release` when the kept view goes away. Returns a function that cancels it. */
  hold(release: () => void): () => void;
}

export const KeptViewLifetimeContext = createContext<KeptViewLifetime | null>(null);

export function createKeptViewLifetime(): KeptViewLifetime & { dispose(): void } {
  const held = new Set<() => void>();
  let disposed = false;
  return {
    hold(release) {
      if (disposed) {
        release();
        return () => undefined;
      }
      held.add(release);
      return () => {
        held.delete(release);
      };
    },
    dispose() {
      disposed = true;
      const releases = [...held];
      held.clear();
      for (const release of releases) release();
    },
  };
}

export function createKeptViewLifetimes() {
  const lifetimes = new Map<string, ReturnType<typeof createKeptViewLifetime>>();
  return {
    get(key: string): KeptViewLifetime {
      let lifetime = lifetimes.get(key);
      if (lifetime === undefined) {
        lifetime = createKeptViewLifetime();
        lifetimes.set(key, lifetime);
      }
      return lifetime;
    },
    retain(keys: ReadonlySet<string>) {
      for (const [key, lifetime] of lifetimes) {
        if (keys.has(key)) continue;
        lifetimes.delete(key);
        lifetime.dispose();
      }
    },
  };
}

const EDITOR_CALLBACK_KEYS = [
  "onBeforeCreate",
  "onCreate",
  "onUpdate",
  "onSelectionUpdate",
  "onTransaction",
  "onFocus",
  "onBlur",
  "onDestroy",
  "onContentError",
  "onDrop",
  "onPaste",
  "onDelete",
  "onMount",
  "onUnmount",
] as const;

type EditorCallbackKey = (typeof EDITOR_CALLBACK_KEYS)[number];

function forwardCallback<K extends EditorCallbackKey>(
  options: RefObject<Partial<EditorOptions>>,
  key: K,
): EditorOptions[K] {
  type Callback = (...args: Parameters<EditorOptions[K]>) => void;
  const forwarded: Callback = (...args) => {
    const callback = options.current[key] as Callback | undefined;
    callback?.(...args);
  };
  return forwarded as EditorOptions[K];
}

function createForwardingEditor(options: RefObject<Partial<EditorOptions>>): Editor {
  const callbacks: Partial<EditorOptions> = {};
  for (const key of EDITOR_CALLBACK_KEYS) {
    Object.assign(callbacks, { [key]: forwardCallback(options, key) });
  }
  return new Editor({ ...options.current, ...callbacks });
}

// Matches @tiptap/react's useEditor: callbacks are forwarded, so only the
// remaining options decide whether the editor needs `setOptions`.
function editorOptionsMatch(next: Partial<EditorOptions>, current: Partial<EditorOptions>) {
  return (Object.keys(next) as Array<keyof EditorOptions>).every((key) => {
    if ((EDITOR_CALLBACK_KEYS as ReadonlyArray<string>).includes(key)) return true;
    if (key === "extensions" && next.extensions && current.extensions) {
      const currentExtensions = current.extensions;
      return (
        next.extensions.length === currentExtensions.length &&
        next.extensions.every((extension, index) => extension === currentExtensions[index])
      );
    }
    return next[key] === current[key];
  });
}

interface KeptEditorInstance {
  editor: Editor;
  deps: DependencyList;
  mounted: boolean;
  cancelDestroy: (() => void) | null;
}

function destroyUnlessMounted(instance: KeptEditorInstance) {
  if (!instance.mounted && !instance.editor.isDestroyed) instance.editor.destroy();
}

function destroyAfter(instance: KeptEditorInstance, delayMs: number) {
  const timeout = setTimeout(() => destroyUnlessMounted(instance), delayMs);
  return () => clearTimeout(timeout);
}

// Allow transition renders to commit before freeing abandoned editors.
const UNCOMMITTED_EDITOR_GRACE_MS = 5_000;

/** Preserves the editor and undo history across Activity hides; changed deps recreate it. */
export function useKeptEditor(options: Partial<EditorOptions>, deps: DependencyList): Editor {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const lifetime = useContext(KeptViewLifetimeContext);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [instance] = useState(() => {
    const created: KeptEditorInstance = {
      editor: createForwardingEditor(optionsRef),
      deps,
      mounted: false,
      cancelDestroy: null,
    };
    created.cancelDestroy = destroyAfter(created, UNCOMMITTED_EDITOR_GRACE_MS);
    return created;
  });

  useEffect(() => {
    if (instance.editor.isDestroyed) return;
    if (
      deps.length !== instance.deps.length ||
      deps.some((dep, index) => !Object.is(dep, instance.deps[index]))
    ) {
      instance.deps = deps;
      instance.editor.destroy();
      instance.editor = createForwardingEditor(optionsRef);
      rerender();
      return;
    }
    if (!editorOptionsMatch(optionsRef.current, instance.editor.options)) {
      instance.editor.setOptions({ ...optionsRef.current, editable: instance.editor.isEditable });
    }
  });

  useEffect(() => {
    instance.mounted = true;
    instance.cancelDestroy?.();
    instance.cancelDestroy = null;
    if (instance.editor.isDestroyed) {
      instance.editor = createForwardingEditor(optionsRef);
      rerender();
    }
    return () => {
      instance.mounted = false;
      // Still in the document means the kept view was hidden, not removed.
      instance.cancelDestroy =
        lifetime !== null && instance.editor.view.dom?.isConnected === true
          ? lifetime.hold(() => destroyUnlessMounted(instance))
          : destroyAfter(instance, 1);
    };
  }, [instance, lifetime]);

  return instance.editor;
}

class KeptPureEditorContent extends PureEditorContent {
  static override contextType = KeptViewLifetimeContext;
  declare context: KeptViewLifetime | null;

  override componentWillUnmount() {
    // useKeptEditor owns teardown; Activity hides must preserve node views.
    if (this.context !== null) return;
    super.componentWillUnmount();
  }
}

const editorContentKeys = new WeakMap<Editor, string>();
let nextEditorContentKey = 0;

// Like EditorContent, a new editor instance gets a fresh content component.
function editorContentKey(editor: Editor | null): string {
  if (editor === null) return "none";
  let key = editorContentKeys.get(editor);
  if (key === undefined) {
    nextEditorContentKey += 1;
    key = String(nextEditorContentKey);
    editorContentKeys.set(editor, key);
  }
  return key;
}

export const KeptEditorContent = memo(
  forwardRef<HTMLDivElement, Omit<EditorContentProps, "ref" | "innerRef">>(
    function KeptEditorContent(props, ref) {
      return (
        <KeptPureEditorContent key={editorContentKey(props.editor)} innerRef={ref} {...props} />
      );
    },
  ),
);

/** True while a kept view warms up out of sight; it must not act as the shown thread. */
export const KeptViewWarmingContext = createContext(false);

/** Warm offscreen for two frames so the list settles before hiding. */
export function KeptViewFrame({
  viewKey,
  warming,
  onWarm,
  children,
}: {
  viewKey: string;
  warming: boolean;
  onWarm: (viewKey: string) => void;
  children: ReactNode;
}) {
  const portalContainer = useOwnPortalContainer(warming, useContext(KeptViewLifetimeContext));
  const warmed = useEffectEvent(() => onWarm(viewKey));
  useLayoutEffect(() => {
    if (!warming) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(warmed);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [warming]);
  return (
    <div
      className={
        warming
          ? "pointer-events-none invisible absolute inset-0 flex min-h-0 flex-col"
          : "contents"
      }
      inert={warming || undefined}
      aria-hidden={warming || undefined}
    >
      <KeptViewWarmingContext value={warming}>
        <PortalContainerContext value={portalContainer}>{children}</PortalContainerContext>
      </KeptViewWarmingContext>
    </div>
  );
}

// ── Keys typed on the way to a kept thread ────────────────────────────────

/** The route target (`threadRouteTargetKey`) the URL names, as of its last commit. */
let urlRouteTargetKey: string | null = null;
let heldText: { readonly targetKey: string; readonly text: string; readonly at: number } | null =
  null;
const HELD_TEXT_MAX_AGE_MS = 2_000;

/** Set by KeptChatSurface on each commit. */
export function setUrlRouteTargetKey(key: string | null): void {
  urlRouteTargetKey = key;
}

/** Printable typing on the sidebar row for the URL's thread. */
export function isUrlTargetSidebarTextKey(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
    return false;
  // Space and Enter activate the row; only its other text keys join the URL-target buffer.
  if (event.key.length !== 1 || event.key === " ") return false;
  const target = event.target;
  if (
    !(target instanceof Element) ||
    !target.matches('[data-testid="sidebar-row-slim"], [data-testid="sidebar-row-card"]')
  )
    return false;
  const threadKey = target.closest("[data-thread-item]")?.getAttribute("data-thread-item");
  return threadKey !== undefined && urlRouteTargetKey === `server:${threadKey}`;
}

/**
 * Revealing a kept thread follows the click in a transition, so for a moment
 * the view the user left is still shown and gets their keys. Text it would
 * type into its own composer is held for the view the URL names instead.
 * Returns whether the text was held.
 */
export function holdTextForUrlRouteTarget(viewTargetKey: string, text: string): boolean {
  const targetKey = urlRouteTargetKey;
  if (targetKey === null || targetKey === viewTargetKey) return false;
  const now = performance.now();
  const earlier =
    heldText !== null &&
    heldText.targetKey === targetKey &&
    now - heldText.at < HELD_TEXT_MAX_AGE_MS
      ? heldText.text
      : "";
  heldText = { targetKey, text: earlier + text, at: now };
  return true;
}

/** Backspace on the way to a kept thread takes back the last character held for it. */
export function eraseHeldText(viewTargetKey: string): boolean {
  if (heldText === null || !isUrlRouteTargetElsewhere(viewTargetKey)) return false;
  if (heldText.targetKey !== urlRouteTargetKey) return false;
  heldText = { ...heldText, text: heldText.text.slice(0, -1) };
  return true;
}

/** Text typed for this view while the view the user left was still shown. */
export function takeHeldText(viewTargetKey: string): string | null {
  const held = heldText;
  if (held === null || held.targetKey !== viewTargetKey) return null;
  heldText = null;
  return performance.now() - held.at < HELD_TEXT_MAX_AGE_MS ? held.text : null;
}

/** Whether the URL names another route target than this view's. */
export function isUrlRouteTargetElsewhere(viewTargetKey: string): boolean {
  return urlRouteTargetKey !== null && urlRouteTargetKey !== viewTargetKey;
}
