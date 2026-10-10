import { Editor, type EditorOptions } from "@tiptap/core";
import { PureEditorContent, type EditorContentProps } from "@tiptap/react";
import {
  createContext,
  forwardRef,
  memo,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DependencyList,
  type RefObject,
} from "react";

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

function destroyOnNextTask(instance: KeptEditorInstance) {
  const timeout = setTimeout(() => destroyUnlessMounted(instance), 1);
  return () => clearTimeout(timeout);
}

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
    // A render React discards never mounts; free its editor.
    created.cancelDestroy = destroyOnNextTask(created);
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
          : destroyOnNextTask(instance);
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

/** `EditorContent` from @tiptap/react for editors made by `useKeptEditor`. */
export const KeptEditorContent = memo(
  forwardRef<HTMLDivElement, Omit<EditorContentProps, "ref" | "innerRef">>(
    function KeptEditorContent(props, ref) {
      // Like EditorContent, a new editor instance gets a fresh content component.
      const key = useMemo(() => Math.floor(Math.random() * 0xffffffff).toString(), [props.editor]);
      return <KeptPureEditorContent key={key} innerRef={ref} {...props} />;
    },
  ),
);
