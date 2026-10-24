import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The composer scans its project once a thread exists; a new task needs the
 * project's catalog before that. Each project is requested once per
 * connection: the server reuses scans inside its TTL, but a restarted server
 * has none. A failed request is forgotten, so a later render asks again.
 */
export function useProjectModelsRefresh(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly instanceId: ProviderInstanceId | null;
  readonly connected: boolean;
}) {
  const { environmentId, cwd, instanceId, connected } = input;
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const requestedKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!connected) {
      requestedKeyRef.current = null;
      return;
    }
    if (!environmentId || !cwd || !instanceId) return;
    const key = JSON.stringify([environmentId, cwd]);
    if (requestedKeyRef.current === key) return;
    requestedKeyRef.current = key;
    void refreshProviders({ environmentId, input: { instanceId, cwd } }).then((result) => {
      if (!AsyncResult.isSuccess(result) && requestedKeyRef.current === key) {
        requestedKeyRef.current = null;
      }
    });
  }, [connected, cwd, environmentId, instanceId, refreshProviders]);
}
