import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

// Shared by the Claude adapter, which emits these notices, and restart
// recovery, which must not leave one saying it is still waiting.
const STEER_NATIVE_ID_PREFIX = "steer:";

export const claudeSteerNoticeNativeId = (promptUuid: string) =>
  `${STEER_NATIVE_ID_PREFIX}${promptUuid}`;

export const CLAUDE_STEER_UNCONFIRMED_TITLE = "Steer not confirmed";

export const isClaudeSteerNotice = (
  item: OrchestrationV2TurnItem,
): item is Extract<OrchestrationV2TurnItem, { readonly type: "system_notice" }> =>
  item.type === "system_notice" &&
  item.nativeItemRef?.driver === "claudeAgent" &&
  item.nativeItemRef.nativeId?.startsWith(STEER_NATIVE_ID_PREFIX) === true;
