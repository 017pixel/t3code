import { memo, useId } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

import { mixThemePreviewBase, THEME_PREVIEW_RENDER_SPECS } from "@t3tools/shared/themePreview";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import {
  getMobileThemePreviewColors,
  MOBILE_THEME_OPTIONS,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "../../../../lib/mobileTheme";
import { cn } from "../../../../lib/cn";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const previewPercentage = (value: number) => `${value * 100}%`;

const PreviewOrb = memo(function PreviewOrb(props: {
  readonly appearance: MobileThemeAppearance;
  readonly compact?: boolean;
  readonly themeId: MobileThemeId;
}) {
  const idPrefix = useId().replaceAll(":", "");
  const accentGradientId = `${idPrefix}-accent-glow`;
  const actionGradientId = `${idPrefix}-action-glow`;
  const { systemColorPalettes } = useAppearancePreferences();
  const palette = systemColorPalettes?.[props.appearance];
  const colors =
    props.themeId === "material-you" && palette
      ? { canvas: palette.surface, accent: palette.primary, messageAction: palette.tertiary }
      : getMobileThemePreviewColors(props.themeId, props.appearance);
  const spec = THEME_PREVIEW_RENDER_SPECS[props.appearance];
  const accentRadius = Math.hypot(
    Math.max(spec.accent.center[0], 1 - spec.accent.center[0]),
    Math.max(spec.accent.center[1], 1 - spec.accent.center[1]),
  );
  const actionRadius = Math.hypot(
    Math.max(spec.action.center[0], 1 - spec.action.center[0]),
    Math.max(spec.action.center[1], 1 - spec.action.center[1]),
  );
  return (
    <View
      className={`${props.compact ? "size-14" : "size-16"} overflow-hidden rounded-full border`}
      style={{
        borderColor:
          props.appearance === "dark" ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.1)",
      }}
    >
      <Svg accessibilityElementsHidden height="100%" viewBox="0 0 64 64" width="100%">
        <Defs>
          <RadialGradient
            cx={previewPercentage(spec.accent.center[0])}
            cy={previewPercentage(spec.accent.center[1])}
            fx={previewPercentage(spec.accent.center[0])}
            fy={previewPercentage(spec.accent.center[1])}
            id={accentGradientId}
            r={previewPercentage(accentRadius)}
          >
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={1} />
            <Stop
              offset={previewPercentage(spec.accent.middleOffset)}
              stopColor={colors.accent}
              stopOpacity={spec.accent.middleOpacity}
            />
            <Stop
              offset={previewPercentage(spec.accent.endOffset)}
              stopColor={colors.accent}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient
            cx={previewPercentage(spec.action.center[0])}
            cy={previewPercentage(spec.action.center[1])}
            fx={previewPercentage(spec.action.center[0])}
            fy={previewPercentage(spec.action.center[1])}
            id={actionGradientId}
            r={previewPercentage(actionRadius)}
          >
            <Stop
              offset="0%"
              stopColor={colors.messageAction}
              stopOpacity={spec.action.startOpacity}
            />
            <Stop
              offset={previewPercentage(spec.action.endOffset)}
              stopColor={colors.messageAction}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.messageAction} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="32" cy="32" fill={mixThemePreviewBase(colors, props.appearance)} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${actionGradientId})`} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${accentGradientId})`} r="32" />
      </Svg>
    </View>
  );
});

function ThemeCard(props: {
  readonly disabled: boolean;
  readonly darkSelected: boolean;
  readonly label: string;
  readonly lightSelected: boolean;
  readonly onSelectBoth: () => void;
  readonly onSelect: (appearance: MobileThemeAppearance) => void;
  readonly themeId: MobileThemeId;
}) {
  const choice = (appearance: MobileThemeAppearance, selected: boolean) => (
    <Pressable
      accessibilityHint={`Sets the ${appearance} appearance only`}
      accessibilityLabel={`${props.label} ${appearance} theme`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected }}
      className={cn(
        "size-[66px] items-center justify-center rounded-full border-[3px] active:scale-[0.94]",
        selected ? "border-primary" : "border-transparent",
      )}
      disabled={props.disabled}
      onPress={() => props.onSelect(appearance)}
    >
      <PreviewOrb appearance={appearance} compact themeId={props.themeId} />
      {selected ? (
        <View className="absolute -bottom-0.5 -right-0.5 size-5 items-center justify-center rounded-full border border-border bg-card">
          <SymbolView
            name={appearance === "light" ? "sun.max" : "moon"}
            size={12}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="medium"
          />
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <View className="min-w-36 flex-1 basis-[47%] gap-3 rounded-[24px] border border-border bg-grouped-card px-2 py-4">
      <Pressable
        accessibilityHint="Sets both light and dark appearances"
        accessibilityLabel={`${props.label} theme`}
        accessibilityRole="button"
        accessibilityState={{
          disabled: props.disabled,
          selected: props.lightSelected && props.darkSelected,
        }}
        className="absolute inset-0 rounded-[24px] active:bg-subtle"
        disabled={props.disabled}
        onPress={props.onSelectBoth}
      />
      <View className="flex-row items-center justify-center gap-2 py-1" pointerEvents="box-none">
        {choice("light", props.lightSelected)}
        {choice("dark", props.darkSelected)}
      </View>
      <Text
        className="min-w-0 flex-1 px-1 text-lg font-t3-medium"
        numberOfLines={1}
        pointerEvents="none"
      >
        {props.label}
      </Text>
    </View>
  );
}

export function ThemeAppearanceSection() {
  const {
    isReady,
    setThemeIdForAppearance,
    setThemeIdForBothAppearances,
    themeIds,
    systemColorsAvailable,
  } = useAppearancePreferences();
  return (
    <View className="flex-row flex-wrap gap-3">
      {MOBILE_THEME_OPTIONS.filter(
        (theme) => theme.id !== "material-you" || systemColorsAvailable,
      ).map((theme) => (
        <ThemeCard
          key={theme.id}
          disabled={!isReady}
          label={theme.label}
          darkSelected={theme.id === themeIds.dark}
          lightSelected={theme.id === themeIds.light}
          onSelect={(appearance) => setThemeIdForAppearance(appearance, theme.id)}
          onSelectBoth={() => setThemeIdForBothAppearances(theme.id)}
          themeId={theme.id}
        />
      ))}
    </View>
  );
}
