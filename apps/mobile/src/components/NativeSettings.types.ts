import type { ReactElement, ReactNode } from "react";

export interface NativeSettingsContainerProps {
  readonly children: ReactNode;
}
export interface NativeSettingsSectionProps extends NativeSettingsContainerProps {
  readonly title: string;
}
export interface NativeSettingsContentProps {
  readonly children: ReactElement;
}
export interface NativeSettingsToggleProps {
  readonly label: string;
  readonly value: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: boolean) => void;
}
export interface NativeSettingsSliderProps {
  readonly label: string;
  readonly value: number;
  readonly valueLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly disabled?: boolean;
  readonly onValueChange: (value: number) => void;
}
export interface NativeSettingsPickerProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly disabled?: boolean;
  readonly onValueChange: (value: T) => void;
}
