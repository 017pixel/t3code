import { type ReactNode, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

export function AnimatedWidth({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const [width, setWidth] = useState<number | null>(null);

  const observeContent = (element: HTMLSpanElement | null) => {
    if (!element) return;
    return observeResize(element, (entries) => {
      const nextWidth = Math.ceil(entries.at(-1)?.contentRect.width ?? 0);
      if (nextWidth > 0) setWidth(nextWidth);
    });
  };

  return (
    <span
      data-slot="animated-width"
      className={cn(
        "inline-block overflow-hidden transition-[width] duration-150 ease-out motion-reduce:transition-none",
        className,
      )}
      style={width === null ? undefined : { width }}
    >
      <span ref={observeContent} className="block w-max whitespace-nowrap">
        {children}
      </span>
    </span>
  );
}
