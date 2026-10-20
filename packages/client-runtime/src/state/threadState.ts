import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as Option from "effect/Option";

import { EMPTY_THREAD_HISTORY_META, type ThreadHistoryMeta } from "./threadHistoryMerge.ts";

export type EnvironmentThreadStatus = "empty" | "cached" | "synchronizing" | "live" | "deleted";

export interface EnvironmentThreadState {
  readonly data: Option.Option<OrchestrationV2ThreadProjection>;
  readonly status: EnvironmentThreadStatus;
  readonly error: Option.Option<string>;
  /**
   * Errors here are thread/history-local and must not be promoted into the environment
   * disconnect path.
   */
  readonly history: ThreadHistoryMeta;
  /**
   * A warm resume keeps its live status so returning does not flash sync
   * progress. Until the server confirms it caught up, its data may be behind.
   */
  readonly resuming?: boolean;
}

export const EMPTY_ENVIRONMENT_THREAD_STATE: EnvironmentThreadState = {
  data: Option.none(),
  status: "empty",
  error: Option.none(),
  history: EMPTY_THREAD_HISTORY_META,
};
