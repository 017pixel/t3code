"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Button } from "../ui/button";
import { Popover, PopoverClose, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { normalizeProviderAccentColor } from "../../providerInstances";

const FALLBACK_ACCENT_COLOR = "#2563eb";

function ProviderCustomColorPanel(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
}) {
  const { onCommit } = props;
  const [hsv, setHsv] = useState(() => hexToHsv(props.value));
  const currentColor = hsvToHex(hsv.h, hsv.s, hsv.v);
  const [hexDraft, setHexDraft] = useState<string | null>(null);

  const commitHsv = (nextHsv: HsvColor) => {
    setHsv(nextHsv);
    onCommit(hsvToHex(nextHsv.h, nextHsv.s, nextHsv.v));
  };

  return (
    <div className="w-56 bg-popover">
      <ColorSaturationValuePlane
        label="Accent color"
        value={hsv}
        onChange={commitHsv}
        variant="edge"
      />
      <div className="grid gap-3 p-3">
        <ColorHueSlider
          label="Accent color hue"
          value={hsv.h}
          onChange={(h) => commitHsv({ ...hsv, h })}
        />
        <Input
          nativeInput
          size="compact"
          value={hexDraft ?? currentColor}
          onChange={(event) => {
            const nextColor = event.currentTarget.value;
            setHexDraft(nextColor);
            if (!/^#[\da-f]{6}$/i.test(nextColor)) return;
            setHsv(hexToHsv(nextColor));
            props.onCommit(nextColor);
          }}
          onBlur={() => setHexDraft(null)}
          font="mono"
          aria-label="Custom hex accent color"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

function ProviderCustomColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly placeholderColor: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly onClear: () => void;
}) {
  const normalized = normalizeProviderAccentColor(props.value);
  const shownColor = normalized ?? props.placeholderColor;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="icon-sm"
            variant="ghost-muted"
            style={shownColor ? { backgroundColor: shownColor } : undefined}
            aria-label={`${shownColor ? "Change" : "Add"} accent color for ${props.displayName}`}
          >
            {shownColor ? (
              <span className="sr-only">Change accent color</span>
            ) : (
              <PlusIcon aria-hidden />
            )}
          </Button>
        }
      />
      <PopoverPopup side="bottom" align="start" sideOffset={6} padding="none">
        <ProviderCustomColorPanel
          value={shownColor ?? FALLBACK_ACCENT_COLOR}
          onCommit={props.onCommit}
        />
        {normalized ? (
          <div className="border-t border-border/60 p-1">
            <PopoverClose
              render={
                <Button
                  type="button"
                  size="compact"
                  variant="ghost-muted"
                  className="w-full justify-start"
                  onClick={props.onClear}
                >
                  <XIcon className="size-3.5" aria-hidden />
                  Clear color
                </Button>
              }
            />
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * `placeholderColor` is the automatic color shown while no explicit value is
 * set; clearing an explicit value falls back to it rather than to no color.
 */
export function ProviderAccentColorPicker(props: {
  readonly displayName: string;
  readonly value: string | undefined;
  readonly placeholderColor?: string | undefined;
  readonly onCommit: (value: string) => void;
  readonly description?: string;
  readonly commitDelayMs?: number;
  readonly layout?: "stacked" | "inline";
}) {
  const {
    commitDelayMs = 0,
    description,
    displayName,
    layout = "stacked",
    onCommit,
    placeholderColor,
    value,
  } = props;
  const [optimisticValue, setOptimisticValue] = useState(() => value ?? "");
  const commitTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<string | null>(null);
  const onCommitRef = useRef(onCommit);

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  useEffect(() => {
    if (pendingCommitRef.current !== null) return;
    setOptimisticValue(value ?? "");
  }, [value]);

  useEffect(() => {
    return () => {
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
      }
      const pendingCommit = pendingCommitRef.current;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    };
  }, []);

  const commitAccentColor = (value: string) => {
    const normalizedValue = normalizeProviderAccentColor(value) ?? "";
    setOptimisticValue(normalizedValue);

    if (commitDelayMs <= 0) {
      pendingCommitRef.current = null;
      if (commitTimeoutRef.current !== null) {
        clearTimeout(commitTimeoutRef.current);
        commitTimeoutRef.current = null;
      }
      onCommit(normalizedValue);
      return;
    }

    pendingCommitRef.current = normalizedValue;
    if (commitTimeoutRef.current !== null) {
      clearTimeout(commitTimeoutRef.current);
    }
    commitTimeoutRef.current = setTimeout(() => {
      commitTimeoutRef.current = null;
      const pendingCommit = pendingCommitRef.current;
      pendingCommitRef.current = null;
      if (pendingCommit !== null) {
        onCommitRef.current(pendingCommit);
      }
    }, commitDelayMs);
  };

  const normalized = normalizeProviderAccentColor(optimisticValue);
  const picker = (
    <ProviderCustomColorPicker
      displayName={displayName}
      value={normalized}
      placeholderColor={placeholderColor}
      onCommit={commitAccentColor}
      onClear={() => commitAccentColor("")}
    />
  );

  if (layout === "inline") {
    return picker;
  }

  return (
    <div className="grid gap-2">
      <span className="text-xs font-medium text-foreground">Accent color</span>
      {picker}
      {description ? <span className="text-xs text-muted-foreground">{description}</span> : null}
    </div>
  );
}
