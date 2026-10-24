#!/usr/bin/env python3
"""Create an offline native presentation fixture in an isolated checkout only.
Usage: python seed-native.py /absolute/isolated/checkout
Does not change the renderer, use a server, or seed a live database.
"""
import json, subprocess, sys
from pathlib import Path
root=Path(sys.argv[1]).resolve()
if root.name != 'issue-17531-native-evidence': raise SystemExit('expected dedicated evidence checkout')
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
if sha != '26c3625f484eadd4d5b6ca5a3dd1f8f8bd5533b4': raise SystemExit('unexpected source SHA')
mobile=root/'apps/mobile'
fixture=r'''import { useEffect } from "react";
import { View, StatusBar, ScrollView } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { RegistryContext } from "@effect/atom-react";
import * as DateTime from "effect/DateTime";
import { EnvironmentId, ThreadId, TurnItemId, RunId, type OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import { AppearancePreferencesProvider, useAppearancePreferences } from "./src/features/settings/appearance/AppearancePreferencesProvider";
import { appAtomRegistry } from "./src/state/atom-registry";
import { ThreadWorkLog } from "./src/features/threads/thread-work-log";
import { buildThreadFeed } from "./src/lib/threadActivity";
import { deriveThreadWorkLogSizing } from "./src/lib/layout";
import { AppText as Text } from "./src/components/ui/AppText";
import "./global.css";

const failure = {
  class: "provider_error" as const,
  code: "claude_mod_ui_unsupported",
  message: 'The Claude Code mod "blast-radius" is waiting for input in its terminal pane, which T3 Code cannot show. Disable the mod for sessions run from T3 Code, or run the task in the Claude Code terminal.',
  retryable: null,
};
const threadId = ThreadId.make("issue17531-static-fixture");
const at = DateTime.makeUnsafe("2026-10-24T09:41:00.000Z");
const projected: OrchestrationV2ProjectedTurnItem = {
  position: 0, visibility: "local", sourceThreadId: threadId,
  sourceItemId: TurnItemId.make("issue17531-failure"),
  item: {
    id: TurnItemId.make("issue17531-failure"), threadId,
    runId: RunId.make("issue17531-fixture-run"), nodeId: null,
    providerThreadId: null, providerTurnId: null, nativeItemRef: null,
    parentItemId: null, ordinal: 0, status: "failed", title: "Provider error",
    startedAt: at, completedAt: at, updatedAt: at,
    type: "error", failure,
  },
};
const activities = buildThreadFeed([projected]).flatMap(entry => entry.type === "activity-group" ? entry.activities : []);
const Stack = createNativeStackNavigator();
function FailureFixture() {
  const appearance = useAppearancePreferences();
  useEffect(() => { appearance.setThemeMode("dark"); }, []);
  return <SafeAreaView className="flex-1 bg-background" edges={["bottom"]}>
    <StatusBar barStyle="light-content" />
    <ScrollView contentContainerStyle={{padding:16, gap:24}}>
      <View className="gap-2">
        <Text className="font-t3-medium text-sm">STATIC FIXTURE · Issue 17531</Text>
        <Text className="text-xs text-foreground-muted">Current native failure renderer · mobile 26c3625f48</Text>
        <Text className="text-xs text-foreground-muted">Presentation only; no provider turn was executed.</Text>
      </View>
      <ThreadWorkLog activities={activities} anchorKey="issue17531" environmentId={EnvironmentId.make("offline-fixture")}
        copiedRowId={null} expandedRows={{}} rowSizing={deriveThreadWorkLogSizing({baseFontSize:14,fontScale:1})}
        scrollPositions={new Map()} iconSubtleColor="#999" edgeFadeColor="#111111" themeAppearance="dark"
        onCopyRow={() => {}} onToggleRow={() => {}} renderImage={() => null}
        renderReasoning={text => <Text>{text}</Text>} onPressPreview={() => {}} />
      <Text className="text-xs text-foreground-muted">Fixture failure.code: {failure.code}</Text>
    </ScrollView>
  </SafeAreaView>;
}
export default function NativeEvidenceFixture() {
  return <RegistryContext.Provider value={appAtomRegistry}><AppearancePreferencesProvider>
    <GestureHandlerRootView style={{flex:1}}><SafeAreaProvider>
      <NavigationContainer><Stack.Navigator screenOptions={{headerStyle:{backgroundColor:"#111111"},headerTintColor:"#ffffff",contentStyle:{backgroundColor:"#111111"}}}>
        <Stack.Screen name="Issue17531 fixture" component={FailureFixture} />
      </Stack.Navigator></NavigationContainer>
    </SafeAreaProvider></GestureHandlerRootView>
  </AppearancePreferencesProvider></RegistryContext.Provider>;
}
'''
(mobile/'issue17531-fixture.tsx').write_text(fixture)
entry=mobile/'index.ts'
source=subprocess.check_output(['git','show','HEAD:apps/mobile/index.ts'],cwd=root,text=True)
entry.write_text(source.replace('import App from "./src/App";', 'import App from "./issue17531-fixture";'))
config=json.loads((mobile/'eas.json').read_text())
config['build']['issue17531-evidence']={
 'extends':'preview', 'developmentClient':False, 'channel':'issue17531-evidence',
 'autoIncrement':False, 'env':{'APP_VARIANT':'preview','EXPO_PUBLIC_SHOWCASE':'1','NODE_OPTIONS':'--max-old-space-size=4096'},
 'ios':{'simulator':True,'image':'macos-tahoe-26.6-xcode-27.1'}
}
(mobile/'eas.json').write_text(json.dumps(config,indent=2)+'\n')
ignore=mobile/'.gitignore'
text=ignore.read_text() if ignore.exists() else ''
if '.env.eas-simulator' not in text: ignore.write_text(text+'\n.env.eas-simulator\n')
print('offline fixture injected; renderer unchanged; no server/data writes')
