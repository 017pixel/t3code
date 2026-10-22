import {
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { describe, expect, it } from "vite-plus/test";

import { adjacentVideoFrameTime, readVideoFrameTimestamps } from "./videoFrameStepping";

describe("video frame stepping", () => {
  it.each([24, 30, 60, 30000 / 1001])("steps one frame in both directions at %s fps", (fps) => {
    const timestamps = Float64Array.from({ length: 10 }, (_, index) => index / fps);
    let time = 0;
    for (let index = 1; index < timestamps.length; index++) {
      time = adjacentVideoFrameTime(timestamps, time, 10 / fps, 1);
      expect(time).toBeGreaterThan(timestamps[index]!);
      expect(time).toBeLessThan((index + 1) / fps);
    }
    for (let index = timestamps.length - 2; index >= 0; index--) {
      time = adjacentVideoFrameTime(timestamps, time, 10 / fps, -1);
      expect(time).toBeGreaterThan(timestamps[index]!);
      expect(time).toBeLessThan((index + 1) / fps);
    }
  });

  it("uses presentation order and variable frame durations from the file", async () => {
    const target = new BufferTarget();
    const output = new Output({ target, format: new Mp4OutputFormat() });
    const source = new EncodedVideoPacketSource("vp9");
    output.addVideoTrack(source);
    await output.start();
    // Reference frames precede the B-frames that depend on them in decode order.
    for (const timestamp of [0, 0.12, 0.04, 0.08, 0.24, 0.16]) {
      await source.add(
        new EncodedPacket(new Uint8Array([0]), timestamp === 0 ? "key" : "delta", timestamp, 0.04),
        {
          decoderConfig: { codec: "vp09.00.10.08", codedWidth: 16, codedHeight: 16 },
        },
      );
    }
    await output.finalize();
    const url = `data:video/mp4;base64,${Buffer.from(target.buffer!).toString("base64")}`;
    const timestamps = await readVideoFrameTimestamps(url, new AbortController().signal);

    expect([...timestamps]).toEqual([0, 0.04, 0.08, 0.12, 0.16, 0.24]);
    expect(adjacentVideoFrameTime(timestamps, 0.19, 0.28, 1)).toBeCloseTo(0.26);
    expect(adjacentVideoFrameTime(timestamps, 0.19, 0.28, -1)).toBeCloseTo(0.14);
  });

  it("stays on the first and last frames at the boundaries", () => {
    const timestamps = new Float64Array([0, 0.04, 0.12]);
    expect(adjacentVideoFrameTime(timestamps, 0, 0.16, -1)).toBe(0.02);
    expect(adjacentVideoFrameTime(timestamps, 0.16, 0.16, 1)).toBe(0.14);
    expect(adjacentVideoFrameTime(new Float64Array([0]), 0, 0.04, 1)).toBe(0.02);
  });

  it("cancels metadata loading when the player is disposed", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      readVideoFrameTimestamps("https://unused.test/video.mp4", controller.signal),
    ).rejects.toThrow();
  });
});
