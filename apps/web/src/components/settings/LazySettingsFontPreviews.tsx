import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";

const PromptPreview = lazy(() =>
  import("./SettingsFontPreviews").then((m) => ({ default: m.PromptFontPreview })),
);
const CodePreview = lazy(() =>
  import("./SettingsFontPreviews").then((m) => ({ default: m.CodeFontPreview })),
);
const TerminalPreview = lazy(() =>
  import("./SettingsFontPreviews").then((m) => ({ default: m.TerminalFontPreview })),
);

/**
 * Each preview's height at the default font sizes. A placeholder holds it until
 * the preview loads, so rows below do not move and a settings search jump lands
 * on its row.
 */
export const FONT_PREVIEW_PLACEHOLDER = {
  prompt: "mt-1 mb-2 h-16.5",
  code: "mt-1 mb-2 h-31.5",
  terminal: "mt-1 mb-2 h-52",
} as const;

/** Load and mount real preview surfaces once their row enters the viewport. */
function VisiblePreview({ placeholder, children }: { placeholder: string; children: ReactNode }) {
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
  const reserved = <div className={placeholder} />;
  return (
    <div ref={ref}>{visible ? <Suspense fallback={reserved}>{children}</Suspense> : reserved}</div>
  );
}

export function PromptFontPreview() {
  return (
    <VisiblePreview placeholder={FONT_PREVIEW_PLACEHOLDER.prompt}>
      <PromptPreview />
    </VisiblePreview>
  );
}
export function CodeFontPreview() {
  return (
    <VisiblePreview placeholder={FONT_PREVIEW_PLACEHOLDER.code}>
      <CodePreview />
    </VisiblePreview>
  );
}
export function TerminalFontPreview(props: { family: string; size: number }) {
  return (
    <VisiblePreview placeholder={FONT_PREVIEW_PLACEHOLDER.terminal}>
      <TerminalPreview {...props} />
    </VisiblePreview>
  );
}
