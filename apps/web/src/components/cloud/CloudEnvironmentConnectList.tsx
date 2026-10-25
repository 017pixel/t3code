import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { type EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import { relayOfflineReasonMessage } from "@t3tools/client-runtime/relay";
import {
  type EnvironmentId,
  resolveEnvironmentMachineKind,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { RelayClientEnvironmentRecord } from "@t3tools/contracts/relay";
import { type ReactNode, useContext, useState } from "react";

import { cn } from "~/lib/utils";
import { relayEnvironmentDiscovery } from "~/state/relay";
import { useRelayEnvironmentDiscovery } from "~/state/environments";
import { useAtomCommand } from "~/state/use-atom-command";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "../settings/itemRows";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { presentSavedCloudEnvironmentConnection } from "./cloudEnvironmentConnectionPresentation";
import {
  type ComputerSelection,
  connectRelayEnvironment,
  discoveredCompatibilityError,
  relayConnectingIdsAtom,
  makeRelayDiscoveryRefreshAtom,
} from "./relayDiscoveryStore";

export interface SavedCloudEnvironmentConnection {
  readonly environmentId: EnvironmentId;
  readonly connection: EnvironmentConnectionPresentation;
  readonly relayManaged: boolean;
  readonly serverConfig?: Pick<ServerConfig, "environment"> | null;
}

function RemoteEnvironmentRowsSkeleton() {
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton shape="pill" className="h-4 w-32" />
          <Skeleton shape="pill" className="h-3 w-20" />
        </div>
        <Skeleton className="h-7 w-16" />
      </div>
    </div>
  );
}

export function CloudEnvironmentConnectRows({
  primaryEnvironmentId,
  savedEnvironments,
  showSavedEnvironments = false,
  empty = null,
  selection,
}: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly savedEnvironments: ReadonlyArray<SavedCloudEnvironmentConnection>;
  readonly showSavedEnvironments?: boolean;
  readonly empty?: ReactNode;
  /** Onboarding pick list: auto-selects new computers and polls discovery while none is listed. */
  readonly selection?: {
    readonly store: ComputerSelection;
    readonly selectedIds: ReadonlySet<EnvironmentId>;
  };
}) {
  const registry = useContext(RegistryContext);
  const environmentsState = useRelayEnvironmentDiscovery();
  const [refreshOnViewAtom] = useState(makeRelayDiscoveryRefreshAtom);
  useAtomMount(selection?.store.discoveryAtom ?? refreshOnViewAtom);
  const refreshRelayEnvironments = useAtomCommand(relayEnvironmentDiscovery.refresh, {
    reportFailure: false,
  });
  const connectingEnvironmentIds = useAtomValue(relayConnectingIdsAtom);
  const connectEnvironment = (environment: RelayClientEnvironmentRecord) =>
    connectRelayEnvironment(registry, environment);
  const savedById = new Map(
    savedEnvironments
      .filter((environment) => environment.relayManaged)
      .map((environment) => [environment.environmentId, environment]),
  );
  const savedWithoutRelay = new Set(
    savedEnvironments
      .filter((environment) => !environment.relayManaged)
      .map((environment) => environment.environmentId),
  );

  // Omit machines saved over other routes; onboarding selection must not add a T3 Connect route.
  const isVisibleEnvironment = (environmentId: EnvironmentId) =>
    environmentId !== primaryEnvironmentId &&
    (showSavedEnvironments || !savedById.has(environmentId)) &&
    !(selection && savedWithoutRelay.has(environmentId));
  const visibleEnvironments = [...environmentsState.environments.values()].filter(
    ({ environment }) => isVisibleEnvironment(environment.environmentId),
  );
  const standalone = showSavedEnvironments || savedEnvironments.length === 0;

  if (
    !selection &&
    standalone &&
    visibleEnvironments.length === 0 &&
    environmentsState.refreshing &&
    environmentsState.environments.size === 0
  ) {
    return <RemoteEnvironmentRowsSkeleton />;
  }

  if (standalone && visibleEnvironments.length === 0) {
    const discoveryProblem = environmentsState.offline
      ? "You appear to be offline."
      : (Option.getOrNull(environmentsState.error)?.message ?? null);
    if (discoveryProblem !== null && !environmentsState.refreshing) {
      return (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-sm font-medium text-destructive">
            Could not load T3 Connect environments
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{discoveryProblem}</p>
          <Button
            size="sm"
            variant="outline"
            className="mt-3"
            onClick={() => void refreshRelayEnvironments()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return empty;
  }

  return visibleEnvironments.map(({ environment, availability, error, status }) => {
    const savedEnvironment = savedById.get(environment.environmentId);
    const compatibilityError = discoveredCompatibilityError(status);
    const unsupported =
      compatibilityError !== null || savedEnvironment?.connection.phase === "unsupported";
    const unsupportedDetail =
      compatibilityError?.message ?? savedEnvironment?.connection.error ?? null;
    const savedConnection = unsupported
      ? presentSavedCloudEnvironmentConnection({
          phase: "unsupported",
          error: unsupportedDetail,
          traceId: null,
        })
      : savedEnvironment
        ? presentSavedCloudEnvironmentConnection(savedEnvironment.connection)
        : null;
    const relayStatus = status === undefined ? null : Option.getOrNull(status);
    const descriptor = relayStatus?.descriptor;
    const offlineReason =
      availability === "offline" && relayStatus !== null
        ? relayOfflineReasonMessage(relayStatus)
        : null;
    const machineKind = resolveEnvironmentMachineKind(
      savedEnvironment?.serverConfig ??
        (descriptor === undefined ? null : { environment: descriptor }),
    );
    const dotClassName = savedConnection
      ? savedConnection.tone === "connected"
        ? "bg-success"
        : savedConnection.tone === "connecting"
          ? "bg-warning"
          : savedConnection.tone === "error"
            ? "bg-destructive"
            : "bg-muted-foreground/35"
      : availability === "online"
        ? "bg-success"
        : availability === "error"
          ? "bg-destructive"
          : availability === "checking"
            ? "bg-warning"
            : "bg-muted-foreground/35";
    const notAdded = savedWithoutRelay.has(environment.environmentId)
      ? "Saved without T3 Connect"
      : "Not added";
    const statusText =
      unsupported && !savedEnvironment
        ? `T3 Connect · ${notAdded} · Client not supported`
        : offlineReason !== null
          ? offlineReason
          : savedConnection
            ? savedConnection.statusText
            : availability === "online"
              ? `T3 Connect · ${notAdded} · Relay online`
              : availability === "offline"
                ? `T3 Connect · ${notAdded} · Relay offline`
                : availability === "checking"
                  ? `T3 Connect · ${notAdded} · Checking relay status…`
                  : (Option.getOrNull(error)?.message ??
                    `T3 Connect · ${notAdded} · Relay status unavailable`);
    if (selection) {
      return (
        <label
          key={environment.environmentId}
          className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-background px-3 py-2.5 has-disabled:cursor-default"
        >
          <Checkbox
            checked={!unsupported && selection.selectedIds.has(environment.environmentId)}
            disabled={unsupported || connectingEnvironmentIds.has(environment.environmentId)}
            onCheckedChange={async (checked) => {
              if (unsupported) return;
              selection.store.choose(environment.environmentId, checked);
              if (checked && !savedEnvironment) {
                const connected = await connectEnvironment(environment);
                if (!connected) selection.store.choose(environment.environmentId, false);
              }
            }}
          />
          <EnvironmentMachineIcon
            aria-hidden
            kind={machineKind}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{environment.label}</span>
            {unsupportedDetail !== null ? (
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {unsupportedDetail}
              </span>
            ) : null}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={<span tabIndex={0} />}
              className={cn(
                "max-w-[45%] shrink-0 truncate text-xs",
                savedConnection?.tone === "error" ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {connectingEnvironmentIds.has(environment.environmentId)
                ? "Connecting…"
                : (savedConnection?.buttonLabel ??
                  (availability === "online"
                    ? "Available"
                    : availability === "offline"
                      ? "Offline"
                      : availability === "error"
                        ? "Unavailable"
                        : "Checking…"))}
            </TooltipTrigger>
            <TooltipPopup>{unsupportedDetail ?? statusText}</TooltipPopup>
          </Tooltip>
        </label>
      );
    }
    return (
      <div key={environment.environmentId} className={ITEM_ROW_CLASSNAME}>
        <div className={ITEM_ROW_INNER_CLASSNAME}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <ConnectionStatusDot
                dotClassName={dotClassName}
                pingClassName={
                  savedConnection?.tone === "connecting" ||
                  (savedConnection === null && availability === "checking")
                    ? "bg-warning/60 duration-2000"
                    : null
                }
                tooltipText={
                  unsupportedDetail !== null
                    ? unsupportedDetail
                    : offlineReason !== null
                      ? offlineReason
                      : savedConnection
                        ? savedConnection.statusText
                        : availability === "online"
                          ? "Relay online"
                          : availability === "offline"
                            ? "Relay offline"
                            : availability === "checking"
                              ? "Checking relay status"
                              : (Option.getOrNull(error)?.message ?? "Relay status unavailable")
                }
              />
              <EnvironmentMachineIcon
                aria-hidden
                kind={machineKind}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <p className="truncate text-sm font-medium">{environment.label}</p>
            </div>
            <p
              className={cn(
                "mt-1 truncate text-xs",
                savedConnection?.tone === "error" ||
                  (savedConnection?.tone === "connecting" && savedEnvironment?.connection.error) ||
                  (savedConnection === null && availability === "error")
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {statusText}
            </p>
          </div>
          {unsupported && !savedEnvironment ? (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" tabIndex={0} />}>
                <Button size="sm" disabled>
                  Add
                </Button>
              </TooltipTrigger>
              <TooltipPopup>{unsupportedDetail ?? "Client not supported"}</TooltipPopup>
            </Tooltip>
          ) : savedConnection ? (
            <Button size="sm" variant="outline" disabled>
              {savedConnection.buttonLabel}
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={connectingEnvironmentIds.size > 0}
              onClick={() => void connectEnvironment(environment)}
            >
              {connectingEnvironmentIds.has(environment.environmentId)
                ? "Adding…"
                : savedWithoutRelay.has(environment.environmentId)
                  ? "Add route"
                  : "Add"}
            </Button>
          )}
        </div>
      </div>
    );
  });
}
