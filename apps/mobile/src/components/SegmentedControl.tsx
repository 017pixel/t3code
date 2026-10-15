import { Picker } from "@expo/ui/swift-ui";
import { View } from "react-native";

import { useControlTheme } from "./useControlTheme";
import { NativeThemeHost } from "./NativeThemeHost";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

/** Let UIKit own segment sizing, selection, and accessibility through SwiftUI. */
export function SegmentedControl<Value extends string | number>(
  props: SegmentedControlProps<Value>,
) {
  const { colors } = useControlTheme();
  return (
    <View className={props.className}>
      <NativeThemeHost matchContents={{ vertical: true }} style={{ width: "100%" }}>
        <Picker
          selection={props.selected}
          onSelectionChange={props.onSelect}
          segments={props.options.map((option) => ({
            label: option.label,
            value: option.value,
          }))}
          segmentColors={{
            background: colors["--color-card"],
            selectedBackground: colors["--color-secondary"],
            text: colors["--color-foreground-muted"],
            selectedText: colors["--color-secondary-foreground"],
          }}
        />
      </NativeThemeHost>
    </View>
  );
}
