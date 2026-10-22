import { useEffect, useId, useState } from "react";
import { create } from "zustand";
import {
  localSnoozeDate,
  localSnoozeTime,
  resolveCustomSnooze,
  type CustomSnoozeInput,
} from "@t3tools/client-runtime/state/thread-settled";
import { Button } from "./ui/button";
import { CalendarIcon } from "lucide-react";
import { Calendar } from "./ui/calendar";
import { usePrimarySettings } from "../hooks/useSettings";
import { resolveHour12, weekStartsOn } from "../timestampFormat";
import { Popover, PopoverTrigger, PopoverPopup } from "./ui/popover";
import { Label } from "./ui/label";
import { Toggle, ToggleGroup } from "./ui/toggle-group";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "./ui/select";
import {
  NumberField,
  NumberFieldGroup,
  NumberFieldInput,
  NumberFieldDecrement,
  NumberFieldIncrement,
} from "./ui/number-field";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
  DialogFooter,
} from "./ui/dialog";

type SnoozeChoice = { readonly snoozedUntil: string };
type Request = { readonly resolve: (choice: SnoozeChoice | null) => void };
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

export function requestCustomSnooze(): Promise<SnoozeChoice | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { resolve } }));
}

function finish(choice: SnoozeChoice | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(choice);
}

export function CustomSnoozeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <CustomSnoozeDialog /> : null;
}

function CustomSnoozeDialog() {
  const id = useId();
  const [initial] = useState(() => new Date(Date.now() + 3_600_000));
  const [mode, setMode] = useState<CustomSnoozeInput["mode"]>("date");
  const [date, setDate] = useState(initial);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [time, setTime] = useState(localSnoozeTime(initial));
  const [amount, setAmount] = useState("2");
  const [unit, setUnit] = useState<"minutes" | "hours" | "days">("hours");
  const [error, setError] = useState<string | null>(null);
  const input: CustomSnoozeInput =
    mode === "date" ? { mode, date: localSnoozeDate(date), time } : { mode, amount, unit };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const snoozedUntil = resolveCustomSnooze(input, new Date());
            if (!snoozedUntil) {
              setError(
                mode === "date"
                  ? "Choose a valid date and time in the future."
                  : "Enter a positive duration.",
              );
              return;
            }
            finish({ snoozedUntil });
          }}
        >
          <DialogHeader>
            <DialogTitle>Custom snooze</DialogTitle>
            <DialogDescription>Choose when snoozed threads return to your inbox.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <ToggleGroup
                aria-label="Schedule type"
                className="w-full *:flex-1"
                value={[mode]}
                onValueChange={(next) => {
                  const value = next[0];
                  if (value === "date" || value === "duration") setMode(value);
                  setError(null);
                }}
              >
                <Toggle value="date">Date and time</Toggle>
                <Toggle value="duration">Duration</Toggle>
              </ToggleGroup>
              <div className="flex flex-col gap-4">
                {mode === "date" ? (
                  <div className="grid grid-cols-1 gap-3">
                    <div className="flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={`${id}-date`}>Date</Label>
                      <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
                        <PopoverTrigger
                          render={
                            <Button
                              id={`${id}-date`}
                              variant="outline"
                              className="w-full justify-between"
                            />
                          }
                        >
                          {date.toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                            year: "numeric",
                          })}
                          <CalendarIcon className="size-4 text-muted-foreground" />
                        </PopoverTrigger>
                        <PopoverPopup align="start" aria-label="Choose snooze date">
                          <Calendar
                            mode="single"
                            required
                            selected={date}
                            defaultMonth={date}
                            {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
                            disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                            onSelect={(selected) => {
                              setDate(selected);
                              setCalendarOpen(false);
                              setError(null);
                            }}
                          />
                        </PopoverPopup>
                      </Popover>
                    </div>
                    <SnoozeTimeSelect
                      id={id}
                      time={time}
                      onChange={(next) => {
                        setTime(next);
                        setError(null);
                      }}
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <NumberField
                      id={`${id}-amount`}
                      min={0}
                      step="any"
                      value={amount === "" ? null : Number(amount)}
                      onValueChange={(value) => {
                        setAmount(value === null ? "" : String(value));
                        setError(null);
                      }}
                    >
                      <Label htmlFor={`${id}-amount`}>Snooze for</Label>
                      <NumberFieldGroup>
                        <NumberFieldDecrement aria-label="Decrease duration" />
                        <NumberFieldInput required />
                        <NumberFieldIncrement aria-label="Increase duration" />
                      </NumberFieldGroup>
                    </NumberField>
                    <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-unit`}>
                      Unit
                      <Select
                        value={unit}
                        items={{ minutes: "Minutes", hours: "Hours", days: "Days" }}
                        onValueChange={(value) => {
                          if (value === "minutes" || value === "hours" || value === "days")
                            setUnit(value);
                          setError(null);
                        }}
                      >
                        <SelectTrigger id={`${id}-unit`} className="min-w-0">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectPopup>
                          <SelectItem value="minutes">Minutes</SelectItem>
                          <SelectItem value="hours">Hours</SelectItem>
                          <SelectItem value="days">Days</SelectItem>
                        </SelectPopup>
                      </Select>
                    </Label>
                  </div>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="text-destructive">
                {error}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit">Snooze</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const pad = (value: number) => String(value).padStart(2, "0");
const HOURS_24 = Array.from({ length: 24 }, (_, hour) => pad(hour));
const HOURS_12 = ["12", ...Array.from({ length: 11 }, (_, hour) => pad(hour + 1))];
const MINUTES = Array.from({ length: 60 }, (_, minute) => pad(minute));

// A native time input renders in the browser's locale, ignoring the Time format setting.
function SnoozeTimeSelect(props: {
  readonly id: string;
  readonly time: string;
  readonly onChange: (time: string) => void;
}) {
  const hour12 = usePrimarySettings((settings) => resolveHour12(settings.timestampFormat));
  const hour = Number(props.time.slice(0, 2));
  const minute = props.time.slice(3, 5);
  const pm = hour >= 12;
  const setHour = (next: number) => props.onChange(`${pad(next)}:${minute}`);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label id={`${props.id}-time`} htmlFor={`${props.id}-hour`}>
        Time
      </Label>
      <div
        role="group"
        aria-labelledby={`${props.id}-time`}
        className={hour12 ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}
      >
        <Select
          value={hour12 ? pad(hour % 12 || 12) : pad(hour)}
          onValueChange={(value) => {
            if (value === null) return;
            // 12 AM is hour 0 and 12 PM is hour 12.
            setHour(hour12 ? (Number(value) % 12) + (pm ? 12 : 0) : Number(value));
          }}
        >
          <SelectTrigger id={`${props.id}-hour`} aria-label="Hour" className="min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {(hour12 ? HOURS_12 : HOURS_24).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={minute}
          onValueChange={(value) => {
            if (value !== null) props.onChange(`${pad(hour)}:${value}`);
          }}
        >
          <SelectTrigger aria-label="Minute" className="min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {MINUTES.map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {hour12 && (
          <Select
            value={pm ? "PM" : "AM"}
            onValueChange={(value) => {
              if (value !== null) setHour((hour % 12) + (value === "PM" ? 12 : 0));
            }}
          >
            <SelectTrigger aria-label="AM or PM" className="min-w-0">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="AM">AM</SelectItem>
              <SelectItem value="PM">PM</SelectItem>
            </SelectPopup>
          </Select>
        )}
      </div>
    </div>
  );
}
