import { NativeThemeHost } from "./NativeThemeHost.android";
import {
  AlertDialog,
  Row,
  OutlinedTextField,
  Text,
  TextButton,
  useNativeState,
} from "@expo/ui/jetpack-compose";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { useScaledTextRole } from "../features/settings/appearance/useScaledTextRole";

import { useCallback, useEffect, useState } from "react";
import type { Alert, AlertButton } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

type AlertRequest = {
  readonly title: Parameters<typeof Alert.alert>[0];
  readonly message: Parameters<typeof Alert.alert>[1];
  readonly buttons: Parameters<typeof Alert.alert>[2];
  readonly options: Parameters<typeof Alert.alert>[3];
};

type DialogRequest =
  | { readonly kind: "alert"; readonly request: AlertRequest }
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

export function alert(...[title, message, buttons, options]: Parameters<typeof Alert.alert>): void {
  presentRequest?.({
    kind: "alert",
    request: { title, message, buttons: buttons?.slice(0, 3), options },
  });
}

export function confirm(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function prompt(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

/** Android presenter for Dialog.alert, Dialog.confirm and Dialog.prompt; mounted once at the app root. */
export function Host() {
  const [presented, setPresented] = useState<DialogRequest | null>(null);
  const [inputValue, setInputValue] = useState("");
  useEffect(() => {
    presentRequest = (request) => {
      setInputValue(request.kind === "text-input" ? request.request.initialValue : "");
      setPresented(request);
    };
    return () => {
      presentRequest = null;
    };
  }, []);

  const handleCancel = useCallback(() => {
    setPresented(null);
    if (presented?.kind === "alert") presented.request.options?.onDismiss?.();
    else presented?.request.onCancel?.();
  }, [presented]);

  const handleConfirm = useCallback(
    (nativeInputValue?: string) => {
      setPresented(null);
      if (presented?.kind === "confirm") {
        presented.request.onConfirm();
      } else if (presented?.kind === "text-input") {
        presented.request.onConfirm(nativeInputValue ?? inputValue);
      }
    },
    [inputValue, presented],
  );

  const confirmDisabled = presented?.kind === "text-input" && inputValue.trim().length === 0;

  if (presented?.kind === "alert") {
    return (
      <DialogPresentation
        key={`alert:${presented.request.title}`}
        request={{
          title: presented.request.title ?? "",
          message: presented.request.message ?? undefined,
          confirmText: "",
        }}
        alertActions={presented.request.buttons ?? [{ text: "OK" }]}
        dismissable={presented.request.options?.cancelable ?? false}
        onAlertAction={(action) => {
          setPresented(null);
          action.onPress?.();
        }}
        onCancel={handleCancel}
        onConfirm={handleConfirm}
      />
    );
  }

  return presented ? (
    <DialogPresentation
      key={`${presented.kind}:${presented.request.title}:${presented.kind === "text-input" ? presented.request.initialValue : ""}`}
      request={presented.request}
      inputInitialValue={
        presented.kind === "text-input" ? presented.request.initialValue : undefined
      }
      onInputChange={setInputValue}
      confirmDisabled={confirmDisabled}
      onCancel={handleCancel}
      onConfirm={handleConfirm}
    />
  ) : null;
}

function DialogPresentation(props: DialogPresentationProps) {
  const { themeVariables: colors } = useAppearancePreferences();
  const titleTypography = useScaledTextRole("title");
  const bodyTypography = useScaledTextRole("footnote");
  const inputTypography = useScaledTextRole("body");
  const inputState = useNativeState(props.inputInitialValue ?? "");
  const inputSelection = useNativeState({ start: 0, end: props.inputInitialValue?.length ?? 0 });
  const confirm = () => {
    if (props.confirmDisabled) return;
    const value = props.inputInitialValue === undefined ? undefined : inputState.get();
    if (value !== undefined && !value.trim()) return;
    props.onConfirm(value);
  };
  const actions = props.alertActions ?? [
    { text: props.request.cancelText ?? "Cancel", onPress: props.onCancel },
    {
      text: props.request.confirmText,
      style: props.request.destructive ? ("destructive" as const) : ("default" as const),
      onPress: confirm,
    },
  ];
  const renderAction = (action: AlertButton, index: number) => (
    <TextButton
      key={index}
      onClick={() => (props.alertActions ? props.onAlertAction?.(action) : action.onPress?.())}
      enabled={
        props.alertActions !== undefined || index !== actions.length - 1 || !props.confirmDisabled
      }
      colors={{
        contentColor:
          colors[
            action.style === "destructive" ? "--color-danger-foreground" : "--color-primary-text"
          ],
      }}
    >
      <Text style={bodyTypography}>{action.text ?? ""}</Text>
    </TextButton>
  );
  return (
    <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ height: 0, width: 0 }}>
      <AlertDialog
        onDismissRequest={props.onCancel}
        properties={{
          dismissOnBackPress: props.dismissable ?? true,
          dismissOnClickOutside: props.dismissable ?? true,
        }}
        tonalElevation={0}
        colors={{
          containerColor: colors["--color-card-alt"],
          titleContentColor: colors["--color-foreground"],
          textContentColor: colors["--color-foreground-secondary"],
        }}
      >
        <AlertDialog.Title>
          <Text style={titleTypography}>{props.request.title}</Text>
        </AlertDialog.Title>
        {props.inputInitialValue !== undefined ? (
          <AlertDialog.Text>
            <OutlinedTextField
              autoFocus
              singleLine
              value={inputState}
              selection={inputSelection}
              onValueChange={props.onInputChange}
              textStyle={inputTypography}
              keyboardOptions={{ imeAction: "done" }}
              keyboardActions={{
                onDone: confirm,
              }}
              colors={{
                focusedTextColor: colors["--color-foreground"],
                unfocusedTextColor: colors["--color-foreground"],
                focusedIndicatorColor: colors["--color-focus"],
                unfocusedIndicatorColor: colors["--color-border"],
                cursorColor: colors["--color-focus"],
              }}
            >
              <OutlinedTextField.Label>
                <Text style={bodyTypography}>{props.request.title}</Text>
              </OutlinedTextField.Label>
            </OutlinedTextField>
          </AlertDialog.Text>
        ) : props.request.message ? (
          <AlertDialog.Text>
            <Text style={bodyTypography}>{props.request.message}</Text>
          </AlertDialog.Text>
        ) : null}
        {actions.length > 1 ? (
          <AlertDialog.DismissButton>
            <Row>{actions.slice(0, -1).map(renderAction)}</Row>
          </AlertDialog.DismissButton>
        ) : null}
        {actions.length > 0 ? (
          <AlertDialog.ConfirmButton>
            {renderAction(actions[actions.length - 1]!, actions.length - 1)}
          </AlertDialog.ConfirmButton>
        ) : null}
      </AlertDialog>
    </NativeThemeHost>
  );
}

interface DialogPresentationProps {
  readonly alertActions?: readonly AlertButton[];
  readonly onAlertAction?: (action: AlertButton) => void;
  readonly dismissable?: boolean;
  readonly request: Pick<
    ConfirmDialogRequest,
    "title" | "message" | "cancelText" | "confirmText" | "destructive"
  >;
  readonly inputInitialValue?: string;
  readonly onInputChange?: (value: string) => void;
  readonly confirmDisabled?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (inputValue?: string) => void;
}
