import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { vcsEnvironment } from "./vcs";

type VcsStatusTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly cwd: string };
};

const decodeKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.String, Schema.NullOr(Schema.String)]),
);

// Git status for a checkout arrives after the composer paints, and the branch
// strip mounts on the assumption that a project is a Git repo. Without a
// memory, a non-Git project would mount the strip and drop it on every visit.
const sessionCheckoutIsRepo = new Map<string, boolean>();

function checkoutIsRepoKey(environmentId: EnvironmentId, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

function rememberCheckoutIsRepo(environmentId: EnvironmentId, cwd: string, isRepo: boolean): void {
  sessionCheckoutIsRepo.set(checkoutIsRepoKey(environmentId, cwd), isRepo);
}

export function recallCheckoutIsRepo(
  environmentId: EnvironmentId,
  cwd: string | null,
): boolean | undefined {
  return cwd === null
    ? undefined
    : sessionCheckoutIsRepo.get(checkoutIsRepoKey(environmentId, cwd));
}

const isSettled = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  result._tag !== "Initial" && !result.waiting;

/**
 * A checkout's VCS status at a workspace revision (the latest turn's mutation id). The status is
 * one query per checkout; each registry records the revision it was last read under, and reading
 * another revision refetches it, after any fetch already in flight settles. The first read of a
 * checkout only records its revision. Each result also records whether the checkout is a repo.
 */
export function makeRevisionedVcsStatusFamily<A extends { readonly isRepo: boolean }, E>(
  status: (target: VcsStatusTarget) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  // Outside the nodes: a node is dropped once unmounted, and the next read must still see the
  // revision the checkout was last read under.
  const readUnder = new WeakMap<AtomRegistry.AtomRegistry, Map<string, string | null>>();
  const family = Atom.family((key: string) => {
    const [environmentId, cwd, revision] = decodeKey(JSON.parse(key));
    const checkoutKey = JSON.stringify([environmentId, cwd]);
    const query = status({ environmentId, input: { cwd } });
    return Atom.transform(
      query,
      (get) => {
        let records = readUnder.get(get.registry);
        if (records === undefined) {
          records = new Map();
          readUnder.set(get.registry, records);
        }
        const firstRead = !records.has(checkoutKey);
        let pending = records.get(checkoutKey) !== revision;
        const current = get.once(query);
        if (pending && (firstRead || isSettled(current))) {
          pending = false;
          records.set(checkoutKey, revision);
          if (!firstRead) get.refresh(query);
        }
        const remember = (value: AsyncResult.AsyncResult<A, E>) => {
          if (value._tag === "Success")
            rememberCheckoutIsRepo(environmentId, cwd, value.value.isRepo);
        };
        remember(current);
        get.subscribe(query, (value) => {
          remember(value);
          get.setSelf(value);
          if (!pending || !isSettled(value)) return;
          pending = false;
          records.set(checkoutKey, revision);
          get.refresh(query);
        });
        return get.once(query);
      },
      { initialValueTarget: query },
    ).pipe(Atom.setIdleTTL(0));
  });
  return (target: VcsStatusTarget & { readonly revision: string | null }) =>
    family(JSON.stringify([target.environmentId, target.input.cwd, target.revision]));
}

export const revisionedVcsStatus = makeRevisionedVcsStatusFamily(vcsEnvironment.status);
