import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type { VcsRef } from "@t3tools/client-runtime/state/vcs";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

export type BranchCheckoutResult = AtomCommandResult<VcsRef, unknown>;
type BranchCheckoutFailure = Extract<BranchCheckoutResult, { readonly _tag: "Failure" }>;
type BranchCheckoutSuccess = Extract<BranchCheckoutResult, { readonly _tag: "Success" }>;

export interface BranchCheckoutRequest {
  /** The draft route's flow key; the checkout is abandoned once it leaves the stack. */
  readonly flowKey: string;
  /** The draft the checked-out branch is written into. */
  readonly draftKey: string;
  readonly routeKey: string;
  readonly environmentId: EnvironmentId | null;
  readonly workspaceRoot: string | null;
  readonly branch: string;
  readonly worktreePath: string | null;
}

interface CheckoutEntry {
  readonly request: BranchCheckoutRequest;
  readonly checkout: Promise<BranchCheckoutResult>;
  readonly release: () => void;
  abandoned: boolean;
}

/**
 * Branch checkouts for draft routes. A checkout is a Git mutation, so it is
 * tied to the request, not to an atom node: the node can be removed and rebuilt
 * (a render read before the subscription commits) without running it again.
 */
export function makeNewTaskBranchCheckouts(deps: {
  readonly run: (request: BranchCheckoutRequest) => Promise<BranchCheckoutResult>;
  /** Holds navigation until the checkout settles and its route is released. */
  readonly holdNavigation: (operation: Promise<unknown>) => void;
  /** Runs when the checkout succeeds while its route is still on the stack. */
  readonly onSuccess: (request: BranchCheckoutRequest, result: BranchCheckoutSuccess) => void;
  /** Runs once the route is released, unless the route was abandoned first. */
  readonly onFailure: (request: BranchCheckoutRequest, result: BranchCheckoutFailure) => void;
}) {
  // Ignoring a stale result cannot undo its Git mutation, so checkouts run one
  // at a time across routes.
  let tail: Promise<unknown> = Promise.resolve();
  const entries = new Map<string, CheckoutEntry>();
  // The family key is the request's serialized identity; the typed request is
  // registered alongside it so start never has to decode the key.
  const requests = new Map<string, BranchCheckoutRequest>();

  function abandon(key: string, entry: CheckoutEntry): void {
    entry.abandoned = true;
    entry.release();
    entries.delete(key);
    requests.delete(key);
  }

  function start(key: string): Promise<BranchCheckoutResult> {
    const existing = entries.get(key);
    if (existing) return existing.checkout;
    const request = requests.get(key);
    if (!request) return Promise.reject(new Error(`Unknown branch checkout request: ${key}`));
    // A route asks for one checkout at a time; a superseded request no longer
    // owns the route's failure handling or holds navigation.
    for (const [otherKey, other] of entries) {
      if (other.request.flowKey === request.flowKey) abandon(otherKey, other);
    }
    const released = Promise.withResolvers<void>();
    const checkout = tail.then(() => deps.run(request));
    tail = checkout.catch(() => undefined);
    const entry: CheckoutEntry = { request, checkout, release: released.resolve, abandoned: false };
    entries.set(key, entry);
    const handled = checkout.then(async (result) => {
      if (result._tag === "Success") {
        if (!entry.abandoned) deps.onSuccess(request, result);
        return;
      }
      await released.promise;
      if (!entry.abandoned) deps.onFailure(request, result);
    });
    // Navigation waits for the failure handling too, so its goBack lands first.
    deps.holdNavigation(Promise.allSettled([handled, released.promise]));
    return checkout;
  }

  return {
    requestKey(request: BranchCheckoutRequest): string {
      const key = JSON.stringify(request);
      requests.set(key, request);
      return key;
    },
    atom: Atom.family((key: string) =>
      Atom.make(Effect.promise(() => start(key))).pipe(
        Atom.withLabel("mobile:new-task-branch-checkout"),
      ),
    ),
    /** The route rendered with removal unblocked, so navigation may proceed. */
    release(key: string): void {
      entries.get(key)?.release();
    },
    /** Abandons the checkouts of draft routes that are no longer on the stack. */
    prune(liveFlowKeys: ReadonlySet<string>): void {
      for (const [key, entry] of entries) {
        if (!liveFlowKeys.has(entry.request.flowKey)) abandon(key, entry);
      }
    },
  };
}
