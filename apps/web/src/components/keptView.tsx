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

import { PortalContainerContext } from "~/lib/portalContainer";

/**
 * A thread view that `ThreadRouteView` keeps rendered while hidden. React
 * runs a hidden view's effect cleanups without unmounting it, so work that
 * should survive the hide holds its release here; it runs when the view is
 * evicted or unmounted for good.
 */
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

/** One lifetime per kept view key, made on first use. */
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
    /** Releases every view whose key is not in `keys`. */
    retain(keys: ReadonlySet<string>) {
      for (const [key, lifetime] of lifetimes) {
        if (keys.has(key)) continue;
        lifetimes.delete(key);
        lifetime.dispose();
      }
    },
  };
}

type EditorCallbackKey =
  | "onBeforeCreate"
  | "onCreate"
  | "onUpdate"
  | "onSelectionUpdate"
  | "onTransaction"
  | "onFocus"
  | "onBlur"
  | "onDestroy"
  | "onContentError"
  | "onDrop"
  | "onPaste"
  | "onDelete"
  | "onMount"
  | "onUnmount";

const EDITOR_CALLBACK_KEYS: ReadonlyArray<EditorCallbackKey> = [
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
];

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

/**
 * How long an editor made during a render may wait for that render to
 * commit. Thread views mount in transitions, which can take longer than the
 * next task; a render React discards frees its editor after this.
 */
const UNCOMMITTED_EDITOR_GRACE_MS = 5_000;

/**
 * `useEditor` from @tiptap/react, except that hiding a kept thread view does
 * not destroy the editor: its content, selection and undo history are there
 * when the view is shown again. Outside a kept view, an unmounted editor is
 * destroyed on the next task, as with `useEditor`. Changed `deps` recreate it.
 */
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
    // Inside a kept view the editor's DOM and node views stay where they
    // are. A hidden view shows them again as is; a removed one destroys
    // the editor with it (see useKeptEditor).
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

/** `EditorContent` from @tiptap/react for editors made by `useKeptEditor`. */
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

/**
 * Frames one kept view. While warming, the view lays out at full size but
 * out of sight, and cannot be focused or clicked; `onWarm` runs two frames
 * after it mounted, once its list has settled. Its popups portal into a
 * container of its own, shown only while the view is shown and not warming.
 */
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
  const lifetime = useContext(KeptViewLifetimeContext);
  const [portalContainer] = useState(() => {
    const container = document.createElement("div");
    container.hidden = true;
    return container;
  });
  useLayoutEffect(() => {
    if (!portalContainer.isConnected) {
      document.body.append(portalContainer);
      lifetime?.hold(() => portalContainer.remove());
    }
    portalContainer.toggleAttribute("hidden", warming);
    // Hiding the view runs this cleanup too; its popups stay mounted but out of sight.
    return () => {
      portalContainer.toggleAttribute("hidden", true);
    };
  }, [lifetime, portalContainer, warming]);
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
export function eraseHeldText(viewTargetKey: string): void {
  if (heldText === null || !isUrlRouteTargetElsewhere(viewTargetKey)) return;
  if (heldText.targetKey !== urlRouteTargetKey) return;
  heldText = { ...heldText, text: heldText.text.slice(0, -1) };
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
