import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OtlpEndpointCheckResult,
  OtlpSignal,
  ServerObservability,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const SIGNALS = [
  {
    key: "otlpTracesUrl",
    sourceKey: "otlpTracesSource",
    variableKey: "otlpTracesVariable",
    label: "Traces",
    signal: "traces",
  },
  {
    key: "otlpMetricsUrl",
    sourceKey: "otlpMetricsSource",
    variableKey: "otlpMetricsVariable",
    label: "Metrics",
    signal: "metrics",
  },
  {
    key: "otlpLogsUrl",
    sourceKey: "otlpLogsSource",
    variableKey: "otlpLogsVariable",
    label: "Logs",
    signal: "logs",
  },
] as const;

type SignalDescriptor = (typeof SIGNALS)[number];
type SignalKey = SignalDescriptor["key"];

const OVERRIDE_LABELS = { environment: "Set by environment", bootstrap: "Set by desktop" } as const;

function runningOverride(
  running: ServerObservability | undefined,
  { key, sourceKey, variableKey }: SignalDescriptor,
) {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (url === undefined || (source !== "environment" && source !== "bootstrap")) return undefined;
  return { url, label: OVERRIDE_LABELS[source], variable: running?.[variableKey] };
}

// `null` while the check runs; "failed" when the request itself failed, so a failed manual test
// keeps hiding the opening check for that signal.
type EndpointCheck = {
  readonly url: string;
  readonly result: OtlpEndpointCheckResult | null | "failed";
};

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

type EndpointChecks = Partial<Record<SignalKey, EndpointCheck>>;
type OpeningCheckTarget = { readonly environmentId: EnvironmentId } & Record<SignalKey, string>;

// Plain-object keys compare structurally (Effect `Equal`/`Hash`).
// The endpoints a form opens with are checked once it may check them. The atom lives while the
// form reads it, so reopening the settings checks again.
const openingEndpointChecksAtom = Atom.family((target: OpeningCheckTarget) =>
  Atom.make((get): EndpointChecks => {
    const pending: EndpointChecks = {};
    for (const { key, signal } of SIGNALS) {
      const url = target[key];
      if (!isHttpUrl(url)) continue;
      pending[key] = { url, result: null };
      void runAtomCommand(get.registry, serverEnvironment.checkOtlpEndpoint, {
        environmentId: target.environmentId,
        input: { signal, url },
      }).then((response) => {
        const current = Option.getOrElse(get.self<EndpointChecks>(), () => pending);
        const next = { ...current };
        next[key] = { url, result: response._tag === "Success" ? response.value : "failed" };
        get.setSelf(next);
      });
    }
    return pending;
  }),
);
const NO_OPENING_CHECKS_ATOM = Atom.make<EndpointChecks>({});

function endpointStatus(url: string, check: EndpointCheck | undefined) {
  if (url === "") return { label: "Off", dot: "bg-muted-foreground/40" };
  if (check?.url !== url || check.result === "failed") {
    return { label: "Not checked", dot: "bg-muted-foreground/40" };
  }
  const { result } = check;
  if (result === null) return { label: "Checking…", dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return { label: `Connected · ${Math.round(result.latencyMs)} ms`, dot: "bg-success" };
    case "Rejected":
      return { label: `Rejected · HTTP ${result.status}`, dot: "bg-destructive" };
    case "Unreachable":
      return { label: result.timedOut ? "Timed out" : "Unreachable", dot: "bg-destructive" };
  }
}

