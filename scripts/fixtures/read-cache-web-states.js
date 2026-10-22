/* Static appearance fixture: production image view; bypasses asset hooks and signing. */
(async () => {
  const { default: React } = await import("/node_modules/.vite/deps/react.js");
  const {
    default: { createRoot },
  } = await import("/node_modules/.vite/deps/react-dom_client.js");
  const { AppAtomRegistryProvider } = await import("/src/rpc/atomRegistry.ts");
  const { ChatMarkdownImage, authoredImageSizeStyle } =
    await import("/src/components/chat/ChatMarkdownMedia.tsx");
  const h = React.createElement;
  const wide =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAABkCAIAAADVI9l0AAABqklEQVR4nO3OQQ0AMBAEofVvupUxjyNBANseABzWDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDUDwAg1A8AINQPACDzAaN9g0jl22GoAAAAAElFTkSuQmCC";
  document.getElementById("read-cache-conditional-fixture")?.remove();
  const host = document.createElement("div");
  host.id = "read-cache-conditional-fixture";
  Object.assign(host.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483000",
    overflow: "auto",
    background: "white",
    color: "#111",
    padding: "16px",
    font: "14px system-ui",
  });
  document.body.appendChild(host);
  const states = [
    ["Loading (preset)", { src: null }],
    ["Missing file (preset)", { src: null, sourceFailed: true }],
    [
      "Missing read access (preset)",
      {
        src: null,
        sourceFailed: true,
        unavailableDetail: "This connection cannot read host files.",
      },
    ],
    ["Known size: 600×100 PNG", { src: wide }],
    ["No dimensions: same PNG", { src: wide, style: undefined }],
  ];
  createRoot(host).render(
    h(
      AppAtomRegistryProvider,
      null,
      h(
        "main",
        null,
        h("h1", { style: { fontSize: "18px", fontWeight: "bold" } }, "Web static image states"),
        h(
          "p",
          null,
          "Simulated asset results • production ChatMarkdownImage. Signing hooks, Read rows and transport bypassed.",
        ),
        ...states.map(([label, extra]) =>
          h(
            "section",
            { key: label, style: { marginTop: "20px" } },
            h("h2", { style: { fontSize: "14px", marginBottom: "6px" } }, label),
            h(ChatMarkdownImage, {
              src: null,
              alt: label,
              copyMarkdown: undefined,
              standalone: true,
              actionsSource: { kind: "image", name: label, src: extra.src },
              style: authoredImageSizeStyle(600, 100),
              ...extra,
            }),
          ),
        ),
      ),
    ),
  );
  return {
    fixture: "production ChatMarkdownImage",
    bypassed: ["asset hooks", "Read rows", "transport"],
    viewport: [innerWidth, innerHeight, devicePixelRatio],
  };
})();
