import {
  Outlet,
  Link,
  redirect,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useRouter,
} from "@tanstack/react-router";
import { Check, Copy } from "lucide";

import { APP_DISPLAY_NAME, APP_VERSION } from "../branding";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { CommandPalette } from "../components/CommandPalette";
import { CustomSnoozeDialogHost } from "../components/CustomSnoozeDialog";
import { GuestShareDialogHost } from "../components/chat/GuestShareControls";
import { AddProjectToMachineDialogHost } from "../components/AddProjectToMachineDialog";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { FirstRunGate } from "../components/onboarding/FirstRunGate";
import { setFirstRunGateMode } from "../components/onboarding/firstRunGateStore";
import { ConnectOnboardingDialog } from "../components/cloud/ConnectOnboardingDialog";
import { RelayClientInstallDialog } from "../components/cloud/RelayClientInstallDialog";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { RunningThreadKeepAlive } from "../components/desktop/RunningThreadKeepAlive";
import { ChatGptWelcomeCoordinator } from "../components/settings/ChatGptWelcomeCoordinator";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { Button } from "../components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";
import { AnchoredToastProvider, ToastProvider } from "../components/ui/toast";
import { isElectron } from "../env";
import { cn } from "../lib/utils";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { GUEST_PAGE_PATH } from "../guestPage";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import {
  openRememberedPromptLinkInApp,
  useHostedPromptLinkLanding,
} from "../components/promptLinks/HostedPromptLinkLanding";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { hasHostedPairingAttempt } from "../components/auth/pairingRouteEntry";

import { getDesktopSnapShotBridge } from "../lib/desktopSnapShot";
import { shouldResumeSnapShotSetupOnStartup } from "../lib/snapShotSetupResume";
import { SnapShotCoordinator } from "../components/desktop/SnapShotCoordinator";

export const Route = createRootRoute({
  beforeLoad: async ({ location, preload }) => {
    // Guest links open on the owner's tunnel host in a browser with no T3 session, and must
    // not trigger pairing or an environment connection.
    if (location.pathname === GUEST_PAGE_PATH) {
      setFirstRunGateMode("off");
      return {
        authGateState: {
          status: "guest",
        } as const,
      };
    }

    if (
      location.pathname === "/pair" &&
      (hasHostedPairingRequest(new URL(window.location.href)) || hasHostedPairingAttempt())
    ) {
      setFirstRunGateMode("off");
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isLocalEnvironmentDisabled() || isHostedStaticApp(new URL(window.location.href))) {
      setFirstRunGateMode("hosted-static");
      if (!preload) openRememberedPromptLinkInApp(location);
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    setFirstRunGateMode(authGateState.status === "authenticated" ? "authenticated" : "off");
    if (authGateState.status === "authenticated") {
      // Idempotent, so every navigation can ask for it.
      void configureClientTracing();
    }
    if (
      authGateState.status === "authenticated" &&
      getDesktopSnapShotBridge() &&
      shouldResumeSnapShotSetupOnStartup() &&
      location.pathname !== "/settings/snap-shot"
    ) {
      throw redirect({ to: "/settings/snap-shot", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  notFoundComponent: RootRouteNotFoundView,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function RootRouteNotFoundView() {
  return (
    <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-medium text-foreground">Page not found</h1>
        <p className="text-sm text-muted-foreground">
          This link doesn't point to a page in {APP_DISPLAY_NAME}. Go home to choose a project or
          start a thread.
        </p>
        <Button render={<Link to="/" replace />}>Go home</Button>
      </div>
    </main>
  );
}

function RootRouteView() {
  // Above every branch: app services raise toasts for the whole session, and a toast shown on the
  // shell must survive a detour through /pair or a landing page.
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <RootRouteBranch />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function RootRouteBranch() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { authGateState } = Route.useRouteContext();
  const hostedPromptLinkLanding = useHostedPromptLinkLanding(
    authGateState.status === "hosted-static",
  );

  if (pathname === GUEST_PAGE_PATH) return <Outlet />;

  if (pathname === "/pair" || pathname === "/connect" || pathname === "/connect-agent") {
    return <Outlet />;
  }

  // Handle links before onboarding redirects lose them.
  if (hostedPromptLinkLanding !== null) {
    return hostedPromptLinkLanding;
  }

  if (pathname === "/welcome") {
    return (
      <>
        <CustomSnoozeDialogHost />
        <GuestShareDialogHost />
        <CommandPalette>
          <AppSidebarLayout>
            <Outlet />
          </AppSidebarLayout>
        </CommandPalette>
      </>
    );
  }

  if (authGateState.status !== "authenticated" && authGateState.status !== "hosted-static") {
    return <Outlet />;
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <>
      <ChatGptWelcomeCoordinator />
      <FirstRunGate>
        {isElectron ? <RunningThreadKeepAlive /> : null}
        <RelayClientInstallDialog />
        <ConnectOnboardingDialog />
        <SshPasswordPromptDialog />
        {/* Compat shim until the web-chat-view layer starts it from appInit. */}
        <SnapShotCoordinator />
        <ConfirmDialogHost />
        <CustomSnoozeDialogHost />
        <GuestShareDialogHost />
        <AddProjectToMachineDialogHost />
        {appShell}
        {/* Keep the theme editor above the router so drafts survive navigation. */}
        <ThemeEditorHost />
      </FirstRunGate>
    </>
  );
}

function RootRouteErrorView({ error }: ErrorComponentProps) {
  const router = useRouter();
  const message = errorMessage(error);
  // Router pathname rather than window.location: desktop uses hash history, where the window path is always "/".
  const pathname = useLocation({ select: (location) => location.pathname });
  const report = errorReport(error, pathname);

  return (
    <StandalonePage tone="error">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Something went wrong."
        description={message}
      />

      <div className="mt-5 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => void router.invalidate()}>
          Try again
        </Button>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          Reload app
        </Button>
        <CopyErrorButton report={report} />
      </div>

      <div className="mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
        <p className="px-3 py-1.5 text-xs font-medium text-muted-foreground">Error report</p>
        <pre className="max-h-64 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs whitespace-pre-wrap text-foreground/85">
          {report}
        </pre>
      </div>
    </StandalonePage>
  );
}

function CopyErrorButton({ report }: { report: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-report" });

  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(report)}>
      <MorphIcon className={cn(isCopied && "text-success")} icon={isCopied ? Check : Copy} />
      {isCopied ? "Copied" : "Copy error"}
    </Button>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

const MAX_ERROR_CAUSE_DEPTH = 5;

// Use only pathname to keep query tokens off the clipboard.
function errorReport(error: unknown, pathname: string): string {
  const lines = [
    `${APP_DISPLAY_NAME} ${APP_VERSION}`,
    `Path: ${pathname}`,
    `Time: ${new Date().toISOString()}`,
    "",
    errorDetails(error),
  ];
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorDetails(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
