import { useAtomValue } from "@effect/atom-react";
import type { MeshMemberRow, MeshOutsideRow } from "@t3tools/client-runtime/state/mesh-status";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { EllipsisIcon, ShipWheelIcon } from "lucide-react";

import { requestConfirmDialog } from "~/confirmDialog";
import type { EnvironmentPresentation } from "~/state/environments";
import { meshEnvironment } from "~/state/mesh";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";

function toastOnFailure(title: string) {
  return (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      ...(error instanceof Error ? { description: error.message } : {}),
    });
  };
}

/** EXPERIMENTAL mesh v1: members of this account's mesh, its captain, pin, leave and rejoin. */
export function MeshSettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { overview, visible } = useAtomValue(meshEnvironment.overviewAtom);
  if (!visible) return null;
  const captain = overview.members.find((row) => row.captain)?.member.label ?? null;
  return (
    <FoldedSettingsSection
      id="mesh"
      title="Mesh"
      summary={
        overview.members.length === 0
          ? (overview.outside[0]?.note ?? null)
          : [
              overview.members.length === 1 ? "1 machine" : `${overview.members.length} machines`,
              captain === null ? "no captain" : `captain ${captain}`,
            ].join(" · ")
      }
    >
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Experimental. Machines on your T3 Connect account work as one: agents reach every machine,
        and clients reach them all through the captain.
      </p>
      {overview.members.map((row) => (
        <MeshMemberSettingsRow
          key={row.member.environmentId}
          row={row}
          sourceEnvironmentId={overview.sourceEnvironmentId}
        />
      ))}
      {overview.outside.map((row) => (
        <MeshOutsideSettingsRow
          key={row.environmentId}
          row={row}
          environment={
            environments.find((environment) => environment.environmentId === row.environmentId) ??
            null
          }
        />
      ))}
    </FoldedSettingsSection>
  );
}

function MeshMemberSettingsRow({
  row,
  sourceEnvironmentId,
}: {
  readonly row: MeshMemberRow;
  readonly sourceEnvironmentId: EnvironmentId | null;
}) {
  const { member } = row;
  const canPin = useAtomValue(meshEnvironment.setPin.permissionAtom(sourceEnvironmentId));
  const canLeave = useAtomValue(
    meshEnvironment.setEnabled.permissionAtom(row.connected ? member.environmentId : null),
  );
  const setPin = useAtomCommand(meshEnvironment.setPin, "Change the captain pin");
  const setEnabled = useAtomCommand(meshEnvironment.setEnabled, "Leave the mesh");
  const leave = async () => {
    const confirmed = await requestConfirmDialog(
      `Leave the mesh on ${member.label}?\nOther machines and their agents stop reaching it. You can rejoin here.`,
      { variant: "destructive" },
    );
    if (confirmed === true) {
      toastOnFailure("Could not leave the mesh")(
        await setEnabled({ environmentId: member.environmentId, input: { enabled: false } }),
      );
    }
  };
  const status = [
    row.captain ? "Captain" : member.online ? "Online" : "Offline",
    row.pinned ? "Pinned" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <EnvironmentRow
      kind={member.machineKind ?? "server"}
      label={member.label}
      dimmed={!member.online}
      subtitle={
        <span className="flex min-w-0 items-center gap-1">
          {row.captain ? <ShipWheelIcon aria-hidden className="size-3 shrink-0" /> : null}
          <span className="truncate">{status}</span>
        </span>
      }
      below={
        row.note === null ? null : (
          <p className="truncate text-xs text-warning-foreground">{row.note}</p>
        )
      }
    >
      {(canPin && sourceEnvironmentId !== null) || canLeave ? (
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-xs"
                aria-label={`Mesh actions for ${member.label}`}
              />
            }
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end">
            {canPin && sourceEnvironmentId !== null ? (
              <MenuItem
                onClick={() =>
                  void setPin({
                    environmentId: sourceEnvironmentId,
                    input: { environmentId: row.pinned ? null : member.environmentId },
                  }).then(toastOnFailure("Could not change the captain pin"))
                }
              >
                {row.pinned ? "Unpin captain" : "Pin as captain"}
              </MenuItem>
            ) : null}
            {canLeave ? (
              <>
                {canPin ? <MenuSeparator /> : null}
                <MenuItem variant="destructive" onClick={() => void leave()}>
                  Leave mesh…
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : null}
    </EnvironmentRow>
  );
}

function MeshOutsideSettingsRow({
  row,
  environment,
}: {
  readonly row: MeshOutsideRow;
  readonly environment: EnvironmentPresentation | null;
}) {
  const canRejoin = useAtomValue(meshEnvironment.setEnabled.permissionAtom(row.environmentId));
  const setEnabled = useAtomCommand(meshEnvironment.setEnabled, "Rejoin the mesh");
  return (
    <EnvironmentRow
      kind={resolveEnvironmentMachineKind(environment?.serverConfig ?? null)}
      label={environment?.label ?? row.environmentId}
      dimmed
      subtitle={row.note}
    >
      {!row.enabled && canRejoin ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void setEnabled({ environmentId: row.environmentId, input: { enabled: true } }).then(
              toastOnFailure("Could not rejoin the mesh"),
            )
          }
        >
          Rejoin
        </Button>
      ) : null}
    </EnvironmentRow>
  );
}
