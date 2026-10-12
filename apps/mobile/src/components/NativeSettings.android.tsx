import {
  Column,
  ListItem,
  RadioButton,
  RNHostView,
  Slider,
  Switch,
  Text,
} from "@expo/ui/jetpack-compose";
import {
  background,
  clip,
  fillMaxSize,
  fillMaxWidth,
  padding,
  selectable,
  selectableGroup,
  semantics,
  Shapes,
  toggleable,
  verticalScroll,
} from "@expo/ui/jetpack-compose/modifiers";
import { useEffect, useRef } from "react";
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

const roundedGroup = Shapes.RoundedCorner;

export function NativeSettingsForm(props: NativeSettingsContainerProps) {
  return (
    <NativeThemeHost style={{ flex: 1 }}>
      <Column
        modifiers={[fillMaxSize(), verticalScroll(), padding(16, 16, 16, 32)]}
        verticalArrangement={{ spacedBy: 24 }}
      >
        {props.children}
      </Column>
    </NativeThemeHost>
  );
}
export function NativeSettingsSection(props: NativeSettingsSectionProps) {
  const { colors, fontSize } = useControlTheme();
  return (
    <Column modifiers={[fillMaxWidth()]} verticalArrangement={{ spacedBy: 8 }}>
      <Text
        color={colors["--color-foreground-muted"]}
        style={{ fontSize: fontSize * 0.875, fontFamily: "DMSans-Regular" }}
        modifiers={[padding(16, 0, 16, 0)]}
      >
        {props.title}
      </Text>
      <Column
        modifiers={[
          fillMaxWidth(),
          clip(roundedGroup(28)),
          background(colors["--color-grouped-card"]),
        ]}
      >
        {props.children}
      </Column>
    </Column>
  );
}
export function NativeSettingsContent(props: NativeSettingsContentProps) {
  return (
    <RNHostView matchContents={{ vertical: true }} modifiers={[fillMaxWidth()]}>
      {props.children}
    </RNHostView>
  );
}
function Label(props: { readonly children: string }) {
  const { fontSize } = useControlTheme();
  return <Text style={{ fontSize, fontFamily: "DMSans-Regular" }}>{props.children}</Text>;
}
export function NativeSettingsToggle(props: NativeSettingsToggleProps) {
  const { colors } = useControlTheme();
  return (
    <ListItem
      colors={{ containerColor: colors["--color-grouped-card"] }}
      modifiers={
        props.disabled
          ? []
          : [toggleable(props.value, () => props.onValueChange(!props.value), { role: "switch" })]
      }
    >
      <ListItem.HeadlineContent>
        <Label>{props.label}</Label>
      </ListItem.HeadlineContent>
      <ListItem.TrailingContent>
        <Switch
          value={props.value}
          enabled={!props.disabled}
          onCheckedChange={props.onValueChange}
        />
      </ListItem.TrailingContent>
    </ListItem>
  );
}
export function NativeSettingsSlider(props: NativeSettingsSliderProps) {
  const draft = useRef(props.value);
  useEffect(() => {
    draft.current = props.value;
  }, [props.value]);
  const { colors, fontSize } = useControlTheme();
  return (
    <Column modifiers={[fillMaxWidth(), padding(16, 12, 16, 8)]}>
      <Text style={{ fontSize, fontFamily: "DMSans-Regular" }}>
        {props.label}: {props.valueLabel}
      </Text>
      <Slider
        enabled={!props.disabled}
        min={props.min}
        max={props.max}
        value={props.value}
        steps={Math.max(0, Math.round((props.max - props.min) / props.step) - 1)}
        modifiers={[fillMaxWidth(), semantics({ contentDescription: props.label })]}
        colors={{
          thumbColor: colors["--color-primary"],
          activeTrackColor: colors["--color-primary"],
          inactiveTrackColor: colors["--color-secondary"],
        }}
        onValueChange={(value) => {
          draft.current = value;
        }}
        onValueChangeFinished={() => {
          if (!props.disabled)
            props.onValueChange(
              Math.min(
                props.max,
                Math.max(
                  props.min,
                  props.min + Math.round((draft.current - props.min) / props.step) * props.step,
                ),
              ),
            );
        }}
      />
    </Column>
  );
}
export function NativeSettingsPicker<T extends string>(props: NativeSettingsPickerProps<T>) {
  const { colors } = useControlTheme();
  return (
    <Column modifiers={[fillMaxWidth(), selectableGroup()]}>
      {props.options.map((option) => (
        <ListItem
          key={option.value}
          colors={{ containerColor: colors["--color-grouped-card"] }}
          modifiers={
            props.disabled
              ? []
              : [
                  selectable(
                    option.value === props.value,
                    () => props.onValueChange(option.value),
                    "radioButton",
                  ),
                ]
          }
        >
          <ListItem.HeadlineContent>
            <Label>{option.label}</Label>
          </ListItem.HeadlineContent>
          <ListItem.TrailingContent>
            <RadioButton selected={option.value === props.value} enabled={!props.disabled} />
          </ListItem.TrailingContent>
        </ListItem>
      ))}
    </Column>
  );
}
