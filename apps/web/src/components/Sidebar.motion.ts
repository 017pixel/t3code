import { observeResize } from "../lib/observeResize";

const motionTiming = { duration: 150, easing: "ease-out" };
// Rows normally ride their displaced neighbour's travel. Absent a moving
// neighbour, a row still travels on its own, clamped so a tall card does not
// slide its full height.
const rowTravel = (height: number) => Math.min(height, 40);
// A project filter change or a bulk snooze swaps a large part of the list at
// once. Fades are the expensive part: every removed row gets a deep clone and
// every clone and entering row gets its own animation, and the layout reads
// in between force synchronous reflows. Translating displaced rows is cheap,
// so only the fade count decides whether an update animates.
const MAX_FADED_ROWS_PER_UPDATE = 40;

type RowPosition = {
  top: number;
  left: number;
  width: number;
  height: number;
  key: string | HTMLElement;
  shape: string;
};

function progress(animation: Animation) {
  return animation.playState === "finished"
    ? 1
    : (animation.effect?.getComputedTiming().progress ?? 0);
}

/** Animate rows between their layout positions. The list must be
 * positioned so every direct child's offsetTop has the same origin. */
export function createSidebarListMotion(parent: HTMLUListElement) {
  let positions: Map<HTMLElement, RowPosition> | null = null;
  let disposed = false;
  const view = parent.ownerDocument.defaultView;
  const reducedMotion = view?.matchMedia("(prefers-reduced-motion: reduce)");
  const running = new Map<HTMLElement, { animation: Animation; offset: number }>();
  const entering = new Map<HTMLElement, { animation: Animation; travel: number }>();
  const exiting = new Map<HTMLElement, Animation>();
  // The element each thread row last put on screen: its virtual slot or the
  // rendered row that replaced it.
  const rendered = new Map<string, HTMLElement>();
  // Visual tops at drag release, relative to the list, so the release
  // commit can glide every row from where dnd-kit left it into its slot.
  let released: Map<HTMLElement, number> | null = null;
  let baselineFrame: number | null = null;

  const rows = () =>
    Array.from(parent.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement && !exiting.has(node),
    );
  const rowKey = (node: HTMLElement) => node.getAttribute?.("data-thread-item") ?? node;
  const rowShape = (node: HTMLElement) =>
    node.getAttribute?.("data-sidebar-row-variant") ?? node.className ?? "";
  const measure = (selective = false) => {
    const nodes = rows();
    const next = new Map(
      nodes.map((node) => [node, {
        top: node.offsetTop,
        left: node.offsetLeft,
        width: node.offsetWidth,
        height: node.offsetHeight,
        key: rowKey(node),
        shape: rowShape(node),
      }]),
    );
    if (selective && positions) {
      // A virtual slot and its rendered row share identity for motion. A row
      // that changed variant does not: the old one fades out as it was last
      // rendered and the new one fades in at its slot.
      const nodesByKey = new Map(nodes.map((node) => [rowKey(node), node]));
      const live = (old: RowPosition) => {
        const current = nodesByKey.get(old.key);
        if (current !== undefined && rowShape(current) === old.shape) return current;
        const last = typeof old.key === "string" ? rendered.get(old.key) : undefined;
        return last !== undefined && rowShape(last) === old.shape ? last : undefined;
      };
      positions = new Map([...positions].map(([node, old]) => [live(old) ?? node, old]));
    }
    return next;
  };
  const cancelBaseline = () => {
    if (baselineFrame !== null) view?.cancelAnimationFrame(baselineFrame);
    baselineFrame = null;
  };
  // Reading every row box during a commit forces a layout, and boot runs
  // several commits before its first paint. A commit that cannot animate takes
  // the next baseline in the following frame, which lays out anyway.
  const scheduleBaseline = () => {
    positions = null;
    if (typeof view?.requestAnimationFrame !== "function") {
      positions = measure();
      return;
    }
    if (baselineFrame !== null) return;
    baselineFrame = view.requestAnimationFrame(() => {
      baselineFrame = null;
      if (!disposed && positions === null) positions = measure();
    });
  };
  let observedWidth: number | null = null;
  const stopObserving =
    typeof ResizeObserver === "undefined"
      ? null
      : observeResize(parent, ([entry]) => {
          if (!entry) return;
          const width = entry.contentRect.width;
          if (observedWidth !== null && observedWidth !== width) scheduleBaseline();
          observedWidth = width;
        });

  // Forget a row's animation when it finishes, unless a newer one replaced it.
  const track = <Entry extends { animation: Animation }>(
    map: Map<HTMLElement, Entry>,
    node: HTMLElement,
    entry: Entry,
  ) => {
    map.set(node, entry);
    entry.animation.addEventListener(
      "finish",
      () => {
        if (map.get(node) === entry) map.delete(node);
      },
      { once: true },
    );
  };
  const adopt = <Entry extends { animation: Animation }>(
    map: Map<HTMLElement, Entry>,
    from: HTMLElement,
    to: HTMLElement,
  ) => {
    const entry = map.get(from);
    if (entry === undefined) return;
    map.delete(from);
    const effect = entry.animation.effect as KeyframeEffect | null;
    if (effect) effect.target = to;
    track(map, to, entry);
  };
  // A virtual slot swaps in its rendered row, or back, outside any motion
  // pass. Track which element is on screen, and let the replacement continue
  // an in-flight animation instead of popping in at rest.
  const swaps =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver((records) => {
          const added = new Map<string, HTMLElement>();
          for (const record of records) {
            for (const node of record.addedNodes) {
              if (!(node instanceof HTMLElement) || node.parentNode !== parent) continue;
              const key = rowKey(node);
              if (typeof key === "string") added.set(key, node);
            }
          }
          for (const record of records) {
            for (const node of record.removedNodes) {
              if (!(node instanceof HTMLElement)) continue;
              const key = rowKey(node);
              if (typeof key !== "string") continue;
              if (rendered.get(key) === node) rendered.delete(key);
              const replacement = added.get(key);
              if (!replacement || replacement === node) continue;
              if (rowShape(replacement) !== rowShape(node)) continue;
              adopt(entering, node, replacement);
              adopt(running, node, replacement);
            }
          }
          for (const [key, node] of added) rendered.set(key, node);
        });
  swaps?.observe(parent, { childList: true });

  const remainingOffset = (node: HTMLElement) => {
    const current = running.get(node);
    const run = current ? current.offset * (1 - progress(current.animation)) : 0;
    const entry = entering.get(node);
    const enter = entry ? entry.travel * (1 - progress(entry.animation)) : 0;
    return run + enter;
  };
  const clearFades = () => {
    for (const entry of entering.values()) entry.animation.cancel();
    for (const animation of exiting.values()) animation.cancel();
    for (const node of exiting.keys()) node.remove();
    entering.clear();
    exiting.clear();
  };
  const fadeOut = (node: HTMLElement, position: RowPosition, travel: number) => {
    if (position.height === 0) return;
    // React owns the removed row; only a noninteractive copy stays for the fade.
    const clone = node.cloneNode(true) as HTMLElement;
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of Array.from(element.attributes)) {
        if (
          (attribute.name === "id" && element.namespaceURI !== "http://www.w3.org/2000/svg") ||
          attribute.name === "data-thread-item" ||
          attribute.name === "data-thread-selection-safe" ||
          attribute.name === "data-testid"
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }
    clone.setAttribute("aria-hidden", "true");
    clone.inert = true;
    Object.assign(clone.style, {
      position: "absolute",
      top: `${position.top + remainingOffset(node)}px`,
      left: `${position.left}px`,
      width: `${position.width}px`,
      height: `${position.height}px`,
      margin: "0",
      boxSizing: "border-box",
      contentVisibility: "visible",
      transform: "none",
      transition: "none",
      pointerEvents: "none",
    });
    parent.append(clone);
    const entry = entering.get(node);
    const entryProgress = entry ? progress(entry.animation) : 1;
    const animation = clone.animate(
      [
        { opacity: entryProgress, transform: "translateY(0px)" },
        { opacity: 0, transform: `translateY(${travel}px)` },
      ],
      motionTiming,
    );
    exiting.set(clone, animation);
    animation.addEventListener(
      "finish",
      () => {
        clone.remove();
        exiting.delete(clone);
      },
      { once: true },
    );
  };

  const cancel = (node: HTMLElement) => {
    running.get(node)?.animation.cancel();
    running.delete(node);
  };
  const suspend = () => {
    for (const node of running.keys()) cancel(node);
    clearFades();
    cancelBaseline();
    positions = null;
    released = null;
  };
  const move = (node: HTMLElement, offset: number) => {
    cancel(node);
    const entry = entering.get(node);
    // The newer transform supersedes entry travel; its original opacity keeps fading.
    if (entry) entry.travel = 0;
    if (offset === 0 && !entry) return;
    const animation = node.animate(
      [{ transform: `translateY(${offset}px)` }, { transform: "translateY(0px)" }],
      motionTiming,
    );
    track(running, node, { animation, offset });
  };

  return {
    update(animate: boolean) {
      if (disposed) return;
      if (released === null && (!animate || positions === null || reducedMotion?.matches)) {
        clearFades();
        for (const node of running.keys()) cancel(node);
        scheduleBaseline();
        return;
      }
      cancelBaseline();
      const next = measure(true);
      let fadeCount = 0;
      if (positions !== null) {
        for (const [node, position] of positions) {
          if (!next.has(node) && position.height > 0) fadeCount++;
        }
        for (const [node, position] of next) {
          if (!positions.has(node) && position.height > 0) fadeCount++;
        }
      }
      const shouldAnimate =
        released === null &&
        animate &&
        positions !== null &&
        !reducedMotion?.matches &&
        fadeCount <= MAX_FADED_ROWS_PER_UPDATE;
      const movedDelta = new Map<HTMLElement, number>();
      const nextOrder = [...next.keys()];
      const oldOrder = positions === null ? [] : [...positions.keys()];
      const ridingDelta = (
        order: readonly HTMLElement[],
        index: number,
        retained: (node: HTMLElement) => boolean,
      ) => {
        for (let cursor = index - 1; cursor >= 0; cursor--) {
          const node = order[cursor]!;
          const delta = movedDelta.get(node);
          if (delta !== undefined) return delta;
          if (retained(node)) return remainingOffset(node);
        }
        return undefined;
      };
      if (!shouldAnimate) clearFades();
      else {
        // A shelf that opens above its collapsed anchor shifts every retained
        // row by the same amount. Entering rows take that same displacement so
        // the shelf arrives as one moving block instead of rows popping into
        // their final slots; exiting rows leave by it.
        for (const [node, position] of next) {
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined || previousTop === position.top) continue;
          movedDelta.set(node, previousTop + remainingOffset(node) - position.top);
        }
        for (const [node, position] of positions!) {
          if (next.has(node)) continue;
          const delta = ridingDelta(oldOrder, oldOrder.indexOf(node), (n) => next.has(n));
          fadeOut(node, position, delta === undefined ? rowTravel(position.height) : -delta);
        }
      }
      for (const [node, entry] of entering) {
        if (!next.has(node)) {
          entry.animation.cancel();
          entering.delete(node);
        }
      }
      for (const node of running.keys()) {
        if (!shouldAnimate || !next.has(node)) cancel(node);
      }
      if (shouldAnimate) {
        for (const [index, node] of nextOrder.entries()) {
          const position = next.get(node)!;
          const previousTop = positions!.get(node)?.top;
          if (previousTop === undefined) {
            if (position.height > 0) {
              const delta = ridingDelta(nextOrder, index, (n) => positions!.has(n));
              const travel = delta === undefined ? -rowTravel(position.height) : delta;
              const animation = node.animate(
                [
                  { opacity: 0, transform: `translateY(${travel}px)` },
                  { opacity: 1, transform: "translateY(0px)" },
                ],
                motionTiming,
              );
              track(entering, node, { animation, travel });
            }
            continue;
          }
          const delta = movedDelta.get(node);
          // Computed progress includes the effect's easing. Only our own
          // translate is carried forward; dnd-kit's transforms are never read.
          if (delta !== undefined) move(node, delta);
        }
      }
      if (released !== null) {
        if (!reducedMotion?.matches) {
          for (const [node, position] of next) {
            const top = released.get(node);
            if (top !== undefined) move(node, top - position.top);
          }
        }
        released = null;
      }
      positions = next;
    },
    /** Capture transformed rows before dnd-kit clears its preview. Retain
     * layout boxes so the release commit reads only the changed range. */
    release() {
      const baseline = positions;
      suspend();
      positions = baseline;
      const origin = parent.getBoundingClientRect().top;
      released = new Map(
        Array.from(parent.children)
          .filter(
            (node): node is HTMLElement =>
              node instanceof HTMLElement &&
              !exiting.has(node) &&
              (typeof rowKey(node) !== "string" || node.hasAttribute("data-sidebar-row-displaced")),
          )
          .map((node) => [node, node.getBoundingClientRect().top - origin]),
      );
    },
    suspend,
    dispose() {
      stopObserving?.();
      swaps?.disconnect();
      suspend();
      disposed = true;
    },
  };
}
