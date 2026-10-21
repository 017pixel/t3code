import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreviewMiniPlayerState } from "~/previewMiniPlayerStore";
import type { PreviewMiniPlayerFrame } from "./previewMiniPlayerLayout";

const hooks = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  canvas: {
    container: { width: 1000, height: 800 },
    previewKey: "device:host:device",
    layout: { frame: { x: 100, y: 100, width: 300, height: 650 } },
    reportPreview: () => {},
    clearPreview: () => {},
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T) => [initial, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
  useLayoutEffect: (effect: () => void | (() => void)) => hooks.effects.push(effect),
}));
vi.mock("../chat/ChatCanvasContext", () => ({ useChatCanvas: () => hooks.canvas }));
vi.mock("~/state/device", () => ({
  useDeviceState: () => ({ state: { devices: [], hosts: [] } }),
}));
vi.mock("~/state/environments", () => ({ useEnvironmentHttpBaseUrl: () => "" }));
vi.mock("~/browser/BrowserSurfaceSlot", () => ({ BrowserSurfaceSlot: "BrowserSurfaceSlot" }));
vi.mock("~/browser/browserRecording", () => ({}));
vi.mock("~/browser/browserSurfaceStore", () => ({}));
vi.mock("~/browser/previewRuntime", () => ({}));
vi.mock("~/browser/ServerBrowserSurface", () => ({ ServerBrowserSurface: "ServerBrowserSurface" }));
vi.mock("~/browser/serverPictureInPicture", () => ({}));
vi.mock("~/browser/useBrowserLayoutZoomFactor", () => ({}));
vi.mock("~/components/ui/button", () => ({ Button: "Button" }));
vi.mock("~/components/ui/toast", () => ({}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: "Tooltip",
  TooltipTrigger: "TooltipTrigger",
  TooltipPopup: "TooltipPopup",
}));
vi.mock("~/previewStateStore", () => ({}));
vi.mock("~/rightPanelStore", () => ({}));
vi.mock("../device/DeviceStreamView", () => ({ DeviceStreamView: "DeviceStreamView" }));
vi.mock("./previewBridge", () => ({ previewBridge: null }));
vi.mock("./showPreviewPopup", () => ({}));

import { ThreadPreviewMiniPlayer } from "./ThreadPreviewMiniPlayer";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";

const threadRef = {
  environmentId: EnvironmentId.make("gesture-test"),
  threadId: ThreadId.make("thread"),
};
const source = {
  kind: "device",
  hostId: "host",
  deviceId: "device",
  platform: "ios",
  name: "Phone",
} as const;
type HandlerProps = {
  children?: ReactNode;
  onPointerDown?: (event: unknown) => void;
  onPointerMove?: (event: unknown) => void;
  onPointerUp?: (event: unknown) => void;
  onPointerCancel?: (event: unknown) => void;
  onLostPointerCapture?: (event: unknown) => void;
  "data-preview-mini-player-resize"?: string;
};

function invoke(element: ReactElement): ReactElement {
  if (typeof element.type !== "function") throw new Error("Expected component");
  return (element.type as (props: unknown) => ReactElement)(element.props);
}
function find(
  node: ReactNode,
  predicate: (props: HandlerProps) => boolean,
): HandlerProps | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (!isValidElement<HandlerProps>(node)) return undefined;
  return predicate(node.props) ? node.props : find(node.props.children, predicate);
}

