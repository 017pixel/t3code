import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { shouldRecommendDatabaseCompaction } from "@t3tools/shared/databaseStorage";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

export function DatabaseStorageNotice({ target }: { readonly target: SettingsTarget }) {
  const result = useAtomValue(
    serverEnvironment.databaseStorage({ environmentId: target.environmentId, input: {} }),
  );
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const dismissed =
    preferences._tag === "Success" &&
    preferences.value.dismissedDatabaseNotices?.includes(target.environmentId);
  const status = result._tag === "Success" ? result.value : null;
  if (dismissed || status === null || !shouldRecommendDatabaseCompaction(status)) return null;
  const gib = (status.reclaimableBytes / 1024 ** 3).toFixed(1);
  return (
    <SettingsSection title={`Reclaim ${gib} GB on ${target.label}`}>
      <View className="gap-3 p-4">
        <Text className="text-sm text-muted-foreground">
          History cleanup is automatic. To return unused space to disk and enable automatic
          shrinking, quit T3 and stop its server on {target.label}, then run this command there. It
          may take several minutes and needs temporary disk space.
        </Text>
        <Text selectable className="font-mono text-sm text-foreground">
          {status.compactCommand}
        </Text>
      </View>
      <SettingsActionRow
        icon="doc.on.doc"
        label="Copy command"
        onPress={() => copyTextWithHaptic(status.compactCommand, { target: "maintenance command" })}
      />
      <SettingsActionRow
        icon="xmark"
        label="Dismiss"
        onPress={() =>
          updatePreferences({
            transform: (current) => ({
              dismissedDatabaseNotices: [
                ...new Set([...(current.dismissedDatabaseNotices ?? []), target.environmentId]),
              ],
            }),
          })
        }
      />
    </SettingsSection>
  );
}
