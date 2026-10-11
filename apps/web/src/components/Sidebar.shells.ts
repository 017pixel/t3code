import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { environmentThreadShells } from "../state/threads";
import { filterSidebarV2VisibleThreads } from "./Sidebar.logic";

/** Hidden child and archived shell updates do not invalidate the sidebar roster. */
export const sidebarThreadShellsAtom = Atom.make((get): readonly EnvironmentThreadShell[] => {
  const next = filterSidebarV2VisibleThreads(get(environmentThreadShells.threadShellsAtom), null);
  const previous = Option.getOrUndefined(get.self<readonly EnvironmentThreadShell[]>());
  return previous?.length === next.length &&
    next.every((thread, index) => thread === previous[index])
    ? previous
    : next;
});
