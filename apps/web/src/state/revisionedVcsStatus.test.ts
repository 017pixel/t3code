import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeRevisionedVcsStatusFamily, recallCheckoutIsRepo } from "./revisionedVcsStatus";

const environmentId = EnvironmentId.make("environment-1");

type StatusResult = AsyncResult.AsyncResult<{ readonly isRepo: boolean }>;

// A stand-in for the status query: a refresh starts a fetch (counted, shown as waiting) and
// `settle` completes it.
function setup(initial: StatusResult) {
  let fetches = 0;
  const scheduled: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      scheduled.push(task);
      return () => {};
    },
  });
  const server = Atom.make(initial).pipe(Atom.keepAlive);
  const query = Atom.readable(
    (get) => get(server),
    () => {
      fetches += 1;
      registry.set(server, AsyncResult.waiting(registry.get(server)));
    },
  ).pipe(Atom.keepAlive);
  const revisioned = makeRevisionedVcsStatusFamily(() => query);
  const mount = (cwd: string, revision: string | null) => {
    const release = registry.mount(revisioned({ environmentId, input: { cwd }, revision }));
    return () => {
      release();
      for (const task of scheduled.splice(0)) task();
    };
  };
  const settle = (isRepo = true) => registry.set(server, AsyncResult.success({ isRepo }));
  return { mount, settle, fetches: () => fetches };
}

describe("makeRevisionedVcsStatusFamily", () => {
  it("refetches only when a checkout is read under a new revision", () => {
    const { mount, settle, fetches } = setup(AsyncResult.success({ isRepo: true }));

    mount("/repo-a", "mutation-1")();
    expect(fetches()).toBe(0);

    mount("/repo-a", "mutation-1")();
    expect(fetches()).toBe(0);

    mount("/repo-a", "mutation-2")();
    expect(fetches()).toBe(1);
    settle();

    mount("/repo-a", "mutation-1")();
    expect(fetches()).toBe(2);
  });

  it("waits for a fetch in flight before refetching for a new revision", () => {
    const { mount, settle, fetches } = setup(AsyncResult.success({ isRepo: true }));
    mount("/repo-b", "mutation-1")();
    const first = mount("/repo-b", "mutation-2");
    expect(fetches()).toBe(1);
    first();

    const second = mount("/repo-b", "mutation-3");
    expect(fetches()).toBe(1);
    settle();
    expect(fetches()).toBe(2);
    second();
  });

  it("remembers whether the checkout is a repo for later visits", () => {
    const { mount } = setup(AsyncResult.success({ isRepo: false }));
    mount("/plain", null)();
    expect(recallCheckoutIsRepo(environmentId, "/plain")).toBe(false);
    expect(recallCheckoutIsRepo(EnvironmentId.make("environment-1:/"), "plain")).toBeUndefined();
  });
});
