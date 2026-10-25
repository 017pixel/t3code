import { Activity, useState, type ReactNode } from "react";
import { View } from "react-native";

import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { NativeInspectorContent } from "../../native/NativeInspectorContent";

export type ThreadInspectorMode = "route" | "git" | "files";

type PaneState = "unmounted" | "prewarm" | "mounted";

function InspectorContentPane(props: {
  readonly children: ReactNode;
  readonly state: PaneState;
  readonly resetKeys: readonly [string | null, string | null];
  readonly visible: boolean;
}) {
  if (props.state === "unmounted") {
    return null;
  }

  // A prewarmed pane renders at idle priority with its effects held back; once
  // visited it stays mounted and live, hidden only by opacity.
  return (
    <Activity mode={props.state === "prewarm" ? "hidden" : "visible"}>
      <View
        accessibilityElementsHidden={!props.visible}
        focusable={props.visible}
        importantForAccessibility={props.visible ? "auto" : "no-hide-descendants"}
        pointerEvents={props.visible ? "auto" : "none"}
        style={{
          position: "absolute",
          inset: 0,
          opacity: props.visible ? 1 : 0,
          zIndex: props.visible ? 1 : 0,
        }}
      >
        <RenderErrorBoundary
          resetKeys={props.resetKeys}
          renderFallback={(fallback) => (
            <NativeInspectorContent>
              <RenderFailureView {...fallback} title="The inspector couldn't be displayed" />
            </NativeInspectorContent>
          )}
        >
          {props.children}
        </RenderErrorBoundary>
      </View>
    </Activity>
  );
}

export function ThreadInspectorContentStack(props: {
  readonly renderFiles: () => ReactNode;
  readonly renderGit?: () => ReactNode;
  readonly mode: ThreadInspectorMode;
  readonly resetKeys: readonly [string | null, string | null];
  readonly renderRoute?: () => ReactNode;
}) {
  const [visitedModes, setVisitedModes] = useState<ReadonlySet<ThreadInspectorMode>>(
    () => new Set([props.mode]),
  );
  if (!visitedModes.has(props.mode)) {
    setVisitedModes(new Set([...visitedModes, props.mode]));
  }
  // The file tree is expensive to detach because UIKit rebuilds its focus
  // graph. Keep both chat inspectors alive so a Files/Git switch only changes
  // visibility; the one not yet opened is prewarmed.
  const prewarmMode = props.mode === "files" ? "git" : props.mode === "git" ? "files" : null;
  const paneState = (mode: ThreadInspectorMode): PaneState =>
    visitedModes.has(mode) || props.mode === mode
      ? "mounted"
      : prewarmMode === mode
        ? "prewarm"
        : "unmounted";

  return (
    <View className="flex-1">
      <InspectorContentPane
        state={paneState("files")}
        resetKeys={props.resetKeys}
        visible={props.mode === "files"}
      >
        <InspectorRenderer render={props.renderFiles} />
      </InspectorContentPane>
      {props.renderGit ? (
        <InspectorContentPane
          state={paneState("git")}
          resetKeys={props.resetKeys}
          visible={props.mode === "git"}
        >
          <InspectorRenderer render={props.renderGit} />
        </InspectorContentPane>
      ) : null}
      {props.renderRoute ? (
        <InspectorContentPane
          state={paneState("route")}
          resetKeys={props.resetKeys}
          visible={props.mode === "route"}
        >
          <InspectorRenderer render={props.renderRoute} />
        </InspectorContentPane>
      ) : null}
    </View>
  );
}

// Render callbacks carry changing route data; they are not component types.
function InspectorRenderer(props: { readonly render: () => ReactNode }) {
  return <>{props.render()}</>;
}
