import { type CSSProperties, type ReactNode, useState } from "react";

import { isElectron } from "~/env";
import {
  type PreviewPanelInlineSize,
  usePreviewPanelInlineSize,
} from "~/hooks/usePreviewPanelInlineSize";
import { RESIZABLE_WIDTH_PROPERTY } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

import { RIGHT_PANEL_SHELL_ATTRIBUTE, RIGHT_PANEL_TOGGLE_SELECTOR } from "./collapseRightPanel";
import { RightPanelResizeHandle } from "./RightPanelResizeHandle";

export type PreviewPanelMode = "inline" | "sheet" | "sidebar" | "embedded";

interface PreviewPanelShellProps {
  mode: PreviewPanelMode;
  maximized?: boolean;
  inlineSize?: PreviewPanelInlineSize;
  open?: boolean;
  /** Use a distinct key per surface to keep remembered widths independent. */
  widthStorageKey?: string;
  defaultWidth?: number;
  children: ReactNode;
}

export function PreviewPanelShell(props: PreviewPanelShellProps) {
  if (props.inlineSize) {
    return <PreviewPanelShellFrame {...props} inlineSize={props.inlineSize} />;
  }

  return <ResizablePreviewPanelShell {...props} />;
}

function ResizablePreviewPanelShell(props: PreviewPanelShellProps) {
  const inlineSize = usePreviewPanelInlineSize({
    enabled: props.mode === "inline" && !props.maximized,
    widthStorageKey: props.widthStorageKey,
    defaultWidth: props.defaultWidth,
  });
  return <PreviewPanelShellFrame {...props} inlineSize={inlineSize} />;
}

function PreviewPanelShellFrame(
  props: PreviewPanelShellProps & {
    inlineSize: PreviewPanelInlineSize;
  },
) {
  const useDragRegion = isElectron && props.mode !== "sheet" && props.mode !== "embedded";
  const isInline = props.mode === "inline";
  const collapsible = isInline && props.open !== undefined;
  const open = props.open ?? true;
  const maximized = props.maximized ?? false;
  const { width, handlers, observeRow } = props.inlineSize;
  // Width animates only for an open or close. Any other width change disables
  // the transition in the same commit that changes the width, so the browser
  // never starts one; the next open or close re-enables it in its own commit,
  // so nothing waits for a paint.
  const [widthTransition, setWidthTransition] = useState(() => ({
    open,
    width,
    maximized,
    enabled: true,
  }));
  if (
    widthTransition.open !== open ||
    widthTransition.width !== width ||
    widthTransition.maximized !== maximized
  ) {
    setWidthTransition({
      open,
      width,
      maximized,
      enabled: widthTransition.open !== open,
    });
  }
  const suppressWidthTransition = collapsible && !widthTransition.enabled;
  const collapsed = collapsible && !open;
  // The toggle can move when the shell unmounts, after an animation or immediately.
  // Restore focus at its committed location when removal cleared focus to body.
  const attachHost = (host: HTMLDivElement) => {
    const stopObservingRow = observeRow(host);
    return () => {
      stopObservingRow();
      if (!collapsible) return;
      const document = host.ownerDocument;
      if (!host.inert && !host.contains(document.activeElement)) return;
      queueMicrotask(() => {
        if (document.activeElement === document.body) {
          document.querySelector<HTMLElement>(RIGHT_PANEL_TOGGLE_SELECTOR)?.focus();
        }
      });
    };
  };
  return (
    <div
      ref={attachHost}
      inert={collapsed}
      {...(collapsible ? { [RIGHT_PANEL_SHELL_ATTRIBUTE]: "" } : {})}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 max-w-full flex-col self-stretch bg-background",
        isInline
          ? maximized
            ? // Maximizing meets the sidebar border or window edge; omit the duplicate border.
              "flex-1"
            : "shrink-0 border-l border-border"
          : "w-full",
        collapsible &&
          "[[data-panel-animations=true]_&]:transition-[width] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration) [[data-panel-animations=true]_&]:ease-out",
        collapsible && open && "[[data-panel-animations=true]_&]:starting:w-0!",
        collapsed && "pointer-events-none",
      )}
      style={
        isInline
          ? ({
              [RESIZABLE_WIDTH_PROPERTY]: `${width}px`,
              width: maximized ? "100%" : collapsed ? "0px" : `var(${RESIZABLE_WIDTH_PROPERTY})`,
              transitionDuration: suppressWidthTransition ? "0ms" : undefined,
            } as CSSProperties)
          : undefined
      }
      data-preview-panel-mode={props.mode}
      data-preview-panel-maximized={maximized ? "true" : "false"}
    >
      {isInline && !maximized ? <RightPanelResizeHandle handlers={handlers} /> : null}
      <div className={cn("h-full min-h-0 w-full", collapsible && "overflow-clip")}>
        <div
          className="flex h-full min-h-0 min-w-0 flex-col"
          style={
            collapsible && !maximized
              ? { width: `calc(var(${RESIZABLE_WIDTH_PROPERTY}) - 1px)` }
              : undefined
          }
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
