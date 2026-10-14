import type { ServerConfig, ServerConfigStreamEvent } from "@t3tools/contracts";
import { applyServerConfigDelta } from "@t3tools/shared/serverConfigDelta";
import * as Option from "effect/Option";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes and usage-limit sources are current machine state, so a
 * cache could restore a set the machine no longer reports. Replay sends both
 * as separate events.
 */
export function withoutEnvironmentThemes(config: ServerConfig): ServerConfig {
  if (config.environmentThemes === undefined && config.usageLimitSources === undefined) {
    return config;
  }
  const { environmentThemes: _themes, usageLimitSources: _sources, ...rest } = config;
  return rest;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "configUnchanged":
      return Option.map(current, (projection) => ({
        ...projection,
        latestEvent: event,
        source: "live",
      }));
    case "configDelta":
      return Option.map(current, (projection) => ({
        config: applyServerConfigDelta(projection.config, event),
        latestEvent: event,
        source: "live",
      }));
    case "snapshot": {
      // Wire snapshots never contain published themes. Keep the previous set
      // until a capable server sends its authoritative theme event. A legacy
      // server cannot send a later removal, so a downgrade must clear the set.
      const capabilities = event.config.environment.capabilities;
      const carriedThemes =
        capabilities.environmentThemes === true && Option.isSome(current)
          ? current.value.config.environmentThemes
          : undefined;
      const carriedSources =
        capabilities.usageLimitSources === true && Option.isSome(current)
          ? current.value.config.usageLimitSources
          : undefined;
      return Option.some({
        config: {
          ...event.config,
          ...(carriedThemes === undefined ? {} : { environmentThemes: carriedThemes }),
          ...(carriedSources === undefined ? {} : { usageLimitSources: carriedSources }),
        },
        latestEvent: event,
        source: "live" as const,
      });
    }
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: event.payload.keybindings,
          issues: event.payload.issues,
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: event.payload.providers,
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: event.payload.settings,
        },
        latestEvent: event,
        source: "live",
      }));
    // Match the cache's omitted empty sets to preserve config equality.
    case "environmentThemesUpdated":
      return Option.map(current, (projection) => {
        const { environmentThemes: _previous, ...config } = projection.config;
        return {
          config:
            event.payload.themes.length > 0
              ? { ...config, environmentThemes: event.payload.themes }
              : config,
          latestEvent: event,
          source: "live",
        };
      });
    case "usageLimitSourcesUpdated":
      return Option.map(current, (projection) => {
        const { usageLimitSources: _previous, ...config } = projection.config;
        return {
          config:
            event.payload.sources.length > 0
              ? { ...config, usageLimitSources: event.payload.sources }
              : config,
          latestEvent: event,
          source: "live",
        };
      });
  }
}
