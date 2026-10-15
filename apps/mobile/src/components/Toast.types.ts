export interface ToastProps {
  readonly message: string;
  readonly description?: string;
  readonly tone?: "default" | "success" | "danger";
  readonly busy?: boolean;
  readonly action?: { readonly label: string; readonly onPress: () => void };
  readonly onDismiss?: () => void;
}
