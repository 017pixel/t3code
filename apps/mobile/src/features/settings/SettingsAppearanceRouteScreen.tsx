import { View } from "react-native";
import {
  NativeSettingsContent,
  NativeSettingsForm,
  NativeSettingsPicker,
  NativeSettingsSection,
  NativeSettingsSlider,
  NativeSettingsToggle,
} from "../../components/NativeSettings";
import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
  CODE_FONT_SIZE_STEP,
  MAX_CODE_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
} from "../../lib/appearancePreferences";
import type { MobileThemeMode } from "../../lib/mobileTheme";
import { SettingsScreen } from "./components/SettingsScreen";
import { useAppearancePreferences } from "./appearance/AppearancePreferencesProvider";
import {
  CodeAppearancePreview,
  TerminalAppearancePreview,
  TextAppearancePreview,
} from "./appearance/components/AppearancePreviews";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";

const modes: ReadonlyArray<{ value: MobileThemeMode; label: string }> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsAppearanceRouteScreen() {
  const {
    isReady,
    appearance,
    themeMode,
    setThemeMode,
    setBaseFontSize,
    setTerminalFontSize,
    setCodeFontSize,
    setCodeWordBreak,
  } = useAppearancePreferences();
  return (
    <SettingsScreen title="Appearance">
      <NativeSettingsForm>
        <NativeSettingsSection title="Color scheme">
          <NativeSettingsPicker
            label="Appearance"
            value={themeMode}
            options={modes}
            disabled={!isReady}
            onValueChange={setThemeMode}
          />
        </NativeSettingsSection>
        <NativeSettingsSection title="Themes">
          <NativeSettingsContent>
            <View className="py-2">
              <ThemeAppearanceSection />
            </View>
          </NativeSettingsContent>
        </NativeSettingsSection>
        <NativeSettingsSection title="Text">
          <NativeSettingsContent>
            <View>
              <TextAppearancePreview fontSize={appearance.baseFontSize} />
            </View>
          </NativeSettingsContent>
          <NativeSettingsSlider
            label="Text size"
            value={appearance.baseFontSize}
            valueLabel={`${appearance.baseFontSize} pt`}
            min={MIN_BASE_FONT_SIZE}
            max={MAX_BASE_FONT_SIZE}
            step={BASE_FONT_SIZE_STEP}
            disabled={!isReady}
            onValueChange={setBaseFontSize}
          />
        </NativeSettingsSection>
        <NativeSettingsSection title="Terminal">
          <NativeSettingsContent>
            <View>
              <TerminalAppearancePreview fontSize={appearance.terminalFontSize} />
            </View>
          </NativeSettingsContent>
          <NativeSettingsToggle
            label="Custom font size"
            value={appearance.isTerminalFontSizeCustom}
            disabled={!isReady}
            onValueChange={(enabled) =>
              setTerminalFontSize(enabled ? appearance.terminalFontSize : null)
            }
          />
          {appearance.isTerminalFontSizeCustom ? (
            <NativeSettingsSlider
              label="Font size"
              value={appearance.terminalFontSize}
              valueLabel={`${appearance.terminalFontSize.toFixed(1)} pt`}
              min={MIN_TERMINAL_FONT_SIZE}
              max={MAX_TERMINAL_FONT_SIZE}
              step={TERMINAL_FONT_SIZE_STEP}
              disabled={!isReady}
              onValueChange={setTerminalFontSize}
            />
          ) : null}
        </NativeSettingsSection>
        <NativeSettingsSection title="Code & Diffs">
          <NativeSettingsContent>
            <View>
              <CodeAppearancePreview
                fontSize={appearance.codeFontSize}
                wordBreak={appearance.codeWordBreak}
              />
            </View>
          </NativeSettingsContent>
          <NativeSettingsToggle
            label="Custom font size"
            value={appearance.isCodeFontSizeCustom}
            disabled={!isReady}
            onValueChange={(enabled) => setCodeFontSize(enabled ? appearance.codeFontSize : null)}
          />
          {appearance.isCodeFontSizeCustom ? (
            <NativeSettingsSlider
              label="Font size"
              value={appearance.codeFontSize}
              valueLabel={`${appearance.codeFontSize} pt`}
              min={MIN_CODE_FONT_SIZE}
              max={MAX_CODE_FONT_SIZE}
              step={CODE_FONT_SIZE_STEP}
              disabled={!isReady}
              onValueChange={setCodeFontSize}
            />
          ) : null}
          <NativeSettingsToggle
            label="Word break"
            value={appearance.codeWordBreak}
            disabled={!isReady}
            onValueChange={setCodeWordBreak}
          />
        </NativeSettingsSection>
      </NativeSettingsForm>
    </SettingsScreen>
  );
}
