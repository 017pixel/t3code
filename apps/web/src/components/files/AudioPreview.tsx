import { createContext, useContext } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

export const AudioPreviewUnmountContext = createContext<((audio: HTMLAudioElement) => void) | null>(
  null,
);

export function AudioPreview(props: {
  readonly src: string;
  readonly name: string;
  readonly onError?: () => void;
  readonly compact?: boolean;
}) {
  const onUnmount = useContext(AudioPreviewUnmountContext);
  const audioRef = useStableCallback((audio: HTMLAudioElement | null) => {
    if (audio) return () => onUnmount?.(audio);
  });
  const Container = props.compact ? "span" : "div";
  return (
    <Container
      className={
        props.compact
          ? "flex min-h-0 flex-1 items-center px-2 pb-2"
          : "flex min-h-0 flex-1 items-center justify-center p-6"
      }
    >
      <audio
        ref={audioRef}
        controls
        preload="metadata"
        src={props.src}
        aria-label={props.name}
        className={props.compact ? "h-10 w-full min-w-0" : "w-full max-w-xl"}
        onError={props.onError}
      />
    </Container>
  );
}
