export async function readVideoFrameTimestamps(src: string, signal: AbortSignal) {
  // Loading the demuxer and reading sample metadata is only needed for frame stepping.
  const { Input, UrlSource, EncodedPacketSink, MP4, QTFF, MATROSKA, WEBM, OGG } =
    await import("mediabunny");
  signal.throwIfAborted();
  const input = new Input({
    source: new UrlSource(src, { getRetryDelay: () => null, maxCacheSize: 4 * 1024 * 1024 }),
    formats: [MP4, QTFF, MATROSKA, WEBM, OGG],
  });
  const dispose = () => input.dispose();
  signal.addEventListener("abort", dispose, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track");
    const timestamps = new Set<number>();
    const sink = new EncodedPacketSink(track);
    for await (const packet of sink.packets(undefined, undefined, { metadataOnly: true })) {
      signal.throwIfAborted();
      if (packet.timestamp >= 0 || packet.timestamp + packet.duration > 0) {
        timestamps.add(Math.max(0, packet.timestamp));
      }
    }
    if (timestamps.size === 0) throw new Error("No video frames");
    // B-frames are stored in decode order, which can differ from presentation order.
    return Float64Array.from(timestamps).sort();
  } finally {
    signal.removeEventListener("abort", dispose);
    input.dispose();
  }
}

export function adjacentVideoFrameTime(
  timestamps: Float64Array,
  currentTime: number,
  duration: number,
  direction: -1 | 1,
): number {
  let low = 0;
  let high = timestamps.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (timestamps[middle]! <= currentTime) low = middle + 1;
    else high = middle;
  }
  const index = Math.max(0, Math.min(timestamps.length - 1, low - 1 + direction));
  const start = timestamps[index]!;
  const end = timestamps[index + 1] ?? duration;
  // Seek inside the frame so browser time rounding cannot select its predecessor.
  return start + Math.max(0, end - start) / 2;
}
