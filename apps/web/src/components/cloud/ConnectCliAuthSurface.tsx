import { useAuth, useClerk } from "@clerk/react";
import type { ConnectAuthorizeRequest } from "@t3tools/shared/connectAuth";

import { openConnectCliSignIn } from "../../cloud/connectCliAuthorization";
import { AuthSurfaceShell } from "../auth/AuthSurfaceShell";
import { Button } from "../ui/button";

function ConnectCliAuthMessage({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <>
      {eyebrow ? (
        <p className="text-3xs font-semibold tracking-widest text-primary uppercase">{eyebrow}</p>
      ) : null}
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </>
  );
}

const invalidLinkMessage = {
  eyebrow: "Authorization request",
  title: "This connect link is incomplete",
  description:
    "The link is missing its authorization request. Re-run `t3 connect` in your terminal and open the freshly printed URL.",
} as const;

export function ConnectCliAuthorizeSurface({
  request,
}: {
  readonly request: ConnectAuthorizeRequest | null;
}) {
  const clerk = useClerk();
  const { isLoaded, isSignedIn } = useAuth();

  if (!request) {
    return (
      <AuthSurfaceShell>
        <ConnectCliAuthMessage {...invalidLinkMessage} />
      </AuthSurfaceShell>
    );
  }

  return (
    <AuthSurfaceShell>
      <ConnectCliAuthMessage
        eyebrow="Browser authorization"
        title="Connecting your terminal"
        description={
          isSignedIn
            ? "Redirecting to authorize T3 Connect for your CLI…"
            : "Sign in to continue authorizing T3 Connect for your CLI."
        }
      />
      {isLoaded && !isSignedIn ? (
        <div className="mt-6">
          <Button type="button" onClick={() => openConnectCliSignIn(clerk, request)}>
            Sign in
          </Button>
        </div>
      ) : null}
    </AuthSurfaceShell>
  );
}
