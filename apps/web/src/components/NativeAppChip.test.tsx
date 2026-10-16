import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { AssetUrlState } from "~/assets/assetUrls";

let asset: AssetUrlState = { _tag: "Loading" };
vi.mock("~/assets/assetUrls", () => ({ useAssetUrlState: () => asset }));
import { NativeAppIcon } from "./NativeAppChip";

let renderer: ReactTestRenderer;
const app = { name: "Helium" };
const render = () => <NativeAppIcon app={app} environmentId="host" />;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  asset = { _tag: "Loading" };
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

it("keeps a fallback until the image loads and shows it again if the next URL fails", async () => {
  await act(async () => {
    renderer = create(render());
  });
  expect(renderer.root.findAllByType("svg")).toHaveLength(1);
  asset = { _tag: "Success", url: "https://test/icon.png", expiresAt: 123 };
  await act(async () => renderer.update(render()));
  expect(renderer.root.findAllByType("svg")).toHaveLength(1);
  expect(renderer.root.findByType("img").props.hidden).toBe(true);
  await act(async () => renderer.root.findByType("img").props.onLoad());
  expect(renderer.root.findAllByType("svg")).toHaveLength(0);
  expect(renderer.root.findByType("img").props.hidden).toBe(false);
  asset = { _tag: "Success", url: "https://test/refreshed.png", expiresAt: 456 };
  await act(async () => renderer.update(render()));
  expect(renderer.root.findAllByType("svg")).toHaveLength(1);
  await act(async () => renderer.root.findByType("img").props.onError());
  expect(renderer.root.findAllByType("img")).toHaveLength(0);
  expect(renderer.root.findAllByType("svg")).toHaveLength(1);
});
