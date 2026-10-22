// Copied to apps/mobile/src/read-cache.fixture.tsx by the evidence build driver.
// Static simulated signing history; no server transport, ThreadFeed, or native preview.
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, OrchestrationV2TurnItemJson } from "@t3tools/contracts";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import * as Schema from "effect/Schema";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { useState } from "react";
import { SafeAreaView, ScrollView, View, Text, Button, StatusBar } from "react-native";
import { Uniwind } from "uniwind";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ThreadWorkLog } from "./features/threads/thread-work-log";
import {
  ThreadMarkdownImageView,
  MarkdownImageAvailableWidthContext,
} from "./features/threads/ThreadMarkdownImage";
import { buildThreadFeed } from "./lib/threadActivity";
import { deriveThreadWorkLogSizing } from "./lib/layout";
import { appAtomRegistry } from "./state/atom-registry";
import fixture from "../../../scripts/fixtures/read-image-cache.json";
import pixels from "../../../scripts/fixtures/read-cache-pixels.json";
import "../global.css";

const Stack = createNativeStackNavigator();
const env = EnvironmentId.make(fixture.environmentId);
const threadId = ThreadId.make(fixture.thread.id);
const reads = fixture.items
  .filter((x) => x.type === "dynamic_tool")
  .map((x) => Schema.decodeUnknownSync(OrchestrationV2TurnItemJson)(x));
const groups = reads.map((item, position) =>
  buildThreadFeed([
    { position, visibility: "local", sourceThreadId: threadId, sourceItemId: item.id, item },
  ]).flatMap((e) => (e.type === "activity-group" ? e.activities : [])),
);
const signing = new Map<string, string>();
const noop = () => {};

function Screen() {
  const [dark, setDark] = useState(false);
  const [states, setStates] = useState(false);
  const scheme = dark ? "dark" : "light";
  Uniwind.setTheme(scheme);
  const fg = dark ? "#eee" : "#171717";
  const bg = dark ? "#111" : "#fff";
  const draw = (
    uri: string | null,
    sourceKey: string,
    unavailable = false,
    unavailableDetail?: string,
    knownSize = true,
  ) => (
    <ThreadMarkdownImageView
      uri={uri}
      sourceKey={sourceKey}
      unavailable={unavailable}
      unavailableDetail={unavailableDetail}
      alt={sourceKey}
      knownSize={knownSize ? { width: 100, height: 100 } : undefined}
      onPressPreview={noop}
    />
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: bg }}>
      <StatusBar barStyle={dark ? "light-content" : "dark-content"} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 10 }}>
        <Text style={{ color: fg, fontSize: 17, fontWeight: "600" }}>
          Native iOS static fixture
        </Text>
        <Text style={{ color: fg, fontSize: 12 }}>
          Simulated signing state • production work-log rows and image view. Transport, ThreadFeed
          and native preview bypassed.
        </Text>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Button title={dark ? "Light" : "Dark"} onPress={() => setDark(!dark)} />
          <Button title={states ? "Read rows" : "States"} onPress={() => setStates(!states)} />
        </View>
        <MarkdownImageAvailableWidthContext value={358}>
          {states ? (
            <>
              <Text style={{ color: fg }}>Loading (static appearance)</Text>
              {draw(null, "Loading")}
              <Text style={{ color: fg }}>Missing file</Text>
              {draw(null, "Missing file", true)}
              <Text style={{ color: fg }}>Missing read access</Text>
              {draw(
                null,
                "Missing read access",
                true,
                "This connection cannot read host files. Pair again with a new link to view it.",
              )}
              <Text style={{ color: fg }}>No dimensions (decoded success)</Text>
              {draw(pixels.blue, "No dimensions", false, undefined, false)}
            </>
          ) : (
            groups.map((activities, index) => (
              <View key={index} style={{ gap: 4 }}>
                <Text style={{ color: fg, fontSize: 12 }}>
                  R{index + 1} • staged {["red", "green", "blue"][index]}
                </Text>
                <ThreadWorkLog
                  activities={activities}
                  anchorKey={"fixture-" + index}
                  environmentId={env}
                  workspaceRoot={fixture.project.workspace_root}
                  copiedRowId={null}
                  expandedRows={Object.fromEntries(activities.map((a) => [a.id, true]))}
                  rowSizing={deriveThreadWorkLogSizing({ baseFontSize: 14, fontScale: 1 })}
                  scrollPositions={new Map()}
                  iconSubtleColor={fg}
                  edgeFadeColor={bg}
                  themeAppearance={scheme}
                  onCopyRow={noop}
                  onToggleRow={noop}
                  renderReasoning={() => null}
                  onPressPreview={noop}
                  renderImage={(image, itemId) => {
                    const asset = resolveViewedImageAsset(image.href, {
                      threadId,
                      workspaceRoot: fixture.project.workspace_root,
                      itemId: itemId ?? reads[index]!.id,
                    });
                    const key = JSON.stringify([
                      asset?.resource,
                      asset && "signingKey" in asset ? asset.signingKey : null,
                    ]);
                    let uri = signing.get(key);
                    if (!uri) {
                      uri = [pixels.red, pixels.green, pixels.blue][index]!;
                      signing.set(key, uri);
                    }
                    return draw(uri, "Read square.png");
                  }}
                />
              </View>
            ))
          )}
        </MarkdownImageAvailableWidthContext>
      </ScrollView>
    </SafeAreaView>
  );
}
export default function Fixture() {
  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <NavigationContainer>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Fixture" component={Screen} />
          </Stack.Navigator>
        </NavigationContainer>
      </GestureHandlerRootView>
    </RegistryContext.Provider>
  );
}
