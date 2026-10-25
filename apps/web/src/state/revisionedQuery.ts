import * as Option from "effect/Option";
import { Atom, type AtomRegistry } from "effect/reactivity";

// Outside the nodes: a node is dropped once unmounted, and the next read must
// still compare against the revision the query was last read under.
const readRevisions = new WeakMap<AtomRegistry.AtomRegistry, WeakMap<object, string | null>>();

const makeRevisionedFamily = (query: Atom.Atom<unknown>) =>
  Atom.family((revision: string | null) =>
    Atom.readable(
      (get) => {
        // Only a node's first build compares: a node still mounted under the old
        // revision rebuilds when the query refetches, and must not refetch it again.
        if (Option.isNone(get.self())) {
          let revisions = readRevisions.get(get.registry);
          if (revisions === undefined) {
            revisions = new WeakMap();
            readRevisions.set(get.registry, revisions);
          }
          if (revisions.has(query) && revisions.get(query) !== revision) get.refresh(query);
          revisions.set(query, revision);
        }
        return get(query);
      },
      // Refreshing the reader refetches the query it reads.
      (refresh) => refresh(query),
    ),
  );

// Held as long as the query lives, so one (query, revision) pair keeps one atom; an
// `Atom.family` would hold the inner family only weakly and could swap the atom under a reader.
const revisionedFamilies = new WeakMap<
  Atom.Atom<unknown>,
  ReturnType<typeof makeRevisionedFamily>
>();
const revisionedFamily = (query: Atom.Atom<unknown>) => {
  let family = revisionedFamilies.get(query);
  if (family === undefined) {
    family = makeRevisionedFamily(query);
    revisionedFamilies.set(query, family);
  }
  return family;
};

/**
 * Reads `query` under a workspace revision (latest mutation id); a different
 * revision than the last read refetches it. The first read only records the
 * revision. `undefined` reads without taking part, for readers that must not
 * refetch now.
 */
export function revisionedQuery<A>(
  query: Atom.Atom<A>,
  revision: string | null | undefined,
): Atom.Atom<A> {
  if (revision === undefined) return query;
  return revisionedFamily(query)(revision) as Atom.Atom<A>;
}
