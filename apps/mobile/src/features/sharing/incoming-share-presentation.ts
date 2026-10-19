export interface IncomingSharePresentationState {
  readonly presentedShareId: string | null;
  readonly sheetSeen: boolean;
  readonly discardedShareId: string | null;
}

export interface IncomingSharePresentationTransition {
  readonly state: IncomingSharePresentationState;
  readonly shareIdToPresent: string | null;
  readonly shareIdToDiscard: string | null;
}

export const EMPTY_INCOMING_SHARE_PRESENTATION_STATE: IncomingSharePresentationState = {
  presentedShareId: null,
  sheetSeen: false,
  discardedShareId: null,
};

interface RouteLike {
  readonly name: string;
  readonly params?: object;
  readonly state?: { readonly routes: ReadonlyArray<RouteLike> };
}

function incomingShareIdOfParams(params: object | undefined): string | null {
  if (!params || !("incomingShareId" in params)) return null;
  const value = params.incomingShareId;
  const id = Array.isArray(value) ? value[0] : value;
  return typeof id === "string" ? id : null;
}

// A root route above the sheet leaves it open. Before the nested navigator
// mounts, the share ID lives in the navigate payload instead of its routes.
export function incomingShareIdOfSheetRoute(
  state: { readonly routes: ReadonlyArray<RouteLike> },
  sheetRouteName: string,
): { readonly isSheetPresented: boolean; readonly shareId: string | null } {
  const sheet = state.routes.find((route) => route.name === sheetRouteName);
  if (!sheet) {
    return { isSheetPresented: false, shareId: null };
  }
  for (const route of sheet.state?.routes ?? []) {
    const shareId = incomingShareIdOfParams(route.params);
    if (shareId !== null) return { isSheetPresented: true, shareId };
  }
  const payload =
    sheet.params && "params" in sheet.params && typeof sheet.params.params === "object"
      ? (sheet.params.params as object | null)
      : null;
  return { isSheetPresented: true, shareId: incomingShareIdOfParams(payload ?? undefined) };
}

export function transitionIncomingSharePresentation(
  state: IncomingSharePresentationState,
  input: {
    readonly isSheetPresented: boolean;
    readonly sheetShareId: string | null;
    readonly pendingShareId: string | null;
  },
): IncomingSharePresentationTransition {
  const hold = { state, shareIdToPresent: null, shareIdToDiscard: null };
  const { pendingShareId } = input;

  if (pendingShareId === null) {
    return {
      state: EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
      shareIdToPresent: null,
      shareIdToDiscard: null,
    };
  }

  if (state.discardedShareId === pendingShareId) {
    // The inbox has not caught up with the discard yet.
    return hold;
  }

  const tracked = state.presentedShareId;
  if (input.isSheetPresented) {
    if (tracked !== null && input.sheetShareId === tracked && !state.sheetSeen) {
      return { ...hold, state: { ...state, sheetSeen: true } };
    }
    return hold;
  }

  // A missing sheet is a dismissal only after it carried this entry's ID.
  // Otherwise the navigation may never have landed and remains eligible.
  const shareIdToDiscard = tracked !== null && state.sheetSeen ? tracked : null;
  const shareIdToPresent = shareIdToDiscard === pendingShareId ? null : pendingShareId;
  return {
    state: {
      presentedShareId: shareIdToPresent,
      sheetSeen: false,
      discardedShareId: shareIdToDiscard,
    },
    shareIdToPresent,
    shareIdToDiscard,
  };
}
