import { assert, describe, it } from "@effect/vitest";

import { formatSentFromContext } from "./sentFromContext.ts";

describe("formatSentFromContext", () => {
  it("says localhost works when the client dialed loopback directly", () => {
    assert.equal(
      formatSentFromContext({
        surface: "desktop",
        os: "macOS",
        connectionMethod: "direct",
        host: "127.0.0.1:3773",
        serverLabel: "Mainbook",
      }),
      "<sent_from>The user sent this message from the T3 Code desktop app on macOS to this machine (Mainbook) at 127.0.0.1:3773. The user is at this machine, so localhost URLs work for them.</sent_from>",
    );
  });

  it("points at the dialed name when the client is elsewhere on the network", () => {
    assert.include(
      formatSentFromContext({ surface: "web", host: "mainbook.example.ts.net:5733" }),
      "Use mainbook.example.ts.net instead of localhost",
    );
  });

  // T3 Connect and SSH tunnels arrive on loopback, so the host alone would mislead.
  it("does not trust a loopback host behind a relay or tunnel", () => {
    for (const connectionMethod of ["relay", "ssh"] as const) {
      const text = formatSentFromContext({ connectionMethod, host: "127.0.0.1:3773" });
      assert.include(text, "probably not at this machine");
      assert.notInclude(text, "127.0.0.1");
    }
  });
});
