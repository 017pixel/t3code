import * as Schema from "effect/Schema";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Accounts that opted out of the post-sign-in T3 Connect onboarding wizard
 * ("Don't show this again"). The wizard otherwise shows on every sign-in,
 * since sign-out clears the connected environments.
 */
export const CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY = "t3code:connect-onboarding-opt-out:v1";

export const ConnectOnboardingOptOutSchema = Schema.Struct({
  optOutAccounts: Schema.Array(Schema.String),
});

export type ConnectOnboardingOptOutState = typeof ConnectOnboardingOptOutSchema.Type;

export const EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE: ConnectOnboardingOptOutState = {
  optOutAccounts: [],
};

/** Lets startup observe sign-ins without importing Clerk. */
export interface ManagedAccountState {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly userId: string | null | undefined;
}

export const ManagedAccountContext = createContext<ManagedAccountState | null>(null);

// Observe outside the lazy wizard so sign-ins during its load aren't lost.
// A restored session must not re-prompt; account switches clear relay connections.
export function useConnectOnboardingRequest() {
  const account = useContext(ManagedAccountContext);
  const isLoaded = account?.isLoaded ?? false;
  const isSignedIn = account?.isSignedIn;
  const userId = account?.userId;
  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!isLoaded) return;
    // An incomplete signed-in snapshot must not look like a fresh sign-in later.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount !== undefined && previousAccount !== nextAccount && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  const clearRequestedAccount = useCallback(() => setRequestedAccount(null), []);
  return { requestedAccount, clearRequestedAccount };
}

export type ConnectOnboardingRequest = ReturnType<typeof useConnectOnboardingRequest>;
