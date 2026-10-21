import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "./pathExpansion.ts";

/**
 * `baseEnv` plus `overrides`, read live. Drivers build this once and keep it
 * for every later spawn, and the server can still repair the host PATH after
 * startup (see `recoverLoginShellPath`). A snapshot would pin the stale PATH.
 */
export function overlayEnvironment(
  baseEnv: NodeJS.ProcessEnv,
  overrides: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const own: Record<string, string | undefined> = { ...overrides };
  return new Proxy(own, {
    get: (target, key) =>
      typeof key === "string" && !Object.hasOwn(target, key) && Object.hasOwn(baseEnv, key)
        ? baseEnv[key]
        : Reflect.get(target, key),
    has: (target, key) => key in target || key in baseEnv,
    ownKeys: (target) => [...new Set([...Reflect.ownKeys(baseEnv), ...Reflect.ownKeys(target)])],
    getOwnPropertyDescriptor: (target, key) => {
      if (Object.hasOwn(target, key)) return Reflect.getOwnPropertyDescriptor(target, key);
      if (typeof key !== "string" || !Object.hasOwn(baseEnv, key)) return undefined;
      return { value: baseEnv[key], writable: true, enumerable: true, configurable: true };
    },
    deleteProperty: (target, key) => {
      if (typeof key === "string") target[key] = undefined;
      return true;
    },
  });
}

export const mergeProviderInstanceEnvironment = Effect.fn(function* (
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
) {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const home = yield* HostProcess.HomeDirectory;
  const overrides: Record<string, string> = {};
  for (const variable of environment) {
    // Child processes do not apply shell expansion to environment values.
    overrides[variable.name] =
      variable.name === "CODEX_HOME" || variable.name === "CLAUDE_CONFIG_DIR"
        ? expandHomePath(variable.value, home)
        : variable.value;
  }
  return overlayEnvironment(baseEnv, overrides);
});
