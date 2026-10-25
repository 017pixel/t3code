import { create } from "zustand";

import {
  type CommandPaletteUiAction,
  type CommandPaletteUiState,
  reduceCommandPaletteUiState,
} from "./components/CommandPalette.logic";

const INITIAL_STATE: CommandPaletteUiState = {
  open: false,
  mode: "command",
  openIntent: null,
  session: 0,
};

export const useCommandPaletteStore = create<CommandPaletteUiState>(() => INITIAL_STATE);

export function dispatchCommandPalette(action: CommandPaletteUiAction): void {
  useCommandPaletteStore.setState((state) => reduceCommandPaletteUiState(state, action), true);
}

// The palette is only mounted on app-shell routes (not /pair, sign-in or
// landings), so its shortcuts must stay inert elsewhere.
let mountedPalettes = 0;

export function isCommandPaletteMounted(): boolean {
  return mountedPalettes > 0;
}

/** Ref callback for the palette's root; an unmounted palette cannot stay open. */
export function commandPaletteMountRef(node: Element | null): (() => void) | undefined {
  if (node === null) return undefined;
  mountedPalettes += 1;
  return () => {
    mountedPalettes -= 1;
    if (mountedPalettes === 0) {
      useCommandPaletteStore.setState(
        (state) => ({ ...INITIAL_STATE, session: state.session + 1 }),
        true,
      );
    }
  };
}
