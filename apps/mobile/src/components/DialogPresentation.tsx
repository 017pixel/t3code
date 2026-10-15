import type { ConfirmDialogRequest } from "./ConfirmDialog.types";

export interface DialogPresentationProps {
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

export function DialogPresentation(_props: DialogPresentationProps) {
  return null;
}
