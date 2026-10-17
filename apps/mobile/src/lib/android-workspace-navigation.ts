import type { NavigationState } from "@react-navigation/native";

export type AndroidWorkspaceDestination =
  | { readonly name: "Thread"; readonly params: ReactNavigation.RootParamList["Thread"] }
  | { readonly name: "PullRequest"; readonly params: ReactNavigation.RootParamList["PullRequest"] };

export function androidWorkspaceNavigationState(
  state: NavigationState,
  destination?: AndroidWorkspaceDestination,
  reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
) {
  const home = state.routes.find((route) => route.name === "Home") ?? { name: "Home" };
  if (!destination) return { ...state, index: 0, routes: [home] };
  const identity =
    destination.name === "Thread"
      ? ["environmentId", "threadId"]
      : ["environmentId", "projectId", "repository", "number", "host"];
  const params = destination.params as Readonly<Record<string, unknown>>;
  const existing = state.routes.findLast((route) => {
    if (route.name !== destination.name) return false;
    const current = route.params as Readonly<Record<string, unknown>> | undefined;
    return identity.every((key) => current?.[key] === params[key]);
  });
  return {
    ...state,
    index: reviewers ? 2 : 1,
    routes: [
      home,
      { ...existing, ...destination },
      ...(reviewers ? [{ name: "PullRequestReviewers", params: reviewers }] : []),
    ],
  };
}

// In the split view these destinations swap the detail pane beside the sidebar instead of
// stacking over Home, so the default slide-in would show a layer that is not there.
export function androidWorkspaceDestinationAnimation(routeName: string, usesSplitView: boolean) {
  return usesSplitView && (routeName === "Thread" || routeName === "PullRequest")
    ? ("none" as const)
    : undefined;
}
