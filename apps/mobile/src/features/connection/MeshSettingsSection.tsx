import { useAtomValue } from "@effect/atom-react";
import type { MeshMemberRow, MeshOutsideRow } from "@t3tools/client-runtime/state/mesh-status";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { ENVIRONMENT_MACHINE_SYMBOLS } from "../../components/EnvironmentMachineSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { meshEnvironment } from "../../state/mesh";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

function alertOnFailure(title: string) {
  return (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Failure") Dialog.alert(title, "Check the connection and try again.");
  };
}

/** EXPERIMENTAL mesh v1: members of this account's mesh, its captain, pin, leave and rejoin. */
export function MeshSettingsSection(props: {
  readonly labelOf: (environmentId: EnvironmentId) => string;
}) {
  const { overview, visible } = useAtomValue(meshEnvironment.overviewAtom);
  if (!visible) return null;
  return (
    <View className="mt-5">
      <SettingsSection
        title="Mesh"
        footer="Experimental. Machines on your T3 Connect account work as one: agents reach every machine, and clients reach them all through the captain."
      >
        {overview.members.map((row) => (
          <MeshMemberActionRow
            key={row.member.environmentId}
            row={row}
            sourceEnvironmentId={overview.sourceEnvironmentId}
          />
        ))}
        {overview.outside.map((row) => (
          <MeshOutsideActionRow
            key={row.environmentId}
            row={row}
            label={props.labelOf(row.environmentId)}
          />
        ))}
      </SettingsSection>
    </View>
  );
}

function MeshMemberActionRow(props: {
  readonly row: MeshMemberRow;
  readonly sourceEnvironmentId: EnvironmentId | null;
}) {
  const { row, sourceEnvironmentId } = props;
  const { member } = row;
  const canPin = useAtomValue(meshEnvironment.setPin.permissionAtom(sourceEnvironmentId));
  const canLeave = useAtomValue(
    meshEnvironment.setEnabled.permissionAtom(row.connected ? member.environmentId : null),
  );
  const setPin = useAtomCommand(meshEnvironment.setPin, "Change the captain pin");
  const setEnabled = useAtomCommand(meshEnvironment.setEnabled, "Leave the mesh");
  const pinAction = canPin && sourceEnvironmentId !== null;
  const description = [
    row.captain ? "Captain" : member.online ? "Online" : "Offline",
    row.pinned ? "Pinned" : null,
    row.note,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const openActions = () =>
    Dialog.alert(member.label, row.note ?? undefined, [
      ...(pinAction
        ? [
            {
              text: row.pinned ? "Unpin captain" : "Pin as captain",
              onPress: () =>
                void setPin({
                  environmentId: sourceEnvironmentId,
                  input: { environmentId: row.pinned ? null : member.environmentId },
                }).then(alertOnFailure("Could not change the captain pin")),
            },
          ]
        : []),
      ...(canLeave
        ? [
            {
              text: "Leave mesh",
              style: "destructive" as const,
              onPress: () =>
                void setEnabled({
                  environmentId: member.environmentId,
                  input: { enabled: false },
                }).then(alertOnFailure("Could not leave the mesh")),
            },
          ]
        : []),
      { text: "Cancel", style: "cancel" as const },
    ]);
  return (
    <ListActionRow
      icon={ENVIRONMENT_MACHINE_SYMBOLS[member.machineKind ?? "server"]}
      label={member.label}
      description={description}
      disabled={!pinAction && !canLeave}
      onPress={openActions}
    />
  );
}

function MeshOutsideActionRow(props: { readonly row: MeshOutsideRow; readonly label: string }) {
  const { row } = props;
  const canRejoin = useAtomValue(meshEnvironment.setEnabled.permissionAtom(row.environmentId));
  const setEnabled = useAtomCommand(meshEnvironment.setEnabled, "Rejoin the mesh");
  return (
    <ListActionRow
      label={row.enabled ? props.label : `Rejoin mesh on ${props.label}`}
      description={row.note}
      disabled={row.enabled || !canRejoin}
      onPress={() =>
        void setEnabled({ environmentId: row.environmentId, input: { enabled: true } }).then(
          alertOnFailure("Could not rejoin the mesh"),
        )
      }
    />
  );
}
