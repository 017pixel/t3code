import { Editor, type EditorOptions } from "@tiptap/core";
import { PureEditorContent, type EditorContentProps } from "@tiptap/react";
import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useEffect,
  useReducer,
  useRef,
  useState,
  type DependencyList,
  type RefObject,
  type ReactNode,
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

function createEditor(options: RefObject<Partial<EditorOptions>>) {
  return new Editor({
    ...options.current,
    onUpdate: (event) => options.current.onUpdate?.(event),
    onSelectionUpdate: (event) => options.current.onSelectionUpdate?.(event),
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
      editor: createEditor(optionsRef),
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
      deps.some((dep, index) => !Object.is(dep, instance.deps[index])) ||
      deps.length !== instance.deps.length
    ) {
      instance.deps = deps;
      instance.editor.destroy();
      instance.editor = createEditor(optionsRef);
      rerender();
      return;
    }
    instance.editor.setOptions({ editorProps: optionsRef.current.editorProps });
  });

  useEffect(() => {
    instance.mounted = true;
    instance.cancelDestroy?.();
    instance.cancelDestroy = null;
    if (instance.editor.isDestroyed) {
      instance.editor = createEditor(optionsRef);
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

/** Portals follow the Activity boundary that owns their thread. */
export function KeptViewFrame({ children }: { children: ReactNode }) {
  const portalContainer = useOwnPortalContainer(false, useContext(KeptViewLifetimeContext));
  return <PortalContainerContext value={portalContainer}>{children}</PortalContainerContext>;
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
