import { ServerConfig, ServerProvider, type ServerConfigStreamEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

type ConfigDelta = Extract<ServerConfigStreamEvent, { readonly type: "configDelta" }>;
const decodeConfig = Schema.decodeUnknownSync(Schema.toType(ServerConfig));
const isServerProvider = Schema.is(ServerProvider);

function changedFields<T extends object>(previous: T, next: T) {
  const changes: Partial<T> = {};
  const removed: string[] = [];
  for (const key of Object.keys(next) as Array<keyof T & string>) {
    if (next[key] === undefined) continue;
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) changes[key] = next[key];
  }
  // JSON drops a field set to undefined, as the config hash does, so it is a removal.
  for (const key of Object.keys(previous) as Array<keyof T & string>) {
    if (previous[key] !== undefined && next[key] === undefined) removed.push(key);
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
    // A patch this build cannot read leaves its provider out, as a snapshot's
    // forward-compatible provider array leaves out a provider it cannot read.
    if (patch.changes === undefined) {
      providers.delete(patch.instanceId);
      continue;
    }
    const provider = { ...providers.get(patch.instanceId), ...patch.changes };
    for (const key of patch.removed) Reflect.deleteProperty(provider, key);
    providers.set(patch.instanceId, provider as ServerConfig["providers"][number]);
  }
  const ordered =
    event.providerOrder === undefined
      ? [...providers.values()]
      : event.providerOrder.flatMap((id) => providers.get(id) ?? []);
  // A patch for a provider this client already left out is partial; leave it out too.
  const decoded = decodeConfig({ ...config, providers: ordered.filter(isServerProvider) });
  // Decoding copies every field. Keep the objects this delta left alone, so readers of
  // unchanged settings, keybindings or providers keep their identity.
  const changed = new Set([...Object.keys(event.changes), ...event.removed]);
  const kept: Record<string, unknown> = { ...decoded };
  for (const key of Object.keys(decoded)) {
    if (key !== "providers" && !changed.has(key) && key in current) {
      kept[key] = current[key as keyof ServerConfig];
    }
  }
  const patched = new Set(event.providerChanges.map((patch) => patch.instanceId));
  const previous = new Map(current.providers.map((provider) => [provider.instanceId, provider]));
  const keptProviders = decoded.providers.map((provider) =>
    patched.has(provider.instanceId) ? provider : (previous.get(provider.instanceId) ?? provider),
  );
  kept.providers =
    keptProviders.length === current.providers.length &&
    keptProviders.every((provider, index) => provider === current.providers[index])
      ? current.providers
      : keptProviders;
  return kept as ServerConfig;
}
