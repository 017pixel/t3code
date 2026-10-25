import * as Dialog from "../../components/ui/Dialog";
import type { NavigationState, PartialState } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { parseThreadLinkPrompt } from "@t3tools/shared/promptLinks";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { applyLinkedPromptToThreadDraft } from "./prompt-link-actions";
import { promptLinkNotice, promptLinkSearchFromParams } from "./prompt-link-model";

const THREAD_LINK_KEYS = ["prompt"];

function firstString(value: unknown): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" && first.length > 0 ? first : null;
}

/**
 * `threads/<environment>/<thread>?prompt=…` fills that thread's composer draft.
 * The link applies the prompt as it arrives and drops the param, so the thread
 * screen never sees it and a later visit cannot apply it again.
 */
export function takeThreadPromptLink(
  state: PartialState<NavigationState> | undefined,
): PartialState<NavigationState> | undefined {
  if (!state) return state;
  const index = state.routes.findIndex((route) => route.name === "Thread");
  const route = state.routes[index];
  const params = route?.params as Readonly<Record<string, unknown>> | undefined;
  const search = promptLinkSearchFromParams(params, THREAD_LINK_KEYS);
  if (!route || !params || search === null) return state;
  const { prompt: _prompt, ...rest } = params;
  const routes = state.routes.slice();
  routes[index] = { ...route, params: rest };
  const nextState = { ...state, routes };

  const environmentId = firstString(params.environmentId);
  const threadId = firstString(params.threadId);
  if (environmentId === null || threadId === null) return nextState;
  const parsed = parseThreadLinkPrompt(search);
  if (!parsed.ok) {
    Dialog.alert("Could not open link", parsed.error);
    return nextState;
  }
  if (parsed.value !== null) {
    void applyLinkedPromptToThreadDraft(
      scopedThreadKey(EnvironmentId.make(environmentId), ThreadId.make(threadId)),
      parsed.value,
      promptLinkNotice({ hiddenCharacters: parsed.value.hiddenCharacters }),
    );
  }
  return nextState;
}
