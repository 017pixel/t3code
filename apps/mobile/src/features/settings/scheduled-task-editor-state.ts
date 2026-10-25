import type { EnvironmentId } from "@t3tools/contracts";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { Atom } from "effect/reactivity";

import { findLinkedRoute } from "../../lib/appLinking";

import { appAtomRegistry } from "../../state/atom-registry";
import type { ScheduledTaskDraft } from "./scheduledTaskDraft";

export type ScheduledTaskEditor = {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly draft: ScheduledTaskDraft;
};

type ScheduledTaskEditorSession = {
  readonly id: number;
  readonly initial: ScheduledTaskEditor | null;
  readonly current: ScheduledTaskEditor | null;
};

export const scheduledTaskEditorSessionAtom = Atom.make<ScheduledTaskEditorSession | null>(
  null,
).pipe(Atom.keepAlive);
let nextEditorId = 0;

export function startScheduledTaskEditor(next: ScheduledTaskEditor | null): void {
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: ++nextEditorId,
    initial: next,
    current: next,
  });
}

export function updateScheduledTaskEditor(
  update:
    | ScheduledTaskEditor
    | null
    | ((current: ScheduledTaskEditor | null) => ScheduledTaskEditor | null),
  defaultEditor: ScheduledTaskEditor | null,
): void {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  const previous = session ? session.current : defaultEditor;
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, {
    id: session?.id ?? 0,
    initial: session ? session.initial : previous,
    current: typeof update === "function" ? update(previous) : update,
  });
}

export function readScheduledTaskEditor(
  voiceOwnerKey: string,
  defaultEditor: ScheduledTaskEditor | null,
): ScheduledTaskEditor | null {
  const session = appAtomRegistry.get(scheduledTaskEditorSessionAtom);
  if (`scheduled-task:${session?.id ?? 0}` !== voiceOwnerKey) return null;
  return session ? session.current : defaultEditor;
}

/**
 * A link to the new-task screen starts a fresh editor, like the in-app "New
 * task" action. Without this a warm app would reopen the last edited task's
 * draft under the "New" title and save over that task.
 */
export function takeScheduledTaskNewLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (findLinkedRoute(state, ["SettingsScheduledTaskNew"])) {
    appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
  }
  return state;
}
