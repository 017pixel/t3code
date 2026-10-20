import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { ScreenStack } from "react-native-screens";
import { AndroidSheetHeader } from "../../components/ui/AndroidScreenHeader";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { NativeSheetContent } from "../../native/NativeSheetContent";
import { NativeHeader, NativeScreen } from "../../native/ThemedScreenStack";
import { nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadHandoffEnvironment } from "../../state/threadHandoff";

export function ThreadHandoffSheet({ route }: StaticScreenProps<ScopedThreadRef>) {
  return (
    <HandoffSelection
      key={`${route.params.environmentId}:${route.params.threadId}`}
      target={route.params}
    />
  );
}
function HandoffSelection({ target }: { target: ScopedThreadRef }) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const key = `${target.environmentId}:${target.threadId}`;
  const token = useMemo(() => ({ key, focused }), [key, focused]);
  const identity = useRef<typeof token | null>(null);
  useLayoutEffect(() => {
    identity.current = token;
    return () => {
      identity.current = null;
    };
  }, [token]);
  const optionsAtom = threadHandoffEnvironment.options({
    environmentId: target.environmentId,
    input: { threadId: target.threadId },
  });
  const options = useAtomValue(optionsAtom);
  const available = useAtomValue(threadHandoffEnvironment.availableAtom(target));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const working = useRef(false);
  const current = () => identity.current === token && token.focused;
  const start = async (
    option: Extract<typeof options, { _tag: "Success" }>["value"]["options"][number],
  ) => {
    if (
      !current() ||
      working.current ||
      option.reason !== null ||
      option.projectId === null ||
      !appAtomRegistry.get(threadHandoffEnvironment.availableAtom(target))
    )
      return;
    working.current = true;
    setBusy(true);
    setError(null);
    const result = await threadHandoffEnvironment.start.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: {
        threadId: target.threadId,
        environmentId: option.environmentId,
        projectId: option.projectId,
        isCurrent: current,
      },
    });
    if (!current()) return;
    working.current = false;
    setBusy(false);
    if (AsyncResult.isSuccess(result)) navigation.goBack();
    else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not start the move. Try again.");
    }
  };
  const content = (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 20, gap: 16 }}
    >
      <Text>
        Move this conversation and Git working changes to a linked environment with the same
        repository. A fresh agent continues there.
      </Text>
      {!available && !busy ? (
        <Text>Stop any work and send queued messages before moving this thread.</Text>
      ) : null}
      {options.waiting || options._tag === "Initial" ? (
        <Text>Finding linked environments…</Text>
      ) : null}
      {AsyncResult.isFailure(options) ? (
        <>
          <Text>Could not load destinations.</Text>
          <Button label="Retry" onPress={() => appAtomRegistry.refresh(optionsAtom)} />
        </>
      ) : null}
      {AsyncResult.isSuccess(options) ? (
        options.value.options.length === 0 ? (
          <Text>No linked environments found. Link an environment in Connections first.</Text>
        ) : (
          options.value.options.map((option) => (
            <View key={option.environmentId} className="gap-2">
              <Button
                label={option.label}
                disabled={!available || busy || option.projectId === null || option.reason !== null}
                onPress={() => void start(option)}
              />
              {option.reason ? (
                <Text className="text-sm text-foreground-muted">{option.reason}</Text>
              ) : null}
            </View>
          ))
        )
      ) : null}
      {busy ? <Text>Starting the move…</Text> : null}
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      <Button label="Close" tone="text" onPress={() => navigation.goBack()} />
    </ScrollView>
  );
  return Platform.OS === "ios" ? (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScreenStack style={{ flex: 1 }}>
        <NativeScreen
          activityState={2}
          enabled
          isNativeStack
          screenId="thread-handoff-sheet-native"
          scrollEdgeEffects={nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)}
          className="flex-1 bg-sheet"
        >
          <NativeSheetContent>{content}</NativeSheetContent>
          <NativeHeader
            hideBackButton
            hideShadow={false}
            backgroundColor="rgba(0,0,0,0)"
            tintColorClassName="accent-foreground"
            title="Continue on…"
            titleColorClassName="accent-foreground"
            titleFontSize={18}
            titleFontWeight="800"
            translucent
          />
        </NativeScreen>
      </ScreenStack>
    </View>
  ) : (
    <View className="flex-1 bg-sheet">
      <AndroidSheetHeader title="Continue on…" onBack={() => navigation.goBack()} />
      {content}
    </View>
  );
}
