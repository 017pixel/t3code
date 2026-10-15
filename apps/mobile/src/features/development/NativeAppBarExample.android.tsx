import { View } from "react-native";
import { AppText } from "../../components/AppText";
import { IconButton } from "../../components/IconButton";
import { NativeAppBar } from "../../components/NativeAppBar.android";

export function NativeAppBarExample() {
  return (
    <NativeAppBar
      title={<AppText textRole="title">Native app bar</AppText>}
      navigationIcon={
        <IconButton icon="arrow.left" accessibilityLabel="Example back" onPress={() => {}} />
      }
      actions={
        <View className="flex-row">
          <IconButton
            icon="magnifyingglass"
            accessibilityLabel="Example search"
            onPress={() => {}}
          />
        </View>
      }
    />
  );
}
