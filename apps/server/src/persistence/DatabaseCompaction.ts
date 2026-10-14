import {
  OrchestrationV2AppThreadJson,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { applyThreadPullRequestLinkSync } from "@t3tools/shared/threadPullRequests";
import * as Schema from "effect/Schema";

const encodeThread = Schema.encodeSync(OrchestrationV2AppThreadJson);
const sameThread = (left: OrchestrationV2AppThread, right: OrchestrationV2AppThread) =>
  JSON.stringify(encodeThread(left)) === JSON.stringify(encodeThread(right));
/** A legacy snapshot is replaceable only if this field patch reproduces every thread field. */
export function compactThreadFieldEvent(
  event: OrchestrationV2DomainEvent,
  previous: OrchestrationV2AppThread | undefined,
): OrchestrationV2DomainEvent {
  if (previous === undefined) return event;
  if (event.type === "thread.visited") {
    const payload = { lastVisitedAt: event.payload.lastVisitedAt };
    return sameThread({ ...previous, ...payload }, event.payload)
      ? { ...event, type: "thread.visit-recorded", payload }
      : event;
  }
  if (event.type !== "thread.pull-request-synced") return event;
  for (const link of event.payload.pullRequests ?? []) {
    if (link.snapshot === null) continue;
    const payload = {
      host: link.host,
      repository: link.repository,
      number: link.number,
      snapshot: link.snapshot,
      stack: link.stack,
    };
    if (sameThread(applyThreadPullRequestLinkSync(previous, payload), event.payload)) {
      return { ...event, type: "thread.pull-request-link-synced", payload };
    }
  }
  return event;
}
