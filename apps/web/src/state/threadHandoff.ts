import { createThreadHandoffEnvironmentAtoms } from "@t3tools/client-runtime/state/threads";
import { type ScopedThreadRef, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

const thread = Atom.family((key: string) => {
  const ref = JSON.parse(key) as ScopedThreadRef;
  return Atom.make((get) => get(environmentThreadShells.threadShellAtom(ref))?.source ?? null);
});
const connectedAtom = Atom.family((id: EnvironmentId) =>
  Atom.make(
    (get) => get(environmentPresentations.presentationAtom(id))?.connection.phase === "connected",
  ),
);
const supportedAtom = Atom.family((id: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(serverEnvironment.configValueAtom(id))?.environment.capabilities.threadHandoff === true,
  ),
);
const noLocalWork = Atom.make(false);
export const threadHandoffEnvironment = createThreadHandoffEnvironmentAtoms(connectionAtomRuntime, {
  threadAtom: (ref) => thread(JSON.stringify(ref)),
  connectedAtom,
  supportedAtom,
  hasLocalWorkAtom: () => noLocalWork,
});
