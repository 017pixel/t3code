import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

const PromptPreview = lazy(() =>
  import("./SettingsFontPreviewContents").then((m) => ({ default: m.PromptFontPreview })),
);
const CodePreview = lazy(() =>
  import("./SettingsFontPreviewContents").then((m) => ({ default: m.CodeFontPreview })),
);
const TerminalPreview = lazy(() =>
  import("./SettingsFontPreviewContents").then((m) => ({ default: m.TerminalFontPreview })),
);

/** Load and mount real preview surfaces once their row enters the viewport. */
function VisiblePreview({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      setVisible(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={ref}>{visible ? <Suspense fallback={null}>{children}</Suspense> : null}</div>;
}

export function PromptFontPreview() {
  return (
    <VisiblePreview>
      <PromptPreview />
    </VisiblePreview>
  );
}
export function CodeFontPreview() {
  return (
    <VisiblePreview>
      <CodePreview />
    </VisiblePreview>
  );
}
export function TerminalFontPreview(props: { family: string; size: number }) {
  return (
    <VisiblePreview>
      <TerminalPreview {...props} />
    </VisiblePreview>
  );
}
