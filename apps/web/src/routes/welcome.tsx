import { createFileRoute, redirect, useLocation, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { NoProjectsHero } from "../components/NoProjectsHero";
import { WelcomeWizard } from "../components/onboarding/WelcomeWizard";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";

const decodeEnvironmentId = Schema.decodeOption(EnvironmentId);

// A provider sign-in redirect returns to `#agents:<environmentId>` to resume setup there.
function resumeEnvironmentIdFromHash(hash: string) {
  return hash.startsWith("agents:")
    ? Option.getOrUndefined(decodeEnvironmentId(hash.slice("agents:".length)))
    : undefined;
}

export const Route = createFileRoute("/welcome")({
  beforeLoad: ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  // Resuming lands straight on the agents step, so its provider states are re-probed here
  // the way entering that step from the wizard does.
  onEnter: () => {
    const environmentId = resumeEnvironmentIdFromHash(window.location.hash.slice(1));
    if (environmentId === undefined) return;
    void runAtomCommand(
      appAtomRegistry,
      serverEnvironment.refreshProviders,
      { environmentId, input: {} },
      { reportFailure: false },
    );
  },
  component: WelcomeRouteView,
});

function WelcomeRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();
  const hash = useLocation({ select: (location) => location.hash });
  const resumeEnvironmentId = resumeEnvironmentIdFromHash(hash);
  // The root can remount this pending outlet after navigation; do not reopen setup.
  const isWelcomeRoute = useLocation({ select: (location) => location.pathname === "/welcome" });
  const [dismissed, setDismissed] = useState(false);
  const openNewThread = useNewThreadHandler();
  const localAvailable = authGateState.status === "authenticated";
  return (
    <>
      <NoProjectsHero />
      {isWelcomeRoute && !dismissed ? (
        <WelcomeWizard
          localAvailable={localAvailable}
          resumeEnvironmentId={resumeEnvironmentId}
          onDone={async (projectRef) => {
            setDismissed(true);
            if (projectRef !== undefined) {
              await openNewThread(projectRef, { replace: true }).catch(() =>
                navigate({ to: "/", replace: true }),
              );
              return;
            }
            await navigate({ to: "/", replace: true });
          }}
        />
      ) : null}
    </>
  );
}
