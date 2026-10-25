import { Spinner } from "~/components/ui/spinner";
import { useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import type { ServerProvider } from "@t3tools/contracts";
import { CircleCheckIcon, DownloadIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { useState, type CSSProperties } from "react";

import { useDeadlinePassed } from "../../hooks/useDeadline";
import { primaryServerProvidersAtom } from "../../state/server";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Matches the pill's `duration-180` class.
const PROVIDER_UPDATE_PILL_EXIT_MS = 180;

const PROVIDER_UPDATE_PILL_STYLES = {
  loading:
    "bg-sidebar-control-surface text-sidebar-foreground group-has-[button[data-provider-update-main]:hover]/provider-update:bg-sidebar-row-hover",
  success:
    "bg-sidebar-control-surface text-sidebar-foreground group-has-[button[data-provider-update-main]:hover]/provider-update:bg-sidebar-row-hover",
  warning:
    "bg-warning/12 text-warning group-has-[button[data-provider-update-main]:hover]/provider-update:bg-warning/18",
  error:
    "bg-destructive/12 text-destructive group-has-[button[data-provider-update-main]:hover]/provider-update:bg-destructive/18",
} as const;

const PROVIDER_UPDATE_PILL_PROGRESS_STYLES = {
  success: "bg-foreground/8",
  warning: "bg-warning/14",
  error: "bg-destructive/14",
} as const;

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

export function SidebarProviderUpdatePill() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const [dismissedKeys, setDismissedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [renderedView, setRenderedView] = useState<ProviderUpdateSidebarPillView | null>(null);
  const [exit, setExit] = useState<{
    readonly key: string;
    readonly startedAt: number;
    readonly nextView: ProviderUpdateSidebarPillView | null;
    readonly dismissKey: string | null;
  } | null>(null);
  const exitingKey = exit?.key ?? null;
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>();
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestProviderCheckedAt(providers);
  const view = getProviderUpdateSidebarPillView(providers, {
    ...(effectiveVisibleAfterIso !== undefined
      ? { visibleAfterIso: effectiveVisibleAfterIso }
      : {}),
    dismissedKeys,
  });

  if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
    setVisibleAfterIso(effectiveVisibleAfterIso);
  }

  const openProviderSettings = () => {
    void navigate({ to: "/settings/providers" });
  };
  const displayedView = renderedView ?? view;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;
  const showDismissProgress =
    dismissAfterVisibleMs !== undefined &&
    displayedView?.tone !== "loading" &&
    exitingKey !== viewKey;

  // The countdown is the progress bar's transition, started when the bar mounts.
  const [dismissClock, setDismissClock] = useState<{ key: string; at: number } | null>(null);
  const startExit = (
    key: string,
    nextView: ProviderUpdateSidebarPillView | null,
    dismissKey?: string,
  ) => {
    if (exitingKey === key) {
      return;
    }
    setDismissClock(null);
    setExit({ key, startedAt: Date.now(), nextView, dismissKey: dismissKey ?? null });
  };

  if (exitingKey === null) {
    if (!renderedView) {
      if (view) {
        setRenderedView(view);
      }
    } else if (!view) {
      startExit(renderedView.key, null);
    } else if (view.key !== renderedView.key) {
      startExit(renderedView.key, view);
    }
  }

  const countingDown =
    dismissAfterVisibleMs !== undefined &&
    dismissAfterVisibleMs > 0 &&
    viewKey !== null &&
    exitingKey !== viewKey;
  const dismissAt = dismissClock?.key === viewKey ? dismissClock.at : null;
  // The bar's transitionend dismisses; this deadline only covers a transition
  // that was cancelled or skipped and so never ends.
  const dismissOverdue = useDeadlinePassed(
    countingDown && dismissAt !== null ? dismissAt + PROVIDER_UPDATE_PILL_EXIT_MS : null,
  );
  if (countingDown && dismissOverdue) startExit(viewKey, null, viewKey);

  // The exit is timed rather than ended by transitionend: a cancelled or skipped
  // CSS transition must not keep a hidden spinner mounted.
  const exitFinished = useDeadlinePassed(
    exit === null ? null : exit.startedAt + PROVIDER_UPDATE_PILL_EXIT_MS,
  );
  if (exit !== null && exitFinished) {
    const { dismissKey, nextView } = exit;
    if (dismissKey !== null) {
      setDismissedKeys((previous) => new Set(previous).add(dismissKey));
    }
    setRenderedView(nextView);
    setExit(null);
  }

  if (!displayedView) {
    return null;
  }

  return (
    <div
      className={`group/provider-update relative flex min-h-7 w-full shrink-0 items-center overflow-hidden rounded-lg text-2xs leading-4 font-medium transform-gpu transition-all duration-180 ease-drawer will-change-transform ${
        PROVIDER_UPDATE_PILL_STYLES[displayedView.tone]
      } ${
        exitingKey === displayedView.key
          ? "pointer-events-none translate-y-1.5 opacity-0"
          : "translate-y-0 opacity-100"
      }`}
    >
      {showDismissProgress ? (
        <div
          key={displayedView.key}
          ref={(node) => {
            if (node === null || !countingDown) return;
            setDismissClock((clock) =>
              clock?.key === viewKey
                ? clock
                : { key: viewKey, at: Date.now() + dismissAfterVisibleMs },
            );
          }}
          onTransitionEnd={(event) => {
            if (countingDown && event.target === event.currentTarget) {
              startExit(viewKey, null, viewKey);
            }
          }}
          aria-hidden="true"
          className={`pointer-events-none absolute inset-y-0 left-0 w-full origin-left scale-x-0 transition-transform duration-(--provider-update-pill-dismiss-ms) ease-linear starting:scale-x-100 border-r border-current/15 inset-shadow-2xs inset-shadow-white/8 ${
            PROVIDER_UPDATE_PILL_PROGRESS_STYLES[displayedView.tone]
          }`}
          style={
            {
              "--provider-update-pill-dismiss-ms": `${dismissAfterVisibleMs}ms`,
            } as CSSProperties
          }
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={displayedView.description}
              data-provider-update-main
              className="relative z-[1] flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
              onClick={openProviderSettings}
            >
              {displayedView.tone === "loading" ? (
                <Spinner size="sm" className="shrink-0" />
              ) : displayedView.tone === "success" ? (
                <CircleCheckIcon className="size-3.5 shrink-0" />
              ) : displayedView.tone === "error" ? (
                <TriangleAlertIcon className="size-3.5 shrink-0" />
              ) : (
                <DownloadIcon className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 wrap-break-word">{displayedView.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{displayedView.description}</TooltipPopup>
      </Tooltip>
      {displayedView.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="relative z-[1] mr-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md opacity-70 outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => startExit(displayedView.key, null, displayedView.key)}
              >
                <XIcon className="size-3.5 shrink-0" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}
