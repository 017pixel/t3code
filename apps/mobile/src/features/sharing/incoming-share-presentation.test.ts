import { describe, expect, it } from "@effect/vitest";

import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  incomingShareIdOfSheetRoute,
  transitionIncomingSharePresentation,
} from "./incoming-share-presentation";

const home = { name: "Home" };

function presentation() {
  let state = EMPTY_INCOMING_SHARE_PRESENTATION_STATE;
  return (
    pendingShareId: string | null,
    routes: Parameters<typeof incomingShareIdOfSheetRoute>[0]["routes"],
  ) => {
    const sheet = incomingShareIdOfSheetRoute({ routes }, "NewTaskSheet");
    const result = transitionIncomingSharePresentation(state, {
      pendingShareId,
      isSheetPresented: sheet.isSheetPresented,
      sheetShareId: sheet.shareId,
    });
    state = result.state;
    return { present: result.shareIdToPresent, discard: result.shareIdToDiscard };
  };
}

describe("incoming share presentation", () => {
  it("retries a cold-launch request until its own sheet is observed, then discards on dismissal", () => {
    const step = presentation();
    const requested = { present: "share-1", discard: null };
    const held = { present: null, discard: null };

    expect(step("share-1", [home])).toEqual(requested);
    expect(step("share-1", [home, { name: "SettingsSheet" }])).toEqual(requested);
    expect(
      step("share-1", [home, { name: "NewTaskSheet", state: { routes: [{ name: "NewTask" }] } }]),
    ).toEqual(held);
    expect(step("share-1", [home])).toEqual(requested);
    expect(
      step("share-1", [
        home,
        {
          name: "NewTaskSheet",
          params: { screen: "NewTask", params: { incomingShareId: "share-1" } },
        },
      ]),
    ).toEqual(held);
    expect(step("share-1", [home])).toEqual({ present: null, discard: "share-1" });
    expect(step("share-1", [home])).toEqual(held);
    expect(step(null, [home])).toEqual(held);
    expect(step("share-1", [home])).toEqual(requested);
  });

  it("keeps a covered New Task sheet until dismissal and hands off the newer pending share", () => {
    const step = presentation();
    const sheet = {
      name: "NewTaskSheet",
      state: { routes: [{ name: "NewTask", params: { incomingShareId: "share-1" } }] },
    };

    expect(step("share-1", [home])).toEqual({ present: "share-1", discard: null });
    expect(step("share-1", [home, sheet])).toEqual({ present: null, discard: null });
    expect(step("share-2", [home, sheet, { name: "ConnectionsNew" }])).toEqual({
      present: null,
      discard: null,
    });
    expect(step("share-2", [home])).toEqual({ present: "share-2", discard: "share-1" });
  });

  it("recognizes a share carried only by NewTaskDraft as an observed sheet", () => {
    const step = presentation();
    expect(step("share-1", [home])).toEqual({ present: "share-1", discard: null });
    expect(
      step("share-1", [
        home,
        {
          name: "NewTaskSheet",
          state: {
            routes: [
              { name: "NewTask" },
              { name: "NewTaskDraft", params: { incomingShareId: "share-1" } },
            ],
          },
        },
      ]),
    ).toEqual({ present: null, discard: null });
    expect(step("share-1", [home])).toEqual({ present: null, discard: "share-1" });
  });
});
