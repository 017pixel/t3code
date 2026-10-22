import type { SensorProps } from "@dnd-kit/core";
import { describe, expect, it, vi } from "vite-plus/test";
import { fakeTimers } from "../../test/render";
import { SidebarPointerSensor, guardSidebarStalePress } from "./Sidebar.pointer";

const sensors: SidebarPointerSensor[] = [];

function pointer(type: string, values: PointerEventInit = {}) {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    clientX: 10,
    clientY: 10,
    buttons: 1,
    ...values,
  });
}

function gesture(
  extraOptions: Partial<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]> = {},
) {
  const callbacks = {
    onStart: vi.fn(),
    onMove: vi.fn(),
    onEnd: vi.fn(),
    onCancel: vi.fn(),
    onAbort: vi.fn(),
    onPending: vi.fn(),
  };
  const onFinish = vi.fn();
  const props = {
    active: "thread",
    event: pointer("pointerdown"),
    options: { distance: 6, onAttach: vi.fn(), onFinish, ...extraOptions },
    ...callbacks,
  } as unknown as SensorProps<ConstructorParameters<typeof SidebarPointerSensor>[0]["options"]>;
  const sensor = new SidebarPointerSensor(props);
  sensors.push(sensor);
  return { sensor, onFinish, ...callbacks };
}

function setup() {
  const stack = new DisposableStack();
  stack.use(fakeTimers());
  stack.defer(() => {
    for (const sensor of sensors.splice(0)) sensor.cancel();
    // Cancelled sensors keep suppressing clicks on the shared document until the next press.
    document.dispatchEvent(pointer("pointerdown"));
    vi.runAllTimers();
  });
  return stack;
}

describe("sidebar pointer lifecycle", () => {
  it("drops context when a zero-button move precedes pointerup", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientY: 20 }));
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));

    // Native desktop releases can report the released button on the final move.
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 94, clientY: 32 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 100, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 94, y: 32 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });

  // regression: #17373 a zero-button release outside a drop target must cancel, not reorder
  it("cancels a missed sidebar release without committing a reorder", () => {
    using _environment = setup();
    const onDrop = vi.fn((point: { x: number; y: number }) => point.x > 50);
    const drag = gesture({ onMove: (point) => point.x > 50, onDrop });
    document.dispatchEvent(pointer("pointermove", { clientX: 90, clientY: 30 }));
    document.dispatchEvent(pointer("pointermove", { buttons: 0, clientX: 30, clientY: 40 }));
    document.dispatchEvent(pointer("pointerup", { buttons: 0, clientX: 30, clientY: 40 }));

    expect(onDrop).toHaveBeenCalledExactlyOnceWith({ x: 30, y: 40 });
    expect(drag.onCancel).toHaveBeenCalledOnce();
    expect(drag.onEnd).not.toHaveBeenCalled();
    expect(drag.onFinish).toHaveBeenCalledExactlyOnceWith(true);
  });
});

