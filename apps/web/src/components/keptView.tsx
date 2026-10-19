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
  useState,
  type DependencyList,
  type ReactNode,
} from "react";

import { PortalContainerContext, useOwnPortalContainer } from "~/lib/portalContainer";

export interface KeptViewLifetime {
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

// Allow transition renders to commit before freeing abandoned editors.
const UNCOMMITTED_EDITOR_GRACE_MS = 5_000;

class KeptEditorInstance {
  editor: Editor;
  private options: Partial<EditorOptions>;
  private deps: DependencyList;
  private mounted = false;
  private cancelDestroy: (() => void) | null;

  constructor(options: Partial<EditorOptions>, deps: DependencyList) {
    this.options = options;
    this.deps = deps;
    this.editor = this.createEditor();
    this.cancelDestroy = this.destroyAfter(UNCOMMITTED_EDITOR_GRACE_MS);
  }

  private createEditor() {
    return new Editor({
      ...this.options,
      onUpdate: (event) => this.options.onUpdate?.(event),
      onSelectionUpdate: (event) => this.options.onSelectionUpdate?.(event),
    });
  }

  private destroyUnlessMounted() {
    if (!this.mounted && !this.editor.isDestroyed) this.editor.destroy();
  }

  private destroyAfter(delayMs: number) {
    const timeout = setTimeout(() => this.destroyUnlessMounted(), delayMs);
    return () => clearTimeout(timeout);
  }

  update(options: Partial<EditorOptions>, deps: DependencyList): boolean {
    this.options = options;
    if (this.editor.isDestroyed) return false;
    if (deps.length !== this.deps.length || deps.some((dep, i) => !Object.is(dep, this.deps[i]))) {
      this.deps = deps;
      this.editor.destroy();
      this.editor = this.createEditor();
      return true;
    }
    this.editor.setOptions({ editorProps: options.editorProps ?? {} });
    return false;
  }

  mount(): boolean {
    this.mounted = true;
    this.cancelDestroy?.();
    this.cancelDestroy = null;
    if (!this.editor.isDestroyed) return false;
    this.editor = this.createEditor();
    return true;
  }

  unmount(lifetime: KeptViewLifetime | null) {
    this.mounted = false;
    // Still in the document means the kept view was hidden, not removed.
    this.cancelDestroy =
      lifetime !== null && this.editor.view.dom?.isConnected === true
        ? lifetime.hold(() => this.destroyUnlessMounted())
        : this.destroyAfter(1);
  }
}

/** Preserves the editor and undo history across Activity hides; changed deps recreate it. */
export function useKeptEditor(options: Partial<EditorOptions>, deps: DependencyList): Editor {
  const lifetime = useContext(KeptViewLifetimeContext);
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const [instance] = useState(() => new KeptEditorInstance(options, deps));

  useLayoutEffect(() => {
    if (instance.update(options, deps)) rerender();
  });

  useEffect(() => {
    if (instance.mount()) rerender();
    return () => instance.unmount(lifetime);
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

export const KeptEditorContent = memo(
  forwardRef<HTMLDivElement, Omit<EditorContentProps, "ref" | "innerRef">>(
    function KeptEditorContent(props, ref) {
      const [content, setContent] = useState({ editor: props.editor, key: 0 });
      if (content.editor !== props.editor) {
        setContent({ editor: props.editor, key: content.key + 1 });
      }
      return <KeptPureEditorContent key={content.key} innerRef={ref} {...props} />;
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
let heldText: {
  readonly targetKey: string;
  readonly text: string;
  readonly at: number;
  readonly pending?: boolean;
} | null = null;
const HELD_TEXT_MAX_AGE_MS = 2_000;

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

/** Holds typing for the URL destination while the previous view finishes its transition. */
export function holdTextForUrlRouteTarget(viewTargetKey: string, text: string): boolean {
  const targetKey = urlRouteTargetKey;
  if (targetKey === null || targetKey === viewTargetKey) return false;
  const now = performance.now();
  const earlier =
    heldText !== null &&
    heldText.targetKey === targetKey &&
    (heldText.pending || now - heldText.at < HELD_TEXT_MAX_AGE_MS)
      ? heldText.text
      : "";
  heldText = {
    targetKey,
    text: earlier + text,
    at: now,
    pending: heldText?.targetKey === targetKey && heldText.pending === true,
  };
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
export function insertHeldText(viewTargetKey: string, insert: (text: string) => boolean): void {
  const held = heldText;
  if (held === null || held.targetKey !== viewTargetKey) return;
  if (!held.pending && performance.now() - held.at >= HELD_TEXT_MAX_AGE_MS) {
    heldText = null;
    return;
  }
  // Once the destination arrives, readiness can take longer than the navigation grace period.
  heldText = insert(held.text) || held.text.length === 0 ? null : { ...held, pending: true };
}

/** Whether the URL names another route target than this view's. */
export function isUrlRouteTargetElsewhere(viewTargetKey: string): boolean {
  return urlRouteTargetKey !== null && urlRouteTargetKey !== viewTargetKey;
}
