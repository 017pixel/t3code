import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  use,
  useEffect,
  useState,
  type ReactNode,
  type ComponentProps,
} from "react";
import { Tooltip, TooltipTrigger, TooltipProvider } from "./ui/tooltip";

const SidebarTooltipHandle = createContext<TooltipPrimitive.Handle<ReactNode> | null>(null);

/** One floating popup serves every row and its quick actions. */
export function SidebarTooltipScope({
  children,
  ...props
}: ComponentProps<typeof TooltipProvider>) {
  const [handle] = useState(() => TooltipPrimitive.createHandle<ReactNode>());
  useEffect(() => {
    const close = () => {
      const focused = document.activeElement;
      if (focused?.matches('[data-slot="tooltip-trigger"][data-popup-open]')) return;
      handle.close();
    };
    document.addEventListener("scroll", close, true);
    return () => document.removeEventListener("scroll", close, true);
  }, [handle]);
  return (
    <TooltipProvider {...props}>
      <SidebarTooltipHandle value={handle}>
        {children}
        <Tooltip handle={handle}>{({ payload }) => payload}</Tooltip>
      </SidebarTooltipHandle>
    </TooltipProvider>
  );
}

export function SidebarTooltip({
  children,
  disabled = false,
}: {
  children: ReactNode;
  disabled?: boolean | undefined;
}) {
  const handle = use(SidebarTooltipHandle);
  useEffect(() => {
    if (disabled) handle?.close();
  }, [disabled, handle]);
  const parts = Children.toArray(children);
  const trigger = parts.find((child) => isValidElement(child) && child.type === TooltipTrigger);
  if (handle === null || !isValidElement<TooltipPrimitive.Trigger.Props<ReactNode>>(trigger))
    return null;
  const payload = parts.filter((child) => child !== trigger);
  return cloneElement(trigger, { handle, payload, disabled });
}
