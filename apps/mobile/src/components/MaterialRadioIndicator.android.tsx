import { RadioButton } from "@expo/ui/jetpack-compose";
import { size } from "@expo/ui/jetpack-compose/modifiers";
import { View } from "react-native";
import { NativeThemeHost } from "./NativeThemeHost.android";

/** The enclosing radio row owns selection, touch and accessibility. */
export function MaterialRadioIndicator({ selected }: { readonly selected: boolean }) {
  return (
    <View pointerEvents="none" importantForAccessibility="no-hide-descendants">
      <NativeThemeHost ignoreSafeAreaKeyboardInsets style={{ width: 24, height: 24 }}>
        <RadioButton selected={selected} modifiers={[size(24, 24)]} />
      </NativeThemeHost>
    </View>
  );
}
