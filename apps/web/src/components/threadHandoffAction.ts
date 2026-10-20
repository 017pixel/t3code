import type { ScopedThreadRef } from "@t3tools/contracts";
import { createStore } from "zustand/vanilla";

let selection: string | null = null;
let generation = 0;
let requestId = 0;
let isAvailable: (ref: ScopedThreadRef) => boolean = () => false;
export type ThreadHandoffRequest = { ref: ScopedThreadRef; generation: number; id: number };
export const threadHandoffRequest = createStore<{ request: ThreadHandoffRequest | null }>(() => ({
  request: null,
}));

export function configureThreadHandoffActions(readAvailable: typeof isAvailable) {
  isAvailable = readAvailable;
}
export function updateThreadHandoffSelection(pathname: string) {
  if (selection !== pathname) {
    selection = pathname;
    generation++;
  }
}
export function isCurrentThreadHandoffRequest(request: ThreadHandoffRequest) {
  return (
    request.generation === generation && threadHandoffRequest.getState().request?.id === request.id
  );
}
export function threadHandoffAction(ref: ScopedThreadRef) {
  const capturedGeneration = generation;
  const available = () => capturedGeneration === generation && isAvailable(ref);
  return {
    available: available(),
    run: () => {
      if (available())
        threadHandoffRequest.setState({ request: { ref, generation, id: ++requestId } });
    },
  };
}
