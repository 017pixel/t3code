import type { CuaWindowPreviewFrame } from "@t3tools/contracts";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { useComputerPreviewFrame } from "./useComputerPreviewFrame";

const images: DeferredImage[] = [];
class DeferredImage {
  src = "";
  naturalWidth = 480;
  naturalHeight = 800;
  resolve!: () => void;
  reject!: () => void;
  ready = new Promise<void>((resolve, reject) => {
    this.resolve = resolve;
    this.reject = () => reject(new Error("Invalid image"));
  });
  constructor() {
    images.push(this);
  }
  decode() {
    return this.ready;
  }
}

const makeFrame = (data: string): CuaWindowPreviewFrame => ({
  appName: data,
  mimeType: "image/png",
  dataBase64: data,
  width: 480,
  height: 800,
  capturedAt: "2026-10-16T00:00:00Z",
});
const drawImage = vi.fn();
const canvas = { width: 300, height: 150, getContext: () => ({ drawImage }) };
let renderedFrame: CuaWindowPreviewFrame | null = null;
let renderer: ReactTestRenderer;
function Harness({ frame }: { frame: CuaWindowPreviewFrame | null }) {
  const { canvasRef, frame: paintedFrame } = useComputerPreviewFrame(frame);
  useEffect(() => {
    renderedFrame = paintedFrame;
  }, [paintedFrame]);
  return <canvas ref={canvasRef} />;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Image", DeferredImage);
  images.length = 0;
  drawImage.mockClear();
  canvas.width = 300;
  canvas.height = 150;
  renderedFrame = null;
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});
async function mount(frame: CuaWindowPreviewFrame) {
  await act(async () => {
    renderer = create(<Harness frame={frame} />, { createNodeMock: () => canvas });
  });
}

it("keeps the previous pixels and caption until the replacement finishes decoding", async () => {
  const first = makeFrame("first");
  await mount(first);
  expect(drawImage).not.toHaveBeenCalled();
  await act(async () => images[0]!.resolve());
  expect(renderedFrame).toBe(first);
  const next = makeFrame("next");
  await act(async () => renderer.update(<Harness frame={next} />));
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(renderedFrame).toBe(first);
  await act(async () => images[1]!.resolve());
  expect(drawImage).toHaveBeenLastCalledWith(images[1], 0, 0);
  expect(renderedFrame).toBe(next);
});

it("ignores a decode that finishes after a newer frame", async () => {
  await mount(makeFrame("old"));
  const next = makeFrame("new");
  await act(async () => renderer.update(<Harness frame={next} />));
  await act(async () => images[1]!.resolve());
  await act(async () => images[0]!.resolve());
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(renderedFrame).toBe(next);
});

it("retains the last successful frame after decode failure and cancels when unavailable", async () => {
  const first = makeFrame("first");
  await mount(first);
  await act(async () => images[0]!.resolve());
  await act(async () => renderer.update(<Harness frame={makeFrame("broken")} />));
  await act(async () => images[1]!.reject());
  expect(renderedFrame).toBe(first);
  await act(async () => renderer.update(<Harness frame={makeFrame("pending")} />));
  await act(async () => renderer.update(<Harness frame={null} />));
  await act(async () => images[2]!.resolve());
  expect(drawImage).toHaveBeenCalledTimes(1);
  expect(renderedFrame).toBe(first);
});
