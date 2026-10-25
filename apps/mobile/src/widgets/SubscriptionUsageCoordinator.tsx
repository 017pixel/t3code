import { Atom, AsyncResult } from "effect/reactivity";
import * as Linking from "expo-linking";
import { Appearance, Platform } from "react-native";

import {
  resolveThemeVariablesByAppearance,
  systemColorPalettesAtom,
} from "../features/settings/appearance/AppearancePreferencesProvider";
import { environmentCatalog } from "../connection/catalog";
import { normalizeMobileThemeMode, resolveMobileThemeIds } from "../lib/mobileTheme";
import { appAtomRegistry } from "../state/atom-registry";
import { mobilePreferencesAtom } from "../state/preferences";
import { environmentPresentations } from "../state/presentation";
import { publishSubscriptionUsage } from "./publishSubscriptionUsage";
import { installSubscriptionUsageRefresh } from "./useSubscriptionUsage";
import { buildSubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";
import { createWidgetTheme } from "./widgetTheme";

// Isolate quota changes from the much busier thread/config presentation stream.
const snapshotAtom = Atom.make((get) =>
  buildSubscriptionUsageSnapshot(
    get(environmentPresentations.presentationsWithProvidersAtom),
    Linking.createURL("settings/usage", { queryParams: { tab: "limits" } }),
    Platform.OS === "android" ? Infinity : 6,
  ),
).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

const systemColorSchemeAtom = Atom.make((get) => {
  const subscription = Appearance.addChangeListener(({ colorScheme }) =>
    get.setSelf(colorScheme ?? null),
  );
  get.addFinalizer(() => subscription.remove());
  return Appearance.getColorScheme() ?? null;
});

const widgetPayloadAtom = Atom.make((get) => {
  if (!get(environmentCatalog.catalogValueAtom).isReady) return null;
  const preferences = get(mobilePreferencesAtom);
  if (!AsyncResult.isSuccess(preferences)) return null;
  const themeMode = normalizeMobileThemeMode(preferences.value.themeMode);
  const themeIds = resolveMobileThemeIds(preferences.value);
  return {
    ...get(snapshotAtom),
    theme: createWidgetTheme(
      themeMode,
      resolveThemeVariablesByAppearance(
        { light: themeIds.light, dark: themeIds.dark },
        get(systemColorPalettesAtom),
      ),
    ),
    // Android stores resolved colors; System appearance changes must republish them.
    androidAppearance: Platform.OS === "android" ? get(systemColorSchemeAtom) : null,
  };
}).pipe(Atom.withEquality((a, b) => JSON.stringify(a) === JSON.stringify(b)));

/** App-lifetime: keeps the home-screen usage widget's quotas and theme current. */
export function installSubscriptionUsageWidget(): () => void {
  const stopRefresh = installSubscriptionUsageRefresh();
  const unsubscribe = appAtomRegistry.subscribe(
    widgetPayloadAtom,
    (payload) => {
      if (payload === null) return;
      const { androidAppearance: _androidAppearance, ...usage } = payload;
      void Promise.resolve()
        .then(() => publishSubscriptionUsage(usage))
        .catch((error: unknown) => {
          console.warn("Could not update subscription usage widget", error);
        });
    },
    { immediate: true },
  );
  return () => {
    stopRefresh();
    unsubscribe();
  };
}
