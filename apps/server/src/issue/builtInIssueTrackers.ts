import * as GitHubIssueTrackerDriver from "@t3tools/source-control-github/server/issueTrackerDriver";
import type { IssueTrackerDriver } from "@t3tools/issue-tracker-core/server/driver";

const drivers = [GitHubIssueTrackerDriver.driver];

export type BuiltInIssueTrackersEnv =
  (typeof drivers)[number] extends IssueTrackerDriver<infer R> ? R : never;

export const BUILT_IN_ISSUE_TRACKERS: ReadonlyArray<IssueTrackerDriver<BuiltInIssueTrackersEnv>> =
  drivers;
