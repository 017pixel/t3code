import { useAtomValue } from "@effect/atom-react";
import { sessionHasLegacyPermissions, type EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "../hooks/useLocalStorage";
import { useEnvironments } from "../state/environments";
import { environmentSession } from "../state/session";
import { toastManager } from "./ui/toast";

// Keep an active toast across remounts, including Strict Mode effect replay.
const shown = new Set<EnvironmentId>();

// A boolean, so session refetches and focus probes that leave the grant alone
// do not re-render the notice.
const settledOnLegacyPermissionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      session._tag === "Success" && !session.waiting && sessionHasLegacyPermissions(session.value)
    );
  }),
);

function EnvironmentPermissionNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const hasLegacyPermissions = useAtomValue(settledOnLegacyPermissionsAtom(environmentId));
  const navigate = useNavigate();
  useEffect(() => {
    if (!hasLegacyPermissions) return;
    if (shown.has(environmentId)) return;
    const key = `t3code:permission-update:v1:${environmentId}`;
    try {
      if (getLocalStorageItem(key, Schema.Boolean)) return;
    } catch {}
    shown.add(environmentId);
    const persistDismissal = () => {
      try {
        setLocalStorageItem(key, true, Schema.Boolean);
      } catch {}
    };
    const dismiss = () => {
      persistDismissal();
      toastManager.close(id);
    };
    const id = toastManager.add({
      title: `Permissions have changed for ${label}`,
      description:
        "This connection still uses the old permissions, so some actions may no longer be available. Pair again using a new link with the permissions you need.",
      timeout: 0,
      onClose: persistDismissal,
      actionProps: {
        children: "Open Connections",
        onClick: () => {
          dismiss();
          void navigate({ to: "/settings/connections" });
        },
      },
      data: {
        actionLayout: "stacked-end",
        secondaryActionProps: { children: "Dismiss", onClick: dismiss },
        secondaryActionVariant: "ghost",
      },
    });
  }, [environmentId, hasLegacyPermissions, label, navigate]);
  return null;
}

export function PermissionUpdateNotice() {
  const { environments } = useEnvironments();
  return environments.map(({ environmentId, label }) => (
    <EnvironmentPermissionNotice key={environmentId} environmentId={environmentId} label={label} />
  ));
}