function setup(direction: string | null, ownFrame?: PreviewMiniPlayerFrame) {
  hooks.effects = [];
  hooks.canvas.container = { width: 1000, height: 800 };
  hooks.canvas.layout.frame = { x: 100, y: 100, width: 300, height: 650 };
  const frame = ownFrame ?? hooks.canvas.layout.frame;
  const miniPlayer: PreviewMiniPlayerState = {
    source,
    width: frame.width,
    position: { x: frame.x, y: frame.y },
    lastInteraction: "drag",
  };
  usePreviewMiniPlayerStore.setState({ byThreadKey: { [scopedThreadKey(threadRef)]: miniPlayer } });
  const windowEvents = new EventTarget();
  vi.stubGlobal("window", windowEvents);
  const shell = invoke(invoke(ThreadPreviewMiniPlayer({ threadRef, miniPlayer })));
  const handlers = find(shell, (props) =>
    direction === null
      ? Boolean(props.onPointerDown) && props["data-preview-mini-player-resize"] === undefined
      : props["data-preview-mini-player-resize"] === direction,
  );
  if (!handlers) throw new Error("Gesture handle missing");
  const cleanups = hooks.effects.map((effect) => effect());
  const captured = new Set<number>();
  const rect = {
    ...frame,
    left: frame.x,
    top: frame.y,
    right: frame.x + frame.width,
    bottom: frame.y + frame.height,
  };
  const preview = {
    getBoundingClientRect: () => rect,
    offsetWidth: frame.width,
    offsetHeight: frame.height,
  };
  const target = {
    parentElement: preview,
    closest: () => preview,
    getBoundingClientRect: () => ({
      left: rect.right - 8,
      top: rect.bottom - 8,
      width: 16,
      height: 16,
    }),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  };
  const dispatch = (type: string, x = 400, y = 750, buttons = 1) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      buttons,
      clientX: x,
      clientY: y,
    });
    Object.defineProperty(event, "currentTarget", { value: target });
    const eventHandlers: Record<string, ((event: unknown) => void) | undefined> = {
      pointerdown: handlers.onPointerDown,
      pointermove: handlers.onPointerMove,
      pointerup: handlers.onPointerUp,
      pointercancel: handlers.onPointerCancel,
      lostpointercapture: handlers.onLostPointerCapture,
    };
    eventHandlers[type]?.(event);
  };
  return {
    dispatch,
    blur: () => windowEvents.dispatchEvent(new Event("blur")),
    state: () => usePreviewMiniPlayerStore.getState().byThreadKey[scopedThreadKey(threadRef)]!,
    [Symbol.dispose]() {
      for (const cleanup of cleanups.toReversed()) cleanup?.();
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("floating preview pointer gestures", () => {
  it.each([
    { direction: "northwest", dx: -12, dy: -26 },
    { direction: "northeast", dx: 12, dy: -26 },
    { direction: "southwest", dx: -12, dy: 26 },
    { direction: "southeast", dx: 12, dy: 26 },
  ])(
    "$direction: resizes from the preview element's own size at pointerdown without a scale jump",
    ({ direction, dx, dy }) => {
      // The canvas can still hold the previous layout when the rendered preview has changed size.
      using gesture = setup(direction, { x: 100, y: 100, width: 240, height: 520 });
      gesture.dispatch("pointerdown");
      gesture.dispatch("pointermove", 400 + dx, 750 + dy);
      expect(gesture.state().width).toBe(252);
      expect(gesture.state().position).toEqual({ x: dx < 0 ? 88 : 100, y: dy < 0 ? 74 : 100 });
    },
  );

  it.each([null, "southeast"])(
    "%s: idle hover and pointermove leave state unchanged",
    (direction) => {
      using gesture = setup(direction);
      const initial = gesture.state();
      gesture.dispatch("pointermove", 450, 700, 0);
      gesture.dispatch("pointermove", 500, 600, 1);
      expect(gesture.state()).toBe(initial);
    },
  );
  const endings = [null, "southeast"].flatMap((direction) =>
    ["pointerup", "pointercancel", "lostpointercapture", "blur", "buttons=0"].map((ending) => ({
      direction,
      ending,
    })),
  );
  it.each(endings)(
    "$direction: ends on $ending and ignores later pointermove",
    ({ direction, ending }) => {
      using gesture = setup(direction);
      gesture.dispatch("pointerdown");
      gesture.dispatch("pointermove", 420, 710);
      if (ending === "blur") gesture.blur();
      else if (ending === "buttons=0") gesture.dispatch("pointermove", 420, 710, 0);
      else gesture.dispatch(ending, 420, 710, 0);
      const ended = gesture.state();
      gesture.dispatch("pointermove", 600, 600);
      expect(gesture.state()).toEqual(ended);
      expect(ended.lastInteraction).toBe(direction === null ? "drag" : "resize");
    },
  );
  it.each(endings)(
    "$direction: $ending clamps the final frame into a viewport that shrank during the gesture",
    ({ direction, ending }) => {
      using gesture = setup(direction);
      gesture.dispatch("pointerdown");
      gesture.dispatch("pointermove", 600, 750);
      hooks.canvas.container.width = 500;
      hooks.canvas.container.height = 700;
      if (ending === "blur") gesture.blur();
      else if (ending === "buttons=0") gesture.dispatch("pointermove", 600, 750, 0);
      else gesture.dispatch(ending, 600, 750, 0);
      const final = gesture.state();
      expect(final.position!.x).toBeGreaterThanOrEqual(12);
      expect(final.position!.y).toBeGreaterThanOrEqual(12);
      expect(final.position!.x + final.width!).toBeLessThanOrEqual(488);
      expect(final.position!.y + final.width! * (650 / 300)).toBeLessThanOrEqual(688);
    },
  );
});
