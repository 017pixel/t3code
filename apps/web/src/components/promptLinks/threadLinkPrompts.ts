import { parseThreadLinkPrompt, withoutPromptLinkParams } from "@t3tools/shared/promptLinks";

import type { AppRouter } from "../../router";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  isHostedPromptLinkLandingShowing,
  subscribeHostedPromptLinkLanding,
} from "./HostedPromptLinkLanding";
import { placeLinkedPrompt } from "./linkedPrompt";

/**
 * A thread link's `?prompt` lands in that thread's composer once per history entry, then leaves
 * the address. The hosted landing page reads the same address, so the prompt waits behind it.
 */
export function startThreadLinkPrompts(router: AppRouter): () => void {
  const handledLocationKeys = new Set<string>();

  const sync = () => {
    const location = router.state.location;
    if (!new URLSearchParams(location.searchStr).has("prompt")) return;
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    if (target?.kind !== "server") return;
    const hosted = router.state.matches[0]?.context.authGateState?.status === "hosted-static";
    if (isHostedPromptLinkLandingShowing(hosted, location.href)) return;

    const locationKey = location.state.__TSR_key ?? location.href;
    if (!handledLocationKeys.has(locationKey)) {
      handledLocationKeys.add(locationKey);
      const parsed = parseThreadLinkPrompt(location.searchStr);
      if (!parsed.ok) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not open the linked prompt",
            description: parsed.error,
          }),
        );
      } else if (parsed.value !== null) {
        placeLinkedPrompt(target.threadRef, parsed.value);
      }
    }
    void router.navigate({
      href: `${location.pathname}${withoutPromptLinkParams(location.searchStr)}`,
      replace: true,
    });
  };

  const unsubscribers = [
    router.subscribe("onResolved", sync),
    subscribeHostedPromptLinkLanding(sync),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
