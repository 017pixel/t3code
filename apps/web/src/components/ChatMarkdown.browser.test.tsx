import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
// A standard client session, so environment-owned file links can open.
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown content direction", () => {
  it.each([
    {
      language: "Hebrew",
      heading: "כותרת בעברית",
      sentence: "זהו משפט בעברית.",
      item: "פריט ראשון",
    },
    {
      language: "Arabic",
      heading: "عنوان بالعربية",
      sentence: "هذه جملة عربية.",
      item: "العنصر الأول",
    },
  ])("lays out $language prose and bullets from the right", async ({ heading, sentence, item }) => {
    setup();
    await using screen = await renderText(`## ${heading}\n\n${sentence}\n\n- ${item}`);
    const { container } = screen;
    await vi.waitFor(() => {
      for (const selector of ["h2", "p", "ul", "li"]) {
        expect(getComputedStyle(container.querySelector(selector)!).direction, selector).toBe(
          "rtl",
        );
      }
      const itemStyle = getComputedStyle(container.querySelector("li")!);
      expect(parseFloat(itemStyle.marginRight)).toBeGreaterThan(parseFloat(itemStyle.marginLeft));

      // The final period belongs at the left end of this single-line RTL sentence.
      const text = container.querySelector("p")!.firstChild!;
      const first = document.createRange();
      first.setStart(text, 0);
      first.setEnd(text, 1);
      const period = document.createRange();
      period.setStart(text, sentence.length - 1);
      period.setEnd(text, sentence.length);
      expect(period.getBoundingClientRect().right).toBeLessThanOrEqual(
        first.getBoundingClientRect().left,
      );
    });
  });

  it("resolves mixed list items, quotes and table cells independently across updates", async () => {
    setup();
    await using screen = await renderText(
      "- שלום.\n- Hello.\n\n> مرحبا.\n\n| שם | Name |\n| --- | --- |\n| שלום. | Hello. |",
    );
    const { container, rerender } = screen;
    await vi.waitFor(() => {
      const [rtlItem, ltrItem] = container.querySelectorAll("li");
      expect(getComputedStyle(rtlItem!).direction).toBe("rtl");
      expect(getComputedStyle(ltrItem!).direction).toBe("ltr");
      expect(getComputedStyle(container.querySelector("blockquote")!).direction).toBe("rtl");
      const [rtlCell, ltrCell] = container.querySelectorAll("td");
      expect(getComputedStyle(rtlCell!).direction).toBe("rtl");
      expect(getComputedStyle(ltrCell!).direction).toBe("ltr");
      const [firstColumn, secondColumn] = container.querySelectorAll("th");
      expect(getComputedStyle(firstColumn!).direction).toBe("rtl");
      expect(firstColumn!.getBoundingClientRect().left).toBeLessThan(
        secondColumn!.getBoundingClientRect().left,
      );
    });
    await rerender(
      <ChatMarkdown cwd="/tmp/project" text={"English first.\n\nשלום."} isStreaming />,
    );
    await vi.waitFor(() => {
      const [english, hebrew] = container.querySelectorAll("p");
      expect(getComputedStyle(english!).direction).toBe("ltr");
      expect(getComputedStyle(hebrew!).direction).toBe("rtl");
    });
  });

  it.each(["-", "1."])(
    "keeps mixed %s list marker gutters inside clipped lists",
    async (marker) => {
      setup();
      await using screen = await renderText(`${marker} שלום.\n${marker} Hello.`);
      const { container, rerender } = screen;
      container.style.width = "300px";
      container.style.overflow = "hidden";
      for (const text of [
        `${marker} שלום.\n${marker} Hello.`,
        `${marker} Hello.\n${marker} שלום.`,
        `${marker} שלום.\n\n${marker} Hello.`,
      ]) {
        await rerender(<ChatMarkdown cwd="/tmp/project" text={text} />);
        const list = container.querySelector("ul, ol")!;
        const listBox = list.getBoundingClientRect();
        const clipBox = container.getBoundingClientRect();
        for (const item of list.querySelectorAll("li")) {
          const style = getComputedStyle(item);
          const box = item.getBoundingClientRect();
          const rtl = style.direction === "rtl";
          const gutter = parseFloat(style.fontSize);
          // Native outside markers have no DOM rect. Reserve a full font-sized
          // marker gutter and prove that entire paint area survives clipping.
          expect(style.listStylePosition).toBe("outside");
          expect(style.listStyleType).not.toBe("none");
          const left = rtl ? box.right : box.left - gutter;
          const right = rtl ? box.right + gutter : box.left;
          expect(left).toBeGreaterThanOrEqual(Math.max(listBox.left, clipBox.left) - 0.5);
          expect(right).toBeLessThanOrEqual(Math.min(listBox.right, clipBox.right) + 0.5);
        }
      }
    },
  );

  it.each([false, true])(
    "separates RTL task text from checkboxes (editable: %s)",
    async (editable) => {
      setup();
      const onTaskListChange = editable ? vi.fn() : undefined;
      await using screen = await renderText(
        "- [ ] שלום עולם.\n- [x] مهمة عربية.\n- [ ] English task.",
        {
          onTaskListChange,
        },
      );
      const { container } = screen;
      container.style.width = "300px";
      for (const item of container.querySelectorAll("li")) {
        const checkbox = item.querySelector<HTMLInputElement>("input")!;
        const label = document.createRange();
        label.setStartAfter(checkbox);
        label.setEndAfter(item.lastChild!);
        const textBox = label.getBoundingClientRect();
        const checkboxBox = checkbox.getBoundingClientRect();
        const itemBox = item.getBoundingClientRect();
        if (getComputedStyle(item).direction === "rtl") {
          expect(checkboxBox.left).toBeGreaterThan(textBox.right);
          expect(checkboxBox.right).toBeGreaterThan(itemBox.right);
        } else {
          expect(checkboxBox.right).toBeLessThan(textBox.left);
          expect(checkboxBox.left).toBeLessThan(itemBox.left);
        }
        const listBox = item.parentElement!.getBoundingClientRect();
        expect(checkboxBox.left).toBeGreaterThanOrEqual(listBox.left);
        expect(checkboxBox.right).toBeLessThanOrEqual(listBox.right);
      }
      if (editable) {
        await act(async () => container.querySelector<HTMLInputElement>("input")!.click());
        expect(onTaskListChange).toHaveBeenCalledExactlyOnceWith({
          markerOffset: 2,
          checked: true,
        });
      }
    },
  );

  it("aligns RTL table text to the right while retaining LTR columns", async () => {
    setup();
    await using screen = await renderText("| שם | Name |\n| --- | --- |\n| שלום. | Hello. |");
    const { container } = screen;
    container.style.width = "500px";
    const table = container.querySelector("table")!;
    expect(getComputedStyle(table).direction).toBe("ltr");
    for (const row of table.rows) {
      const [rtl, ltr] = row.cells;
      expect(rtl!.getBoundingClientRect().left).toBeLessThan(ltr!.getBoundingClientRect().left);
      for (const cell of row.cells) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        const textBox = range.getBoundingClientRect();
        const box = cell.getBoundingClientRect();
        const style = getComputedStyle(cell);
        const leftGap = textBox.left - box.left - parseFloat(style.paddingLeft);
        const rightGap = box.right - textBox.right - parseFloat(style.paddingRight);
        if (style.direction === "rtl") expect(rightGap).toBeLessThan(leftGap);
        else expect(leftGap).toBeLessThan(rightGap);
      }
    }
  });

  it("puts RTL alert quote chrome on the content side", async () => {
    setup();
    await using screen = await renderText("> [!NOTE]\n> שלום עולם.");
    const note = screen.container.querySelector('[role="note"]')!;
    const style = getComputedStyle(note);
    expect(style.direction).toBe("rtl");
    expect(parseFloat(style.borderRightWidth)).toBe(2);
    expect(parseFloat(style.borderLeftWidth)).toBe(0);
    expect(parseFloat(style.paddingRight)).toBeGreaterThan(0);
    expect(parseFloat(style.paddingLeft)).toBe(0);
  });

  it("keeps loose ordered list markers on the paragraph's side", async () => {
    setup();
    await using screen = await renderText("1. שלום.\n\n2. עוד.");
    const { container } = screen;
    expect(getComputedStyle(container.querySelector("ol")!).direction).toBe("rtl");
    expect(getComputedStyle(container.querySelector("li")!).direction).toBe("rtl");
    expect(getComputedStyle(container.querySelector("p")!).direction).toBe("rtl");
  });

  it("keeps inline code LTR in RTL prose and preserves the user bubble opt-out", async () => {
    setup();
    const text = "שלום עם `const value = 1` בתוך משפט.";
    await using screen = await renderText(text);
    const { container, rerender } = screen;
    expect(getComputedStyle(container.querySelector("p")!).direction).toBe("rtl");
    expect(getComputedStyle(container.querySelector("code")!).direction).toBe("ltr");
    await rerender(<ChatMarkdown cwd="/tmp/project" text={text} autoDirection={false} />);
    expect(getComputedStyle(container.querySelector("p")!).direction).toBe("ltr");
  });

  it("keeps Latin-first mixed prose LTR with native first-strong direction", async () => {
    setup();
    await using screen = await renderText(
      "React מאפשר לבנות ממשק בעברית עם `const value = 1` בתוך המשפט.\n\nEnglish prose stays left to right.",
    );
    const { container } = screen;
    await vi.waitFor(() => {
      const [hebrew, english] = container.querySelectorAll("p");
      expect(getComputedStyle(hebrew!).direction).toBe("ltr");
      expect(getComputedStyle(hebrew!.querySelector("code")!).direction).toBe("ltr");
      expect(getComputedStyle(english!).direction).toBe("ltr");
    });
  });

  it("keeps code blocks and English tables LTR within a Hebrew response", async () => {
    setup();
    await using screen = await renderText(
      'הנה דוגמה של קוד וטבלה בעברית.\n\n```js\nconst message = "שלום";\n```\n\n| Name | Value |\n| --- | --- |\n| message | hello |',
    );
    const { container } = screen;
    await vi.waitFor(() => {
      expect(getComputedStyle(container.querySelector("p")!).direction).toBe("rtl");
      for (const selector of ["pre", "pre code", "table", "th", "td"]) {
        const elements = container.querySelectorAll(selector);
        expect(elements.length, selector).toBeGreaterThan(0);
        for (const element of elements) {
          expect(getComputedStyle(element).direction, selector).toBe("ltr");
        }
      }
    });
  });
});