export function TelemetryExportSettings() {
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title="OpenTelemetry export" id="telemetry-export">
        <SettingsScopeNotice target="environment">
          Choose one environment to configure its telemetry exports.
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = environment?.environmentId;
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  const running = environment?.serverConfig?.observability;
  const openingUrl = (descriptor: SignalDescriptor) =>
    runningOverride(running, descriptor)?.url ?? saved[descriptor.key];
  const [openingCheckTarget] = useState<OpeningCheckTarget | null>(() =>
    environmentId === undefined
      ? null
      : {
          environmentId,
          otlpTracesUrl: openingUrl(SIGNALS[0]),
          otlpMetricsUrl: openingUrl(SIGNALS[1]),
          otlpLogsUrl: openingUrl(SIGNALS[2]),
        },
  );
  const openingChecks = useAtomValue(
    canCheck && openingCheckTarget !== null
      ? openingEndpointChecksAtom(openingCheckTarget)
      : NO_OPENING_CHECKS_ATOM,
  );
  // A manual test replaces the opening check for that signal.
  const [manualChecks, setChecks] = useState<EndpointChecks>({});
  const checks: EndpointChecks = { ...openingChecks, ...manualChecks };
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };
  const changedSignals = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);
  const changed = changedSignals.length > 0;

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!environmentId) return;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    setChecks((previous) => {
      if (previous[key]?.url !== url || previous[key].result !== null) return previous;
      return {
        ...previous,
        [key]: { url, result: response._tag === "Success" ? response.value : "failed" },
      };
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!isHttpUrl(url)) return;
    setChecks((previous) => ({ ...previous, [key]: { url, result: null } }));
    void sendCheck(key, signal, url);
  };

  return (
    <SettingsSection title="OpenTelemetry export" id="telemetry-export">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={async (event) => {
          event.preventDefault();
          if (!environment || saving) return;
          setSaving(true);
          setMessage(null);
          const result = await updateSettings({
            environmentId: environment.environmentId,
            input: {
              patch: {
                observability: Object.fromEntries(
                  changedSignals.map(({ key }) => [key, values[key]]),
                ),
              },
            },
          });
          setSaving(false);
          if (result._tag === "Success") {
            setDraft({});
            setMessage("Saved. Restart the server to apply.");
          }
        }}
      >
        <p className="text-xs text-muted-foreground">
          Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply.
          Environment variables override these settings.
        </p>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            This connection lacks permission to change settings on{" "}
            {environment?.label ?? "the selected environment"}.
          </p>
        )}
        {SIGNALS.map((descriptor) => {
          const { key, label, signal } = descriptor;
          const override = runningOverride(running, descriptor);
          const url = override?.url ?? values[key].trim();
          const check = canCheck ? endpointStatus(url, checks[key]) : null;
          const status = override
            ? {
                label: check ? `${override.label} · ${check.label}` : override.label,
                dot: check?.dot ?? "bg-muted-foreground/40",
              }
            : check;
          return (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {status && <ConnectionStatusDot dotClassName={status.dot} />}
                  <Label htmlFor={key}>{label} endpoint</Label>
                </div>
                {status && <span className="text-xs text-muted-foreground">{status.label}</span>}
              </div>
              <div className="flex gap-2">
                <Input
                  id={key}
                  size="sm"
                  type="url"
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                  title="Enter an HTTP or HTTPS endpoint, or leave empty to disable export."
                  placeholder={`http://localhost:4318/v1/${signal}`}
                  value={values[key]}
                  disabled={saving || !canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Clear restored drafts so later saves cannot overwrite another client's changes.
                    setDraft((previous) => {
                      const next = { ...previous, [key]: value };
                      if (value.trim() === saved[key]) delete next[key];
                      return next;
                    });
                    setMessage(null);
                  }}
                />
                {canCheck && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!isHttpUrl(url) || checks[key]?.result === null}
                    onClick={() => void checkEndpoint(key, signal, url)}
                  >
                    Test
                  </Button>
                )}
              </div>
              {(saved[key] !== (running?.[key] ?? "") || override?.variable) && (
                <p className="break-all text-xs text-muted-foreground">
                  Running: {running?.[key] || "Disabled"}
                  {override?.variable && (
                    <>
                      {" "}
                      from <code className="font-mono">{override.variable}</code>
                    </>
                  )}
                </p>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3">
          <p role="status" className="text-xs text-muted-foreground">
            {message}
          </p>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!changed || saving || !canEdit}
              onClick={() => {
                setDraft({});
                setMessage(null);
                if (!canCheck) return;
                for (const descriptor of SIGNALS) {
                  const { key, signal } = descriptor;
                  if (runningOverride(running, descriptor)) continue;
                  const check = checks[key];
                  if (check?.url !== saved[key] || check.result === "failed")
                    checkEndpoint(key, signal, saved[key]);
                }
              }}
            >
              Discard
            </Button>
            <Button type="submit" size="xs" disabled={!changed || saving || !canEdit}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </SettingsSection>
  );
}
