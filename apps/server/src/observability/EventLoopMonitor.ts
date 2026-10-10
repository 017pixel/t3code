// @effect-diagnostics nodeBuiltinImport:off - only node:perf_hooks exposes the event loop delay histogram.
import * as NodePerfHooks from "node:perf_hooks";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

// Node's delay histogram wakes a native timer every RESOLUTION_MS and records the
// gap between wakeups, so an idle loop reads about RESOLUTION_MS and a stall of S
// reads between S and S + RESOLUTION_MS. We subtract the resolution, so a delay can
// undercount a stall by up to RESOLUTION_MS. Ten native wakeups per second catch
// short stalls without scheduling JS work at that frequency.
const RESOLUTION_MS = 100;
const STALL_THRESHOLD_MS = 250;
const SAMPLE_INTERVAL_MS = 1000;

/** One sample interval as Node reports it. Delay in ns, active time in ms, CPU in µs. */
export interface EventLoopReadings {
  readonly delayMaxNs: number;
  /** Timer drift also covers startup and the histogram's first gap after reset. */
  readonly tickDelayMs?: number;
  readonly activeMs: number;
  readonly utilization: number;
  readonly usage: Pick<
    NodeJS.ResourceUsage,
    | "userCPUTime"
    | "systemCPUTime"
    | "majorPageFault"
    | "minorPageFault"
    | "involuntaryContextSwitches"
  >;
  readonly rssBytes: number;
}

// Enables the delay histogram for the layer's lifetime. Each read returns the
// readings since the previous read and resets the histogram. Node skips the first
// gap after a reset, so a stall right at a sample boundary can be missed.
const makeNodeSampler = Effect.gen(function* () {
  const histogram = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const histogram = NodePerfHooks.monitorEventLoopDelay({ resolution: RESOLUTION_MS });
      histogram.enable();
      return histogram;
    }),
    (histogram) => Effect.sync(() => histogram.disable()),
  );
  let elu = NodePerfHooks.performance.eventLoopUtilization();
  let usage = process.resourceUsage();
  let sampledAt = NodePerfHooks.performance.now();
  // The native histogram needs one wakeup before it can record a gap. One
  // startup probe covers a stall that finishes before the first one-second tick.
  const armedAt = sampledAt;
  let startupDelayMs = 0;
  // @effect-diagnostics-next-line globalTimersInEffect:off -- The native boot probe must arm before Effect scheduling can run startup work.
  const startupProbe = setTimeout(() => {
    startupDelayMs = Math.max(0, NodePerfHooks.performance.now() - armedAt - RESOLUTION_MS);
  }, RESOLUTION_MS);
  yield* Effect.addFinalizer(() => Effect.sync(() => clearTimeout(startupProbe)));

  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.sync(() => {
    const nextElu = NodePerfHooks.performance.eventLoopUtilization();
    const nextUsage = process.resourceUsage();
    const now = NodePerfHooks.performance.now();
    const loop = NodePerfHooks.performance.eventLoopUtilization(nextElu, elu);
    const readings: EventLoopReadings = {
      delayMaxNs: histogram.max,
      tickDelayMs: Math.max(startupDelayMs, now - sampledAt - SAMPLE_INTERVAL_MS, 0),
      activeMs: loop.active,
      utilization: loop.utilization,
      usage: {
        userCPUTime: nextUsage.userCPUTime - usage.userCPUTime,
        systemCPUTime: nextUsage.systemCPUTime - usage.systemCPUTime,
        majorPageFault: nextUsage.majorPageFault - usage.majorPageFault,
        minorPageFault: nextUsage.minorPageFault - usage.minorPageFault,
        involuntaryContextSwitches:
          nextUsage.involuntaryContextSwitches - usage.involuntaryContextSwitches,
      },
      rssBytes: process.memoryUsage.rss(),
    };
    histogram.reset();
    startupDelayMs = 0;
    elu = nextElu;
    usage = nextUsage;
    sampledAt = now;
    return readings;
  });
});

/**
 * Returns the stall to report for one sample in ms, or undefined when there was none.
 */
export const stallMs = ({ delayMaxNs, tickDelayMs = 0 }: EventLoopReadings) => {
  const delayMs = Math.round(Math.max(delayMaxNs / 1e6 - RESOLUTION_MS, tickDelayMs));
  // ELU's active time can lag the histogram, especially across startup and resets.
  // Keep it as diagnostic context rather than letting it suppress an observed gap.
  if (delayMs <= STALL_THRESHOLD_MS) return undefined;
  return delayMs;
};

/**
 * Samples event loop health every second and records a `server.eventLoop.stall` span
 * with a warning when the loop stalled for more than 250 ms, so stalls land in
 * the local trace file and Settings > Diagnostics without OTLP. Takes the sampler
 * so tests can inject readings.
 */
export const layerWith = (
  makeSampler: Effect.Effect<Effect.Effect<EventLoopReadings>, never, Scope.Scope>,
) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sample = yield* makeSampler;
      const tick = Effect.gen(function* () {
        const readings = yield* sample;
        const delayMaxMs = stallMs(readings);
        if (delayMaxMs === undefined) return;
        const { utilization, usage, rssBytes } = readings;
        // Root, as the stall has no caller to attach to. Warn level keeps it when
        // T3CODE_TRACE_MIN_LEVEL is raised to cut trace noise.
        yield* Effect.logWarning(`event loop stalled for ${delayMaxMs} ms`).pipe(
          Effect.withSpan("server.eventLoop.stall", {
            root: true,
            level: "Warn",
            attributes: {
              delayMaxMs,
              utilization: Math.round(utilization * 100) / 100,
              cpuUserMs: Math.round(usage.userCPUTime / 1000),
              cpuSystemMs: Math.round(usage.systemCPUTime / 1000),
              majorPageFaults: usage.majorPageFault,
              minorPageFaults: usage.minorPageFault,
              involuntaryContextSwitches: usage.involuntaryContextSwitches,
              rssMb: Math.round(rssBytes / 1024 / 1024),
            },
          }),
        );
      });
      const wait = Effect.sleep(SAMPLE_INTERVAL_MS);
      // Include the first sample: startup stalls are particularly costly on a large DB.
      yield* wait.pipe(Effect.andThen(tick), Effect.forever, Effect.forkScoped);
    }),
  );

export const layer = layerWith(makeNodeSampler);
