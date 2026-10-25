import { Atom } from "effect/reactivity";

import { subscribeAppActive } from "./appState";

/**
 * A system permission as the app last saw it. Reads it when first mounted and
 * again each time the app returns to the foreground, where the user may have
 * changed it in system Settings. Writing stores the outcome of a request.
 */
export function makePermissionStatusAtom<S>(options: {
  readonly label: string;
  readonly initial: S;
  readonly read: () => Promise<S>;
}): Atom.Writable<S, S> {
  return Atom.writable(
    (get) => {
      let active = true;
      const refresh = () => {
        void options.read().then((status) => {
          if (active) get.setSelf(status);
        });
      };
      refresh();
      const unsubscribe = subscribeAppActive(refresh);
      get.addFinalizer(() => {
        active = false;
        unsubscribe();
      });
      return options.initial;
    },
    (ctx, status: S) => ctx.setSelf(status),
  ).pipe(Atom.withLabel(options.label));
}
