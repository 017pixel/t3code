import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 100 ms, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
};
// Over the threshold as read, but not once the resolution is subtracted.
const quiet: EventLoopMonitor.EventLoopReadings = { ...stalled, delayMaxNs: ms(300) };

describe("EventLoopMonitor", () => {
  it.effect("records a warning span only for samples that saw a stall", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const samples = [stalled, quiet, stalled];

      yield* Effect.gen(function* () {
        yield* Layer.build(
          EventLoopMonitor.layerWith(Effect.succeed(Effect.sync(() => samples.shift() ?? quiet))),
        );
        yield* TestClock.adjust("1 second");
        assert.lengthOf(spans, 1);
        yield* TestClock.adjust("1 second");
        assert.lengthOf(spans, 1);
        yield* TestClock.adjust("1 second");
      }).pipe(Effect.scoped, Effect.withTracer(tracer));

      assert.deepStrictEqual(
        spans.map((span) => span.name),
        ["server.eventLoop.stall", "server.eventLoop.stall"],
      );
      const [span] = spans;
      assert.deepStrictEqual(Object.fromEntries(span!.attributes), {
        delayMaxMs: 5_850,
        utilization: 0.18,
        cpuUserMs: 310,
        cpuSystemMs: 96,
        majorPageFaults: 8_412,
        minorPageFaults: 20_031,
        involuntaryContextSwitches: 57,
        rssMb: 1536,
      });
      assert.deepStrictEqual(
        span!.events.map(([name, , attributes]) => [name, attributes["effect.logLevel"]]),
        [["event loop stalled for 5850 ms", "WARN"]],
      );
    }),
  );

  it("reports short stalls even when ELU active time lags the delay reading", () => {
    const short: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(850),
      activeMs: 100,
    };
    assert.strictEqual(EventLoopMonitor.stallMs(short), 750);
    // Before the loop starts, ELU reads 0 and CPU time shows the loop was busy.
    const busyBeforeLoop = {
      ...quiet,
      activeMs: 0,
      usage: { ...quiet.usage, userCPUTime: 52_000_000, systemCPUTime: 900_000 },
    };
    assert.strictEqual(
      EventLoopMonitor.stallMs({ ...busyBeforeLoop, tickDelayMs: 53_000 }),
      53_000,
    );
    assert.isUndefined(EventLoopMonitor.stallMs(quiet));
  });

  it("ignores a long gap the loop spent idle, such as a system sleep", () => {
    // Waking from sleep reads as a long gap, but the loop was idle in poll for it.
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.isUndefined(EventLoopMonitor.stallMs({ ...quiet, tickDelayMs: 7_200_000 }));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_900);
  });
});
