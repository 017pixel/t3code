import { Picker, Text } from "@expo/ui/swift-ui";
import { accessibilityLabel, pickerStyle, tag } from "@expo/ui/swift-ui/modifiers";
import { View } from "react-native";

import { NativeThemeHost } from "./NativeThemeHost";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Let UIKit own segment sizing, selection, and accessibility through SwiftUI. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  return (
    <View className={props.className}>
      <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <Picker
          selection={props.selected}
          onSelectionChange={props.onSelect}
          modifiers={[pickerStyle("segmented")]}
        >
          {props.options.map((option) => (
            <Text
              key={String(option.value)}
              modifiers={[
                tag(option.value),
                accessibilityLabel(option.accessibilityLabel ?? option.label),
              ]}
            >
              {option.label}
            </Text>
          ))}
        </Picker>
      </NativeThemeHost>
    </View>
  );
}
