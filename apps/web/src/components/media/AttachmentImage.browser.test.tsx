import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AttachmentImage } from "./AttachmentImage";
import { decodeImagePreview } from "../files/decodeImagePreview";

vi.mock("../files/decodeImagePreview", () => ({
  decodeImagePreview: vi.fn(),
}));

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const revokeUrl = vi.fn();
const bitmap = new Blob(["png"], { type: "image/png" });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:jpeg");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeUrl);
  vi.mocked(decodeImagePreview).mockResolvedValue(bitmap);
});

afterEach(async () => {
  await act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function render(element: ReactNode) {
  if (!container) {
    container = document.body.appendChild(document.createElement("div"));
    root = createRoot(container);
  }
  await act(() => root!.render(element));
}

function image() {
  const img = container!.querySelector("img");
  expect(img).not.toBeNull();
  return img!;
}

// Stands in for the browser failing to decode the current source.
async function failDecode() {
  const img = image();
  await act(() => {
    img.dispatchEvent(new Event("error"));
  });
  await act(() => vi.dynamicImportSettled());
  return img;
}

function expectDecodeErrorFor(onError: ReturnType<typeof vi.fn>, img: HTMLImageElement) {
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ type: "error", target: img }));
}

it.each([
  { name: "photo.HEIC", mimeType: undefined, heif: true },
  { name: "photo.heif", mimeType: undefined, heif: true },
  { name: "photo", mimeType: "image/heif", heif: true },
  { name: "scan.TIFF", mimeType: undefined, heif: false },
  { name: "scan", mimeType: "image/tiff", heif: false },
])(
  "converts $name after native decoding fails and releases its preview",
  async ({ name, mimeType, heif }) => {
    await render(
      <AttachmentImage src="https://environment.test/photo" name={name} mimeType={mimeType} />,
    );
    expect(decodeImagePreview).not.toHaveBeenCalled();
    await failDecode();
    expect(image().getAttribute("src")).toBe("blob:jpeg");
    expect(decodeImagePreview).toHaveBeenCalledWith(
      "https://environment.test/photo",
      heif,
      expect.any(AbortSignal),
    );
    await act(() => root!.unmount());
    root = undefined;
    expect(revokeUrl).toHaveBeenCalledWith("blob:jpeg");
  },
);

it("leaves PNG errors to the caller without fetching or converting", async () => {
  const onError = vi.fn();
  await render(<AttachmentImage src="blob:png" name="photo.png" onError={onError} />);
  expectDecodeErrorFor(onError, await failDecode());
  expect(decodeImagePreview).not.toHaveBeenCalled();
});

it("reports failed HEIC conversion through the existing error handler", async () => {
  const onError = vi.fn();
  vi.mocked(decodeImagePreview).mockRejectedValue(new Error("unreadable"));
  await render(<AttachmentImage src="blob:heic" name="photo.heif" onError={onError} />);
  expectDecodeErrorFor(onError, await failDecode());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("discards an old decode when navigating to a different source", async () => {
  let finishDecode!: (result: Blob) => void;
  vi.mocked(decodeImagePreview).mockReturnValue(
    new Promise((resolve) => {
      finishDecode = resolve;
    }),
  );
  await render(<AttachmentImage src="blob:first" name="photo.heic" />);
  await failDecode();
  const secondSource = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>";
  await render(<AttachmentImage src={secondSource} name="photo.heic" />);
  await act(() => finishDecode(bitmap));
  expect(image().getAttribute("src")).toBe(secondSource);
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  expect(vi.mocked(decodeImagePreview).mock.calls[0]?.[2].aborted).toBe(true);
});