describe("sidebar stale press guard", () => {
  function list() {
    const stack = new DisposableStack();
    const node = document.createElement("ul");
    // The default pointer point, (10, 10), rests on whichever row is first.
    node.style.cssText =
      "position: fixed; inset: 0 auto auto 0; margin: 0; padding: 0; width: 200px";
    const rows = ["alpha", "beta", "gamma"].map((name) => {
      const row = node.appendChild(document.createElement("li"));
      row.textContent = name;
      row.style.cssText = "display: block; height: 20px";
      return row;
    });
    document.body.append(node);
    stack.defer(() => node.remove());
    const guard = guardSidebarStalePress(node);
    stack.defer(guard.release);
    const clicked: string[] = [];
    node.addEventListener("click", (event) => {
      clicked.push((event.target as HTMLElement).textContent ?? "");
    });
    const press = (row: HTMLElement) => {
      row.dispatchEvent(pointer("pointerdown", { pointerType: "mouse" }));
      row.dispatchEvent(pointer("pointerup", { pointerType: "mouse", buttons: 0 }));
      row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    };
    return { stack, guard, rows, clicked, press };
  }

  it("swallows the first press on a row another client slid under the mouse", () => {
    const { stack, rows, clicked, press } = list();
    using _list = stack;
    const [alpha, beta] = rows;
    alpha!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    alpha!.remove();

    press(beta!);
    press(beta!);

    expect(clicked).toEqual(["beta"]);
  });

  // regression: settling a row must not swallow the deliberate click on the row that replaces it
  it("trusts the row that slides in after the user's own settle", () => {
    const { stack, guard, rows, clicked, press } = list();
    using _list = stack;
    const [alpha, beta] = rows;
    alpha!.addEventListener("click", () => {
      guard.trust();
      alpha!.remove();
      guard.rowsChanged();
    });
    alpha!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    press(alpha!);

    press(beta!);

    expect(clicked).toEqual(["alpha", "beta"]);
  });

  // regression: a click that keeps its row must not disarm the guard for a later remote shift
  it("still swallows a remote shift after a click that kept its row", () => {
    const { stack, rows, clicked, press } = list();
    using _list = stack;
    const [alpha, beta] = rows;
    alpha!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    press(alpha!);
    alpha!.remove();

    press(beta!);
    press(beta!);

    expect(clicked).toEqual(["alpha", "beta"]);
  });

  // regression: a trusted press must still arm the guard for a remote shift that follows it
  it("swallows a remote shift after an untracked press that follows the user's own settle", () => {
    const { stack, guard, rows, clicked, press } = list();
    using _list = stack;
    const [alpha, beta, gamma] = rows;
    alpha!.addEventListener("click", () => {
      guard.trust();
      alpha!.remove();
      guard.rowsChanged();
    });
    alpha!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    press(alpha!);
    press(beta!);
    beta!.remove();

    press(gamma!);
    press(gamma!);

    expect(clicked).toEqual(["alpha", "beta", "gamma"]);
  });

  // regression: the user's own settle must not disarm the guard for a remote shift before any press
  it("swallows a remote shift that follows the user's own settle before any press", () => {
    const { stack, guard, rows, clicked, press } = list();
    using _list = stack;
    const [alpha, beta, gamma] = rows;
    alpha!.addEventListener("click", () => {
      guard.trust();
      alpha!.remove();
      guard.rowsChanged();
    });
    alpha!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    press(alpha!);
    beta!.remove();
    guard.rowsChanged();

    press(gamma!);
    press(gamma!);

    expect(clicked).toEqual(["alpha", "gamma"]);
  });

  function scrolledList() {
    const { stack, guard, rows, clicked, press } = list();
    const scroller = document.createElement("div");
    scroller.style.cssText = "height: 40px; overflow: auto";
    document.body.append(scroller);
    stack.defer(() => scroller.remove());
    const node = rows[0]!.parentElement!;
    node.style.position = "static";
    scroller.append(node);
    scroller.scrollTop = scroller.scrollHeight;
    return { stack, guard, rows, clicked, press, scroller };
  }

  // regression: the browser clamping scrollTop after a remote removal is not the user scrolling
  it("swallows a remote removal that clamps the list's scroll position", async () => {
    const { stack, rows, clicked, press, scroller } = scrolledList();
    using _list = stack;
    const [alpha, beta, gamma] = rows;
    gamma!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    const clamped = new Promise((resolve) =>
      scroller.addEventListener("scroll", resolve, { once: true }),
    );
    alpha!.remove();
    await clamped;

    press(beta!);
    press(beta!);

    expect(clicked).toEqual(["beta"]);
  });

  it("trusts the row the user's own wheel scrolls under the mouse", () => {
    const { stack, rows, clicked, press } = scrolledList();
    using _list = stack;
    const [, beta, gamma] = rows;
    gamma!.dispatchEvent(pointer("pointermove", { pointerType: "mouse", buttons: 0 }));
    gamma!.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -20 }));

    press(beta!);

    expect(clicked).toEqual(["beta"]);
  });
});
