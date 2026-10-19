import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

export function providerInstanceInitials(label: string): string {
  const words = label.replace(/[_-]+/g, " ").split(/\s+/u).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return Array.from(words[0]!).slice(0, 2).join("").toUpperCase();
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0]?.toUpperCase() ?? "")
    .join("");
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

// Every entry keeps at least 4.5:1 contrast under the white badge text.
const AUTO_ACCENT_PALETTE = [
  "#6e40c9",
  "#1a73e8",
  "#0b7a5f",
  "#b45309",
  "#c2410c",
  "#be185d",
  "#0e7490",
  "#4d7c0f",
] as const;

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The default instance keeps the bare brand glyph, and registry agents draw
 * their own icons, so only custom instances that would otherwise be
 * indistinguishable from a sibling get an automatic color.
 */
export function resolveProviderInstanceAccentColor(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "accentColor">,
  siblings: Iterable<Pick<ServerProvider, "instanceId" | "driver">>,
): string | undefined {
  const explicit = normalizeProviderAccentColor(snapshot.accentColor);
  if (explicit) return explicit;
  if (snapshot.driver === "acpRegistry") return undefined;
  if (snapshot.instanceId === defaultInstanceIdForDriver(snapshot.driver)) return undefined;
  for (const sibling of siblings) {
    if (sibling.driver === snapshot.driver && sibling.instanceId !== snapshot.instanceId) {
      return AUTO_ACCENT_PALETTE[fnv1a(snapshot.instanceId) % AUTO_ACCENT_PALETTE.length];
    }
  }
  return undefined;
}

export function shouldShowInstanceBadge(
  entry: {
    readonly driverKind: ProviderDriverKind;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
  },
  entries: Iterable<{
    readonly driverKind: ProviderDriverKind;
    readonly acpRegistryAgentId?: string | undefined;
  }>,
): boolean {
  if (entry.accentColor) return true;
  let sharedProviderCount = 0;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    if (++sharedProviderCount > 1) return true;
  }
  return false;
}
