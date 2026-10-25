import {
  type LinkedPrompt,
  parseNewThreadLink,
  parseThreadLinkPrompt,
  promptLinkAppPath,
  promptLinkDeepLink,
} from "@t3tools/shared/promptLinks";
import { type ParsedLocation, useLocation } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { type ReactNode, useState, useSyncExternalStore } from "react";

import { APP_DISPLAY_NAME, DESKTOP_DOWNLOAD_URL } from "~/branding";
import { getLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { environmentCatalog } from "~/connection/catalog";
import { isHostedStaticApp } from "~/hostedPairing";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironments } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";

import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { StandalonePage, StandalonePageHeader } from "../ui/standalone-page";

const OPENER_STORAGE_KEY = "t3code:prompt-link-opener";
const Opener = Schema.NullOr(Schema.Literals(["app", "browser"]));

interface LinkSummary {
  readonly prompt: LinkedPrompt | null;
  readonly details: ReadonlyArray<string>;
}

function summarize(
  appPath: string,
): { ok: true; value: LinkSummary } | { ok: false; error: string } {
  const url = new URL(appPath, window.location.origin);
  if (url.pathname !== "/new") {
    const prompt = parseThreadLinkPrompt(url.search);
    return prompt.ok
      ? { ok: true, value: { prompt: prompt.value, details: ["Opens one of your threads."] } }
      : prompt;
  }
  const link = parseNewThreadLink(url.search);
  if (!link.ok) return link;
  if (link.value.kind === "pull-request") {
    const { owner, name, number } = link.value.pullRequest;
    return {
      ok: true,
      value: { prompt: link.value.prompt, details: [`Pull request ${owner}/${name}#${number}`] },
    };
  }
  const { repository, provider, model } = link.value;
  return {
    ok: true,
    value: {
      prompt: link.value.prompt,
      details: [
        repository ? `Repository ${repository.owner}/${repository.name}` : "No project",
        ...(provider ? [`Model ${model ? `${provider} ${model}` : provider}`] : []),
      ],
    },
  };
}

const autoOpenedLocationKeys = new Set<string>();

/**
 * A remembered "open in app" choice hands each prompt link to the app as soon as the hosted app
 * resolves it; the landing page still shows behind it in case the app is not installed.
 */
export function openRememberedPromptLinkInApp(location: ParsedLocation): void {
  if (!isHostedStaticApp() || getLocalStorageItem(OPENER_STORAGE_KEY, Opener) !== "app") return;
  const appPath = promptLinkAppPath(
    new URL(location.href, window.location.origin).href,
    window.location.origin,
  );
  if (appPath === null || !summarize(appPath).ok) return;
  const locationKey = location.state.__TSR_key ?? location.href;
  if (autoOpenedLocationKeys.has(locationKey)) return;
  autoOpenedLocationKeys.add(locationKey);
  window.location.href = promptLinkDeepLink(appPath);
}

export type HostedPromptLinkLandingView =
  | { readonly kind: "none" }
  | { readonly kind: "waiting" }
  | { readonly kind: "page"; readonly appPath: string; readonly canContinue: boolean };

/** Whether the hosted app holds a prompt link on its landing page instead of opening it. */
export function resolveHostedPromptLinkLanding(input: {
  readonly appPath: string | null;
  readonly href: string;
  readonly continuedHref: string | null;
  readonly opener: "app" | "browser" | null;
  readonly environmentsReady: boolean;
  readonly environmentCount: number;
}): HostedPromptLinkLandingView {
  if (input.appPath === null || input.continuedHref === input.href) return { kind: "none" };
  const canContinue = input.environmentsReady && input.environmentCount > 0;
  if (input.opener === "browser") {
    if (canContinue) return { kind: "none" };
    if (!input.environmentsReady) return { kind: "waiting" };
  }
  return { kind: "page", appPath: input.appPath, canContinue };
}

// The root route outlives every landing, so "Continue here" holds for the rest of the session.
let continuedHref: string | null = null;
const continuedHrefListeners = new Set<() => void>();

function subscribeContinuedHref(listener: () => void): () => void {
  continuedHrefListeners.add(listener);
  return () => {
    continuedHrefListeners.delete(listener);
  };
}

const getContinuedHref = () => continuedHref;

function continueHere(href: string): void {
  continuedHref = href;
  for (const listener of continuedHrefListeners) listener();
}

