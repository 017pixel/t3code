/**
 * Standalone issue trackers (Linear, Jira) as the settings page manages them: one credential per
 * tracker kind in the secret store, with its status read live from the tracker, and the
 * per-project binding that puts a tracker's scope beside the project's git-host issues.
 * Disconnecting clears the bindings that pointed at the tracker.
 *
 * Nothing here knows which trackers exist: the registry lists them and each driver's descriptor
 * says what to call the credential and the scope. Adding a tracker adds no code here.
 *
 * @module issue/IssueTrackerConnections
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import {
  IssueTrackerConnectionError,
  type IssueTrackerBindProjectInput,
  type IssueTrackerConnectInput,
  type IssueTrackerConnection,
  type IssueTrackerConnectionList,
  type IssueTrackerKind,
} from "@t3tools/contracts";
import type { StandaloneIssueTrackerApi } from "@t3tools/issue-tracker-core/server/IssueTracker";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as IssueTrackerBindings from "../persistence/IssueTrackerBindings.ts";
import { issueTrackerSecretName } from "./IssueTrackerHostLive.ts";
import * as IssueTrackerRegistry from "./IssueTrackerRegistry.ts";

const encoder = new TextEncoder();

export class IssueTrackerConnections extends Context.Service<
  IssueTrackerConnections,
  {
    /** Every standalone tracker, each probed against its stored credential, and the bindings. */
    readonly list: Effect.Effect<IssueTrackerConnectionList, IssueTrackerConnectionError>;
    /**
     * Vets the credential with the tracker and stores it only when the tracker accepts it. A null
     * token removes the stored one and unbinds every project that pointed at the tracker.
     */
    readonly connect: (
      input: IssueTrackerConnectInput,
    ) => Effect.Effect<IssueTrackerConnection, IssueTrackerConnectionError>;
    /** Binds a project to one of a tracker's scopes, or unbinds it with a null binding. */
    readonly bindProject: (
      input: IssueTrackerBindProjectInput,
    ) => Effect.Effect<void, IssueTrackerConnectionError>;
  }
>()("t3/issue/IssueTrackerConnections") {}

export const make = Effect.gen(function* () {
  const registry = yield* IssueTrackerRegistry.IssueTrackerRegistry;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const bindings = yield* IssueTrackerBindings.IssueTrackerBindingsRepository;

  const requireTracker = (
    tracker: IssueTrackerKind,
  ): Effect.Effect<StandaloneIssueTrackerApi, IssueTrackerConnectionError> => {
    const found = registry.standalone.find((api) => api.kind === tracker);
    return found === undefined
      ? Effect.fail(
          new IssueTrackerConnectionError({
            tracker,
            reason: "unknown-tracker",
            detail: "This server has no such issue tracker.",
          }),
        )
      : Effect.succeed(found);
  };

  const secretFailure = (tracker: IssueTrackerKind, detail: string) => (cause: unknown) =>
    new IssueTrackerConnectionError({ tracker, reason: "failed", detail, cause });

  const disconnected = (api: StandaloneIssueTrackerApi): IssueTrackerConnection => ({
    ...api.standalone,
    connected: false,
    account: null,
    detail: null,
    scopes: [],
  });

  /** The tracker's view of a stored credential; a refusal is status, not a failure. */
  const status = (api: StandaloneIssueTrackerApi, token: string) =>
    api.probeCredential(token).pipe(
      Effect.map((probe): IssueTrackerConnection => ({
        ...api.standalone,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
      })),
      Effect.catch((error) =>
        Effect.succeed<IssueTrackerConnection>({
          ...api.standalone,
          connected: true,
          account: null,
          detail: error.detail,
          scopes: [],
        }),
      ),
    );

  const current = (api: StandaloneIssueTrackerApi) =>
    secrets.get(issueTrackerSecretName(api.kind)).pipe(
      Effect.mapError(secretFailure(api.kind, "The stored credential could not be read.")),
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(disconnected(api))
          : status(api, new TextDecoder().decode(stored.value)),
      ),
    );

  const list: IssueTrackerConnections["Service"]["list"] = Effect.all({
    trackers: Effect.forEach(registry.standalone, current, { concurrency: 4 }),
    bindings: bindings.list.pipe(
      Effect.map((bound) => Object.fromEntries(bound)),
      Effect.mapError(
        (cause) =>
          // No single tracker is at fault; the first registered one carries the report.
          new IssueTrackerConnectionError({
            tracker: registry.standalone[0]?.kind ?? ("unknown" as IssueTrackerKind),
            reason: "failed",
            detail: "The project bindings could not be read.",
            cause,
          }),
      ),
    ),
  });

  const disconnect = (api: StandaloneIssueTrackerApi) =>
    Effect.gen(function* () {
      yield* secrets
        .remove(issueTrackerSecretName(api.kind))
        .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be removed.")));
      // Bindings to a tracker nobody is signed into would only produce errors in every listing.
      yield* bindings
        .removeTracker(api.kind)
        .pipe(
          Effect.mapError(secretFailure(api.kind, "The project bindings could not be cleared.")),
        );
      return disconnected(api);
    });

  const connect: IssueTrackerConnections["Service"]["connect"] = (input) =>
    Effect.gen(function* () {
      const api = yield* requireTracker(input.tracker);
      if (input.token === null) return yield* disconnect(api);
      const probe = yield* api.probeCredential(input.token).pipe(
        Effect.mapError(
          (error) =>
            new IssueTrackerConnectionError({
              tracker: input.tracker,
              reason: error.reason === "unauthenticated" ? "rejected" : "failed",
              detail: error.detail,
              cause: error,
            }),
        ),
      );
      yield* secrets
        .set(issueTrackerSecretName(api.kind), encoder.encode(input.token))
        .pipe(Effect.mapError(secretFailure(api.kind, "The credential could not be stored.")));
      return {
        ...api.standalone,
        connected: true,
        account: probe.account,
        detail: null,
        scopes: probe.scopes,
      };
    });

  const bindProject: IssueTrackerConnections["Service"]["bindProject"] = (input) =>
    Effect.gen(function* () {
      const api = input.binding === null ? null : yield* requireTracker(input.binding.tracker);
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* bindings
        .set({ projectId: input.projectId, binding: input.binding, updatedAt })
        .pipe(
          Effect.mapError(
            secretFailure(
              api?.kind ??
                input.binding?.tracker ??
                registry.standalone[0]?.kind ??
                ("unknown" as IssueTrackerKind),
              "The project binding could not be saved.",
            ),
          ),
        );
    });

  return IssueTrackerConnections.of({ list, connect, bindProject });
});

export const layer = Layer.effect(IssueTrackerConnections, make);
