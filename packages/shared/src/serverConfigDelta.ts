import { ServerConfig, type ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type ConfigDelta = Extract<ServerConfigStreamEvent, { readonly type: "configDelta" }>;
const decodeConfig = Schema.decodeUnknownSync(Schema.toType(ServerConfig));

function changedFields<T extends object>(previous: T, next: T) {
  const changes: Partial<T> = {};
  const removed: string[] = [];
  for (const key of Object.keys(next) as Array<keyof T & string>) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key];
  }
  for (const key of Object.keys(previous)) {
    if (!(key in next)) removed.push(key);
  }
  return { changes, removed };
}

/** Provider catalogs stay on the client when only health or quota changes. */
export function diffServerConfig(
  previous: ServerConfig,
  next: ServerConfig,
  configVersion: string,
): ConfigDelta {
  const { providers: _previous, ...previousFields } = previous;
  const { providers: _next, ...nextFields } = next;
  const fields = changedFields(previousFields, nextFields);
  const previousProviders = new Map(
    previous.providers.map((provider) => [provider.instanceId, provider]),
  );
  const providerChanges = next.providers.flatMap((provider) => {
    const current = previousProviders.get(provider.instanceId);
    const patch =
      current === undefined ? { changes: provider, removed: [] } : changedFields(current, provider);
    return Object.keys(patch.changes).length === 0 && patch.removed.length === 0
      ? []
      : [{ instanceId: provider.instanceId, ...patch }];
  });
  const providerOrder = next.providers.map((provider) => provider.instanceId);
  return {
    version: 1,
    type: "configDelta",
    configVersion,
    ...fields,
    providerChanges,
    ...(JSON.stringify(previous.providers.map((provider) => provider.instanceId)) ===
    JSON.stringify(providerOrder)
      ? {}
      : { providerOrder }),
  };
}

/** Validate the reconstructed config, including newly added providers and removals. */
export function applyServerConfigDelta(current: ServerConfig, event: ConfigDelta): ServerConfig {
  const config = { ...current, ...event.changes };
  for (const key of event.removed) Reflect.deleteProperty(config, key);
  const providers = new Map(current.providers.map((provider) => [provider.instanceId, provider]));
  for (const patch of event.providerChanges) {
    const provider = { ...providers.get(patch.instanceId), ...patch.changes };
    for (const key of patch.removed) Reflect.deleteProperty(provider, key);
    // Decoded together below so the config's forward-compatible provider array
    // retains its existing behavior for unknown provider states.
    providers.set(patch.instanceId, provider as ServerConfig["providers"][number]);
  }
  return decodeConfig({
    ...config,
    providers:
      event.providerOrder === undefined
        ? [...providers.values()]
        : event.providerOrder.map((id) => providers.get(id)),
  });
}
