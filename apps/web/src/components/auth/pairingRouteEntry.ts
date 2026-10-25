import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { connectPairing } from "../../connection/onboarding";
import { isElectron } from "../../env";
import {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { type HostedPairingRequest, readHostedPairingRequest } from "../../hostedPairing";
import { appAtomRegistry } from "../../rpc/atomRegistry";

export interface AutoPairing {
  readonly credential: string;
  /** The error to show; never settles on success, because the document reloads. */
  readonly failure: Promise<string>;
}

export type HostedPairingOutcome =
  | { readonly status: "paired" }
  | { readonly status: "failed"; readonly message: string };

export interface HostedPairingAttempt {
  readonly request: HostedPairingRequest;
  readonly outcome: Promise<HostedPairingOutcome>;
}

// Stripping the one-time token from the address makes the router load /pair again. That load
// finds no token, so the attempt the first load started lives here until the route is left.
let autoPairing: AutoPairing | null = null;
let hostedPairing: HostedPairingAttempt | null = null;

/**
 * Reloads into the app so the primary connection's WebSocket and cached scopes use the newly
 * issued cookie. Electron routes through the hash, and dropping it entirely forces a real load.
 */
export function enterAppAfterPairing(): void {
  window.location.replace(
    isElectron ? `${window.location.pathname}${window.location.search}` : "/",
  );
}

/** Submits a pairing link's one-time token once per link. */
export function enterPairRoute(): AutoPairing | null {
  const credential = peekPairingTokenFromUrl();
  if (credential) {
    autoPairing = {
      credential,
      failure: submitServerAuthCredential(credential).then(() => {
        enterAppAfterPairing();
        return new Promise<never>(() => {});
      }, pairingErrorMessage),
    };
    stripPairingTokenFromUrl();
  }
  return autoPairing;
}

export function enterHostedPairRoute(): HostedPairingAttempt | null {
  const request = readHostedPairingRequest();
  if (request) {
    hostedPairing = { request, outcome: connectHostedPairing(request) };
    stripPairingTokenFromUrl();
  }
  return hostedPairing;
}

/** Keeps the root gate on hosted pairing after the token has left the address. */
export function hasHostedPairingAttempt(): boolean {
  return hostedPairing !== null;
}

export function leavePairRoute(): void {
  autoPairing = null;
  hostedPairing = null;
}

export async function connectHostedPairing(
  request: HostedPairingRequest,
): Promise<HostedPairingOutcome> {
  const result = await runAtomCommand(
    appAtomRegistry,
    connectPairing,
    { host: request.host, pairingCode: request.token },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    return { status: "paired" };
  }
  return {
    status: "failed",
    message: `${pairingErrorMessage(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
  };
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}
