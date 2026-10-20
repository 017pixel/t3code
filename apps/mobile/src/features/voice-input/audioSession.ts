import { setAudioModeAsync, setIsAudioActiveAsync } from "expo-audio";

type AudioSessionToken = {
  readonly kind: "playback" | "recording";
  readonly onCancel?: () => void;
  released: boolean;
};

let owner: AudioSessionToken | null = null;
let pending = Promise.resolve();

// Native session calls are async. Finish an old activation before releasing it
// or configuring its successor, so it cannot reactivate a released session.
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = pending.then(operation);
  pending = result.then(
    () => {},
    () => {},
  );
  return result;
}

export function acquireAudioSession(kind: AudioSessionToken["kind"], onCancel?: () => void) {
  const token: AudioSessionToken = { kind, onCancel, released: false };
  if (kind === "playback" && owner?.kind === "recording" && !owner.released) return token;
  const previous = owner;
  owner = token;
  if (previous && !previous.released) previous.onCancel?.();
  return token;
}

export function isAudioSessionOwner(token: AudioSessionToken): boolean {
  return owner === token && !token.released;
}

export function activateAudioSession(token: AudioSessionToken): Promise<boolean> {
  return enqueue(async () => {
    if (!isAudioSessionOwner(token)) return false;
    await setAudioModeAsync({
      allowsRecording: token.kind === "recording",
      interruptionMode: "doNotMix",
      playsInSilentMode: true,
      shouldPlayInBackground: false,
    });
    if (!isAudioSessionOwner(token)) return false;
    await setIsAudioActiveAsync(true);
    return isAudioSessionOwner(token);
  });
}

export function releaseAudioSession(token: AudioSessionToken): Promise<void> {
  token.released = true;
  return enqueue(async () => {
    if (owner !== token) return;
    try {
      if (token.kind === "recording") await setAudioModeAsync({ allowsRecording: false });
    } finally {
      // Expo recorder/player teardown does not release an activation that never played.
      if (owner === token) {
        await setIsAudioActiveAsync(false);
        if (owner === token) owner = null;
      }
    }
  });
}
