import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import type { AssistantCitationRequest } from "./AssistantCitationSource";
import { useAssistantCitationTarget } from "./useAssistantCitationTarget";

const request = {
  key: "activation-k",
  citation: { messageId: "cited" },
} as unknown as AssistantCitationRequest;

function Harness({ request }: { request: AssistantCitationRequest | null }) {
  const citation = useAssistantCitationTarget({
    request,
    phase: request ? { _tag: "ready", rowId: "cited-row" } : null,
    onManualNavigation: () => {},
  });
  return (
    <div>
      <button type="button" onClick={citation.onListLoad}>
        list loaded
      </button>
      <button type="button" onClick={() => citation.target?.onComplete()}>
        complete
      </button>
      <output aria-label="positioning">{String(citation.positioning)}</output>
      <output aria-label="target">{citation.target?.key ?? "none"}</output>
    </div>
  );
}

describe("useAssistantCitationTarget", () => {
  it("starts a restored activation key fresh after the citation was left", async () => {
    await using screen = await render(<Harness request={request} />, {
      // The hook reads no route state.
      router: false,
    });
    await screen.getByRole("button", { name: "list loaded" }).click();
    await expect.element(screen.getByLabelText("target")).toHaveTextContent("activation-k");
    await screen.getByRole("button", { name: "complete" }).click();
    await expect.element(screen.getByLabelText("positioning")).toHaveTextContent("false");

    await screen.rerender(<Harness request={null} />);
    await screen.rerender(<Harness request={request} />);

    await expect.element(screen.getByLabelText("positioning")).toHaveTextContent("true");
    await expect.element(screen.getByLabelText("target")).toHaveTextContent("activation-k");
  });
});
