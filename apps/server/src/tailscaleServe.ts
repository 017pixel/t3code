import { disableTailscaleServe, ensureTailscaleServe } from "@t3tools/tailscale";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServer } from "effect/http";

import { loopbackUrlHostForAddress } from "./startupAccess.ts";

export const layer = (options: {
  readonly servePort: number;
  readonly parked: Deferred.Deferred<void>;
  readonly awaitActivation: Effect.Effect<void>;
}) =>
  Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.gen(function* () {
        yield* Deferred.succeed(options.parked, undefined).pipe(Effect.orDie);
        yield* options.awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return null;
        }

        const localPort = address.port;
        return yield* ensureTailscaleServe({
          localPort,
          servePort: options.servePort,
          localHost: loopbackUrlHostForAddress(address),
        }).pipe(
          Effect.as({ localPort, servePort: options.servePort }),
          Effect.tap(() =>
            Effect.logInfo("Tailscale Serve configured", {
              localPort,
              servePort: options.servePort,
            }),
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to configure Tailscale Serve", {
              cause,
              localPort,
              servePort: options.servePort,
            }).pipe(Effect.as(null)),
          ),
        );
      }),
      (configured) =>
        configured
          ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
              Effect.tap(() =>
                Effect.logInfo("Tailscale Serve disabled", {
                  servePort: configured.servePort,
                }),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Failed to disable Tailscale Serve", {
                  cause,
                  servePort: configured.servePort,
                }),
              ),
            )
          : Effect.void,
    ),
  );
