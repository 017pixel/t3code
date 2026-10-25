import type { ComponentProps, ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../../lib/utils";

const tones = {
  muted: { label: "text-sidebar-muted-foreground", line: "bg-sidebar-border/50" },
  emphasized: { label: "text-sidebar-foreground/80", line: "bg-sidebar-foreground/25" },
  accent: { label: "text-primary", line: "bg-primary/50" },
} as const;

export function CollapsibleSectionHeader({
  children,
  expanded,
  tone = "muted",
  variant = "default",
  accessory,
  icon,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "style" | "aria-expanded"> & {
  expanded: boolean;
  tone?: keyof typeof tones;
  /** `row` matches the thread details panel's plain rows instead of a ruled header. */
  variant?: "default" | "panel" | "row";
  accessory?: ReactNode;
  /** Leading icon; `row` headers use it to sit on the panel's icon column. */
  icon?: ReactNode;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        "flex h-8 w-full cursor-pointer items-center gap-2 rounded-md text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
        variant === "row"
          ? "gap-2.5 rounded-lg border border-transparent px-2.5 text-[13px] text-foreground/80 hover:bg-black/[0.035] dark:hover:bg-white/[0.08]"
          : cn(variant === "panel" ? "ps-2 pe-2.5" : "px-2", tones[tone].label),
      )}
    >
      {icon}
      <span
        className={cn(
          "shrink-0",
          // Same cap-height trim as the panel's other row labels, so they share a baseline.
          variant === "row" && "[text-box:trim-both_cap_alphabetic]",
        )}
      >
        {children}
      </span>
      <span
        aria-hidden
        // A collapsed header with a trailing count drops its rule so it doesn't read as a leader.
        className={cn(
          "h-px min-w-2 flex-1",
          variant !== "row" && tones[tone].line,
          !expanded && accessory && "invisible",
        )}
      />
      {accessory}
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "shrink-0 transition-transform",
          variant === "row" ? "size-4 text-muted-foreground" : "size-3",
          !expanded && "-rotate-90",
        )}
      />
    </button>
  );
}

export function SectionHeaderStatus({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 text-3xs leading-none text-destructive-foreground">{children}</span>
  );
}
