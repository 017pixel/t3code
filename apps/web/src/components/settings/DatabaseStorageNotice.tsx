import type { EnvironmentId } from "@t3tools/contracts";
import { shouldRecommendDatabaseCompaction } from "@t3tools/shared/databaseStorage";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { SettingsRow } from "./settingsLayout";

export function DatabaseStorageNotice({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const result = useAtomValue(serverEnvironment.databaseStorage({ environmentId, input: {} }));
  const [dismissed, setDismissed] = useLocalStorage(
    `database-compaction-dismissed:${environmentId}`,
    false,
    Schema.Boolean,
  );
  const { copyToClipboard } = useCopyToClipboard({ target: "maintenance command" });
  const status = result._tag === "Success" ? result.value : null;
  if (dismissed || status === null || !shouldRecommendDatabaseCompaction(status)) return null;
  return (
    <SettingsRow
      title={`Reclaim ${formatBytes(status.reclaimableBytes)} on ${label}`}
      description={
        <>
          History cleanup is already automatic. To return unused space to disk and enable automatic
          shrinking, quit T3 and stop its server on {label}, then run this command there. It may
          take several minutes and needs temporary disk space.
          <code className="mt-2 block select-text break-all">{status.compactCommand}</code>
        </>
      }
      control={
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(status.compactCommand, undefined)}
          >
            Copy command
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        </div>
      }
    />
  );
}
