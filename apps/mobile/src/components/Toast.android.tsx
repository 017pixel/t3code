import {
  Card,
  Column,
  LoadingIndicator,
  Row,
  Snackbar,
  SnackbarHost,
  Text,
  type SnackbarHostRef,
} from "@expo/ui/jetpack-compose";
import {
  fillMaxWidth,
  onGloballyPositioned,
  paddingAll,
  size,
} from "@expo/ui/jetpack-compose/modifiers";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { themeColorWithContrast } from "../lib/mobileTheme";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";
import { NativeThemeHost } from "./NativeThemeHost.android";
import type { ToastProps } from "./Toast.types";
import { useControlTheme } from "./useControlTheme";

export type { ToastProps } from "./Toast.types";

export function Toast(props: ToastProps) {
  const { colors } = useControlTheme();
  const textStyle = useScaledTextRole("footnote");
  if (props.busy) {
    return (
      <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <Card
          colors={{
            containerColor: colors["--color-card"],
            contentColor: colors["--color-foreground"],
          }}
          modifiers={[fillMaxWidth()]}
        >
          <Row
            verticalAlignment="center"
            horizontalArrangement={{ spacedBy: 12 }}
            modifiers={[paddingAll(16)]}
          >
            <LoadingIndicator color={colors["--color-primary"]} modifiers={[size(24, 24)]} />
            <Column>
              <Text style={textStyle}>{props.message}</Text>
              {props.description ? <Text style={textStyle}>{props.description}</Text> : null}
            </Column>
          </Row>
        </Card>
      </NativeThemeHost>
    );
  }
  // Replacing content replaces its native queue rather than enqueueing behind an indefinite notice.
  return (
    <Message
      key={JSON.stringify([
        props.message,
        props.description,
        props.action?.label,
        Boolean(props.onDismiss),
      ])}
      {...props}
    />
  );
}

function Message(props: ToastProps) {
  const { colors } = useControlTheme();
  const host = useRef<SnackbarHostRef>(null);
  const [ready, setReady] = useState(false);
  const withDismissAction = Boolean(props.onDismiss);
  const onResult = useEffectEvent((result: string) => {
    if (result === "actionPerformed") props.action?.onPress();
    else props.onDismiss?.();
  });
  const requested = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    if (!ready || requested.current || !host.current) return;
    requested.current = true;
    void host.current
      .showSnackbar({
        message: [props.message, props.description].filter(Boolean).join("\n"),
        actionLabel: props.action?.label,
        withDismissAction,
        duration: "indefinite",
      })
      .then((result) => {
        if (!active.current) return;
        onResult(result);
      })
      .catch((error: unknown) => {
        if (active.current) console.warn("Could not present toast", error);
      });
  }, [ready, props.message, props.description, props.action?.label, withDismissAction]);
  return (
    <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
      <SnackbarHost
        ref={host}
        modifiers={[fillMaxWidth(), onGloballyPositioned(() => setReady(true))]}
      >
        <Snackbar
          containerColor={colors["--color-foreground"]}
          contentColor={
            props.tone === "danger"
              ? themeColorWithContrast(
                  colors["--color-danger-foreground"],
                  colors["--color-foreground"],
                )
              : colors["--color-screen"]
          }
          actionContentColor={colors["--color-primary-foreground"]}
          dismissActionContentColor={colors["--color-screen"]}
        />
      </SnackbarHost>
    </NativeThemeHost>
  );
}
