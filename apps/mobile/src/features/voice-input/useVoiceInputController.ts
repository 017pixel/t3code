import { useFocusEffect } from "@react-navigation/native";
import {
  voiceInputBlocksSubmission,
  type VoiceInputState,
} from "@t3tools/client-runtime/voice-input";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useGlobalVoiceInput } from "./VoiceInputProvider";
import { createVoiceInputTarget } from "./voiceInputSession";

const IDLE_STATE: VoiceInputState = { phase: "idle", error: null, errorAction: null };

export function useVoiceInputController(input: {
  readonly ownerKey: string | null;
  readonly label: string;
  readonly readDraftMessage: () => string | null;
  readonly subscribeToDraftChanges: (onChange: () => void) => () => void;
  readonly selection: ComposerEditorSelection;
  readonly disabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onChangeSelection: (selection: ComposerEditorSelection) => void;
}) {
  const global = useGlobalVoiceInput();
  const { session } = global;
  const ownerKey = input.ownerKey;

  useFocusEffect(() => {
    if (!ownerKey) return;
    session.setOwnerFocused(ownerKey, true);
    return () => session.setOwnerFocused(ownerKey, false);
  });

  const start = () => {
    if (!ownerKey || input.disabled) return;
    const { onChangeDraftMessage, onChangeSelection } = input;
    void session.start({
      ...createVoiceInputTarget(
        ownerKey,
        input.readDraftMessage,
        // Both sinks are keyed by owner, so a late commit cannot move the
        // cursor of a draft this screen switched to meanwhile.
        (text, selection) => {
          onChangeDraftMessage(text);
          onChangeSelection(selection);
        },
        input.selection,
        input.subscribeToDraftChanges,
      ),
      label: input.label,
    });
  };
  const state = global.ownerKey === input.ownerKey ? global.state : IDLE_STATE;
  const isBusy = voiceInputBlocksSubmission(state);
  return {
    isAvailable: global.isAvailable && (!global.isBusy || global.ownerKey === input.ownerKey),
    state,
    audioLevels: global.audioLevels,
    elapsedSeconds: global.elapsedSeconds,
    isBusy,
    freezesEditor: isBusy,
    blocksSubmission: isBusy,
    start,
    stop: global.stop,
    cancel: global.cancel,
  };
}
