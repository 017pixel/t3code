import type { CommonActions, NavigationState } from "@react-navigation/native";

export type AndroidWorkspaceDestination =
  | { readonly name: "Thread"; readonly params: ReactNavigation.RootParamList["Thread"] }
  | { readonly name: "PullRequest"; readonly params: ReactNavigation.RootParamList["PullRequest"] };

export type AndroidWorkspaceResetAction = ReturnType<typeof CommonActions.reset> & {
  readonly target: string;
};

interface WorkspaceNavigation {
  readonly dispatch: (action: AndroidWorkspaceResetAction) => void;
  readonly getParent: () => WorkspaceNavigation | undefined;
  readonly getState: () => NavigationState | undefined;
}

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

/**
 * Resets the root stack to a workspace list or detail. Always reads and targets the root
 * navigator: the sidebar and rail render in the root layout, where `useNavigation()` is the
 * container, and a container dispatch runs on the deepest focused navigator. With Settings
 * or New task open, that is their nested stack, which rejects the reset.
 */
export function resetAndroidWorkspace(
  navigation: WorkspaceNavigation,
  destination?: AndroidWorkspaceDestination,
  reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
) {
  let root = navigation;
  for (let parent = root.getParent(); parent; parent = root.getParent()) root = parent;
  const state = root.getState();
  if (!state) return;
  // Same shape as `CommonActions.reset`, which would pull React Native into node tests.
  navigation.dispatch({
    type: "RESET",
    payload: androidWorkspaceNavigationState(state, destination, reviewers),
    target: state.key,
  });
}
