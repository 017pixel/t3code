import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useLocation } from "@tanstack/react-router";

import { ensureClientSettingsHydrated } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { useFirstRunGateView } from "./firstRunGateStore";

/**
 * Nothing renders while pending — no shell, no dialogs — and the bootstrap navigation and
 * desktop bridges wait on the same decision in `firstRunGate`.
 */
export function FirstRunGate({ children }: { readonly children: React.ReactNode }) {
  const view = useFirstRunGateView();
  const pathname = useLocation({ select: (location) => location.pathname });

  if (view.kind === "settings-recovery") {
    return <FirstRunRecovery reason="settings" retrying={view.retrying} />;
  }
  if (view.kind === "connection-recovery") {
    return <FirstRunRecovery reason="connection" />;
  }
  // Away from home the wizard is only owed, so the route opens as asked.
  if (view.kind === "pending" || (view.kind === "wizard" && pathname === "/")) {
    return null;
  }
  return children;
}

function FirstRunRecovery({
  reason,
  retrying = false,
}: {
  readonly reason: "settings" | "connection";
  readonly retrying?: boolean;
}) {
  const settingsReadFailed = reason === "settings";
  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-6 text-foreground">
      <div className="flex max-w-sm flex-col items-center text-center">
        <h1 className="text-lg font-semibold">
          {settingsReadFailed ? "Could not read settings" : "Still connecting"}
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {settingsReadFailed
            ? "Your saved settings could not be loaded."
            : "T3 Code could not confirm this workspace."}
        </p>
        <Button
          className="mt-5"
          size="sm"
          variant="outline"
          disabled={retrying}
          onClick={() => {
            if (settingsReadFailed) {
              void ensureClientSettingsHydrated().catch(() => undefined);
            } else {
              window.location.reload();
            }
          }}
        >
          <RefreshIcon refreshing={retrying} />
          {settingsReadFailed ? "Retry" : "Reload"}
        </Button>
      </div>
    </main>
  );
}
