import { describe, expect, it } from "vite-plus/test";

import { resolveHostedPromptLinkLanding } from "./HostedPromptLinkLanding";

const base = {
  appPath: "/new?prompt=hi",
  href: "/new?prompt=hi",
  continuedHref: null,
  opener: null,
  environmentsReady: true,
  environmentCount: 1,
} as const;

describe("resolveHostedPromptLinkLanding", () => {
  it("opens addresses that are not prompt links, and links the user continued with", () => {
    expect(resolveHostedPromptLinkLanding({ ...base, appPath: null }).kind).toBe("none");
    expect(resolveHostedPromptLinkLanding({ ...base, continuedHref: base.href }).kind).toBe("none");
  });

  it("holds a link on the page until the user chooses", () => {
    expect(resolveHostedPromptLinkLanding(base)).toEqual({
      kind: "page",
      appPath: base.appPath,
      canContinue: true,
    });
    expect(resolveHostedPromptLinkLanding({ ...base, opener: "app" }).kind).toBe("page");
  });

  it("opens in the browser when remembered, once an environment can take it", () => {
    const browser = { ...base, opener: "browser" } as const;
    expect(resolveHostedPromptLinkLanding(browser).kind).toBe("none");
    expect(resolveHostedPromptLinkLanding({ ...browser, environmentsReady: false }).kind).toBe(
      "waiting",
    );
    expect(resolveHostedPromptLinkLanding({ ...browser, environmentCount: 0 })).toEqual({
      kind: "page",
      appPath: base.appPath,
      canContinue: false,
    });
  });
});