function hostedAppPath(enabled: boolean, href: string): string | null {
  return enabled && isHostedStaticApp()
    ? promptLinkAppPath(new URL(href, window.location.origin).href, window.location.origin)
    : null;
}

/** For route services: true while the landing (or its wait for environments) covers `href`. */
export function isHostedPromptLinkLandingShowing(enabled: boolean, href: string): boolean {
  return (
    resolveHostedPromptLinkLanding({
      appPath: hostedAppPath(enabled, href),
      href,
      continuedHref,
      opener: getLocalStorageItem(OPENER_STORAGE_KEY, Opener),
      environmentsReady: appAtomRegistry.get(environmentCatalog.catalogValueAtom).isReady,
      environmentCount: appAtomRegistry.get(environmentPresentations.presentationsAtom).size,
    }).kind !== "none"
  );
}

/** Notifies when the inputs of isHostedPromptLinkLandingShowing other than the route change. */
export function subscribeHostedPromptLinkLanding(listener: () => void): () => void {
  const unsubscribers = [
    subscribeContinuedHref(listener),
    appAtomRegistry.subscribe(environmentCatalog.catalogValueAtom, listener),
    appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, listener),
  ];
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

export function useHostedPromptLinkLanding(enabled: boolean): ReactNode | null {
  const href = useLocation({ select: (location) => location.href });
  const { environments, isReady } = useEnvironments();
  const [opener, setOpener] = useLocalStorage(OPENER_STORAGE_KEY, null, Opener);
  const continued = useSyncExternalStore(
    subscribeContinuedHref,
    getContinuedHref,
    getContinuedHref,
  );
  const view = resolveHostedPromptLinkLanding({
    appPath: hostedAppPath(enabled, href),
    href,
    continuedHref: continued,
    opener,
    environmentsReady: isReady,
    environmentCount: environments.length,
  });
  if (view.kind === "none") return null;
  if (view.kind === "waiting") return <></>;
  return (
    <HostedPromptLinkLanding
      appPath={view.appPath}
      canContinue={view.canContinue}
      onChoose={(choice, remember) => {
        if (remember) setOpener(choice);
        if (choice === "browser") continueHere(href);
      }}
    />
  );
}

function HostedPromptLinkLanding({
  appPath,
  canContinue,
  onChoose,
}: {
  readonly appPath: string;
  readonly canContinue: boolean;
  readonly onChoose: (choice: "app" | "browser", remember: boolean) => void;
}) {
  const summary = summarize(appPath);
  const [remember, setRemember] = useState(false);
  const deepLink = promptLinkDeepLink(appPath);
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  if (!summary.ok) {
    return (
      <StandalonePage tone="error">
        <StandalonePageHeader
          eyebrow={APP_DISPLAY_NAME}
          title="Could not open the link"
          description={summary.error}
        />
      </StandalonePage>
    );
  }

  const { prompt, details } = summary.value;
  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Open this prompt"
        description="It opens as a draft. Nothing runs until you press Send."
      />
      {prompt !== null && prompt.hiddenCharacters > 0 ? (
        <Alert className="mt-5" variant="error">
          <AlertTitle>This prompt had hidden characters, it may be malicious</AlertTitle>
          <AlertDescription>
            T3 Code removed {prompt.hiddenCharacters} hidden character
            {prompt.hiddenCharacters === 1 ? "" : "s"}. Read the prompt before you send it.
          </AlertDescription>
        </Alert>
      ) : null}
      {prompt !== null ? (
        <pre className="mt-5 max-h-72 overflow-auto rounded-lg border border-border bg-background p-3 text-sm whitespace-pre-wrap">
          {prompt.text}
        </pre>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">{details.join(" · ")}</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button render={<a href={deepLink} />} onClick={() => onChoose("app", remember)}>
          {onPhone ? "Open in app" : "Open in desktop app"}
        </Button>
        {canContinue ? (
          <Button variant="outline" onClick={() => onChoose("browser", remember)}>
            Continue here
          </Button>
        ) : null}
        <Button variant="ghost" render={<a href={DESKTOP_DOWNLOAD_URL} />}>
          Get T3 Code
        </Button>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
        <Checkbox checked={remember} onCheckedChange={(checked) => setRemember(checked === true)} />
        Remember my choice
      </label>
    </StandalonePage>
  );
}
