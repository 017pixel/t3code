import type { AuthSessionState } from "@t3tools/contracts";
import { Suspense, use, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { submitServerAuthCredential } from "../../environments/primary";
import type { HostedPairingRequest } from "../../hostedPairing";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";
import {
  type AutoPairing,
  connectHostedPairing,
  enterAppAfterPairing,
  type HostedPairingAttempt,
  type HostedPairingOutcome,
  pairingErrorMessage,
} from "./pairingRouteEntry";

export function PairingPendingSurface() {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pairing with this environment"
        description="Validating the pairing link and preparing your session."
      />
    </StandalonePage>
  );
}

export function PairingRouteSurface({
  auth,
  autoPairing,
  initialErrorMessage,
}: {
  auth: AuthSessionState["auth"];
  autoPairing: AutoPairing | null;
  initialErrorMessage?: string;
}) {
  if (!autoPairing) {
    return <PairingForm auth={auth} initialErrorMessage={initialErrorMessage ?? ""} />;
  }

  return (
    <Suspense
      fallback={
        <PairingFormView
          auth={auth}
          credential={autoPairing.credential}
          errorMessage=""
          isSubmitting
          onCredentialChange={() => {}}
          onSubmit={() => {}}
        />
      }
    >
      <AutoPairingFailure auth={auth} autoPairing={autoPairing} />
    </Suspense>
  );
}

function AutoPairingFailure({
  auth,
  autoPairing,
}: {
  auth: AuthSessionState["auth"];
  autoPairing: AutoPairing;
}) {
  return (
    <PairingForm
      auth={auth}
      initialCredential={autoPairing.credential}
      initialErrorMessage={use(autoPairing.failure)}
    />
  );
}

function PairingForm({
  auth,
  initialCredential = "",
  initialErrorMessage,
}: {
  auth: AuthSessionState["auth"];
  initialCredential?: string;
  initialErrorMessage: string;
}) {
  const [credential, setCredential] = useState(initialCredential);
  const [errorMessage, setErrorMessage] = useState(initialErrorMessage);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submitCredential = async () => {
    setIsSubmitting(true);
    setErrorMessage("");

    const submitError = await submitServerAuthCredential(credential).then(
      () => null,
      pairingErrorMessage,
    );

    if (submitError === null) {
      enterAppAfterPairing();
      return;
    }

    setIsSubmitting(false);
    setErrorMessage(submitError);
  };

  return (
    <PairingFormView
      auth={auth}
      credential={credential}
      errorMessage={errorMessage}
      isSubmitting={isSubmitting}
      onCredentialChange={setCredential}
      onSubmit={() => void submitCredential()}
    />
  );
}

function PairingFormView({
  auth,
  credential,
  errorMessage,
  isSubmitting,
  onCredentialChange,
  onSubmit,
}: {
  auth: AuthSessionState["auth"];
  credential: string;
  errorMessage: string;
  isSubmitting: boolean;
  onCredentialChange: (credential: string) => void;
  onSubmit: () => void;
}) {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Pair with this environment"
        description={describeAuthGate(auth.bootstrapMethods)}
      />

      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="pairing-token">
            Pairing token
          </label>
          <Input
            id="pairing-token"
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect="off"
            disabled={isSubmitting}
            nativeInput
            onChange={(event) => onCredentialChange(event.currentTarget.value)}
            placeholder="Paste a one-time token or pairing secret"
            spellCheck={false}
            value={credential}
          />
        </div>

        {errorMessage ? (
          <Alert variant="error">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button disabled={isSubmitting} size="sm" type="submit">
            {isSubmitting ? "Pairing..." : "Continue"}
          </Button>
          <Button
            disabled={isSubmitting}
            onClick={() => window.location.reload()}
            size="sm"
            variant="outline"
          >
            Reload app
          </Button>
        </div>
      </form>

      <div className="mt-6 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
        {describeSupportedMethods(auth.bootstrapMethods)}
      </div>
    </StandalonePage>
  );
}

const MISSING_HOSTED_REQUEST = "This pairing link is missing its backend host or token.";

export function HostedPairingRouteSurface({ attempt }: { attempt: HostedPairingAttempt | null }) {
  const [outcome, setOutcome] = useState(attempt?.outcome ?? null);

  if (!attempt || !outcome) {
    return <HostedPairingView status="error" message={MISSING_HOSTED_REQUEST} />;
  }

  const { request } = attempt;
  return (
    <Suspense
      fallback={
        <HostedPairingView
          status="pairing"
          message="Connecting to this backend."
          host={request.host}
        />
      }
    >
      <HostedPairingResult
        outcome={outcome}
        request={request}
        onRetry={() => setOutcome(connectHostedPairing(request))}
      />
    </Suspense>
  );
}

function HostedPairingResult({
  outcome,
  request,
  onRetry,
}: {
  outcome: Promise<HostedPairingOutcome>;
  request: HostedPairingRequest;
  onRetry: () => void;
}) {
  const result = use(outcome);
  if (result.status === "paired") {
    return (
      <HostedPairingView
        status="paired"
        message={`${request.label || "The environment"} is saved in this browser.`}
        host={request.host}
      />
    );
  }
  return (
    <HostedPairingView
      status="error"
      message={result.message}
      host={request.host}
      onRetry={onRetry}
    />
  );
}

function HostedPairingView({
  status,
  message,
  host,
  onRetry,
}: {
  status: "pairing" | "paired" | "error";
  message: string;
  host?: string;
  onRetry?: () => void;
}) {
  return (
    <StandalonePage tone="pairing">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title={
          status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"
        }
        description={message}
      />

      {host ? (
        <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
          Host: <span className="font-mono text-foreground/80">{host}</span>
        </div>
      ) : null}

      {status === "error" ? (
        <Alert variant="error" className="mt-5">
          <AlertDescription>
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-2">
        {status === "pairing" ? (
          <Button disabled size="sm">
            Pairing...
          </Button>
        ) : onRetry ? (
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
        {status === "paired" ? (
          <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
            Open app
          </Button>
        ) : null}
      </div>
    </StandalonePage>
  );
}

function describeAuthGate(bootstrapMethods: ReadonlyArray<string>): string {
  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment expects a trusted pairing credential before the app can connect.";
  }

  return "Enter a pairing token to start a session with this environment.";
}

function describeSupportedMethods(bootstrapMethods: ReadonlyArray<string>): string {
  if (
    bootstrapMethods.includes("desktop-bootstrap") &&
    bootstrapMethods.includes("one-time-token")
  ) {
    return "Desktop-managed pairing and one-time pairing tokens are both accepted for this environment.";
  }

  if (bootstrapMethods.includes("desktop-bootstrap")) {
    return "This environment is desktop-managed. Open it from the desktop app or paste a bootstrap credential if one was issued explicitly.";
  }

  return "This environment accepts one-time pairing tokens. Pairing links can open this page directly, or you can paste the token here.";
}
