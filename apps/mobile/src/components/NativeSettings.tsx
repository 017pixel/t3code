import {
  Form,
  Section,
  RNHostView,
  Toggle,
  Slider,
  Picker,
  Text,
  VStack,
  HStack,
  Spacer,
} from "@expo/ui/swift-ui";
import {
  background,
  disabled,
  font,
  foregroundStyle,
  listRowBackground,
  pickerStyle,
  scrollContentBackground,
  tag,
} from "@expo/ui/swift-ui/modifiers";
import { useRef } from "react";
import { NativeThemeHost } from "./NativeThemeHost";
import { useControlTheme } from "./useControlTheme";
import type {
  NativeSettingsContainerProps,
  NativeSettingsSectionProps,
  NativeSettingsContentProps,
  NativeSettingsToggleProps,
  NativeSettingsSliderProps,
  NativeSettingsPickerProps,
} from "./NativeSettings.types";

export function NativeSettingsForm(props: NativeSettingsContainerProps) {
  const { colors, fontSize } = useControlTheme();
  return (
    <NativeThemeHost style={{ flex: 1 }}>
      <Form
        modifiers={[
          scrollContentBackground("hidden"),
          background(colors["--color-sheet-solid"]),
          font({ family: "DMSans-Regular", size: fontSize, textStyle: "body" }),
          foregroundStyle(colors["--color-foreground"]),
        ]}
      >
        {props.children}
      </Form>
    </NativeThemeHost>
  );
}
export function NativeSettingsSection(props: NativeSettingsSectionProps) {
  const { colors } = useControlTheme();
  return (
    <Section title={props.title} modifiers={[listRowBackground(colors["--color-grouped-card"])]}>
      {props.children}
    </Section>
  );
}
export function NativeSettingsContent(props: NativeSettingsContentProps) {
  return <RNHostView matchContents={{ vertical: true }}>{props.children}</RNHostView>;
}
export function NativeSettingsToggle(props: NativeSettingsToggleProps) {
  return (
    <Toggle
      label={props.label}
      isOn={props.value}
      onIsOnChange={props.onValueChange}
      modifiers={[disabled(props.disabled)]}
    />
  );
}
export function NativeSettingsSlider(props: NativeSettingsSliderProps) {
  const draft = useRef(props.value);
  const editing = useRef(false);
  const { colors } = useControlTheme();
  return (
    <VStack spacing={8} modifiers={[disabled(props.disabled)]}>
      <HStack>
        <Text>{props.label}</Text>
        <Spacer />
        <Text modifiers={[foregroundStyle(colors["--color-foreground-muted"])]}>
          {props.valueLabel}
        </Text>
      </HStack>
      <Slider
        label={<Text>{props.label}</Text>}
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onValueChange={(value) => {
          draft.current = value;
          // VoiceOver adjustments can change the value without a touch-editing session.
          if (!editing.current && !props.disabled) props.onValueChange(value);
        }}
        onEditingChanged={(isEditing) => {
          editing.current = isEditing;
          if (!isEditing && !props.disabled) props.onValueChange(draft.current);
        }}
      />
    </VStack>
  );
}
export function NativeSettingsPicker<T extends string>(props: NativeSettingsPickerProps<T>) {
  return (
    <Picker
      label={props.label}
      selection={props.value}
      onSelectionChange={props.onValueChange}
      modifiers={[pickerStyle("menu"), disabled(props.disabled)]}
    >
      {props.options.map((option) => (
        <Text key={option.value} modifiers={[tag(option.value)]}>
          {option.label}
        </Text>
      ))}
    </Picker>
  );
}
