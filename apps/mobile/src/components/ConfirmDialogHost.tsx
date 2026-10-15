import { useCallback, useEffect, useState } from "react";
import { DialogPresentation } from "./DialogPresentation";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./ConfirmDialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./ConfirmDialog.types";

type DialogRequest =
  | { readonly kind: "confirm"; readonly request: ConfirmDialogRequest }
  | { readonly kind: "text-input"; readonly request: TextInputDialogRequest };

let presentRequest: ((request: DialogRequest) => void) | null = null;

export function showConfirmDialog(request: ConfirmDialogRequest): void {
  presentRequest?.({ kind: "confirm", request });
}

export function showTextInputDialog(request: TextInputDialogRequest): void {
  presentRequest?.({ kind: "text-input", request });
}

/** Android presenter for Dialog.confirm and Dialog.prompt; mounted once at the app root. */
export function ConfirmDialogHost() {
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
    presented?.request.onCancel?.();
    setPresented(null);
  }, [presented]);

  const handleConfirm = useCallback(
    (nativeInputValue?: string) => {
      if (presented?.kind === "confirm") {
        presented.request.onConfirm();
      } else if (presented?.kind === "text-input") {
        presented.request.onConfirm(nativeInputValue ?? inputValue);
      }
      setPresented(null);
    },
    [inputValue, presented],
  );

  const confirmDisabled = presented?.kind === "text-input" && inputValue.trim().length === 0;

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
