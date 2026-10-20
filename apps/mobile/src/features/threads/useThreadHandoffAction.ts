import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useLayoutEffect, useMemo, useRef } from "react";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadHandoffEnvironment } from "../../state/threadHandoff";

const unavailable = Atom.make(false);
export function useThreadHandoffAction(
  ref: ScopedThreadRef | null,
  navigate: (ref: ScopedThreadRef) => void,
) {
  const key = ref ? `${ref.environmentId}:${ref.threadId}` : "";
  const token = useMemo(() => ({ key }), [key]);
  const identity = useRef<typeof token | null>(null);
  useLayoutEffect(() => {
    identity.current = token;
    return () => {
      identity.current = null;
    };
  }, [token]);
  const available = useAtomValue(ref ? threadHandoffEnvironment.availableAtom(ref) : unavailable);
  return {
    available,
    open: () => {
      if (
        ref &&
        identity.current === token &&
        appAtomRegistry.get(threadHandoffEnvironment.availableAtom(ref))
      )
        navigate(ref);
    },
  };
}
