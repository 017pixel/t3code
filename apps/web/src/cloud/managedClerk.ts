import type { useClerk } from "@clerk/react";

export type ManagedClerk = ReturnType<typeof useClerk>;

let publish: (clerk: ManagedClerk) => void = () => undefined;
const managedClerk = new Promise<ManagedClerk>((resolve) => {
  publish = resolve;
});

/** Called by ManagedRelayAuthProvider, the first place the instance exists. */
export function publishManagedClerk(clerk: ManagedClerk): void {
  publish(clerk);
}

/**
 * Resolves with the Clerk instance once ClerkProvider renders, for code that
 * runs outside React (route hooks). Type-only Clerk import: route files stay
 * free of Clerk bytes, and in cloudless mode this simply never resolves.
 */
export function whenManagedClerk(): Promise<ManagedClerk> {
  return managedClerk;
}
