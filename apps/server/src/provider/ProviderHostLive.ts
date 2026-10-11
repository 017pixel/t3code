/**
 * The server's implementation of `ProviderHost.ProviderHost`, the only server surface
 * provider drivers and adapters may use.
 *
 * @module provider/ProviderHostLive
 */
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { ProviderCredentialError } from "@t3tools/provider-core/server/errors";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import { DESKTOP_UPDATE_RESTART_MARKER_FILE } from "@t3tools/contracts";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { pendingUpdateHandoffExists } from "../cloud/updateHandoff.ts";
import { SERVICE_RESTART_MARKER_FILE } from "../cloud/serviceProtocol.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return ProviderHost.ProviderHost.of({
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      serverRestartPending: Effect.gen(function* () {
        if (yield* pendingUpdateHandoffExists) return true;
        const now = yield* Clock.currentTimeMillis;
        for (const name of [DESKTOP_UPDATE_RESTART_MARKER_FILE, SERVICE_RESTART_MARKER_FILE]) {
          const marker = yield* fs
            .stat(path.join(config.baseDir, "runtime", name))
            .pipe(Effect.option);
          if (
            Option.isSome(marker) &&
            Option.isSome(marker.value.mtime) &&
            now - marker.value.mtime.value.getTime() < 60_000
          )
            return true;
        }
        return false;
      }).pipe(
        Effect.provideService(ServerConfig.ServerConfig, config),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      credentials: (namespace, bindingId) =>
        ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              store
                .set(credentials)
                .pipe(
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Crypto.Crypto, crypto),
        ),
    });
  }),
);
