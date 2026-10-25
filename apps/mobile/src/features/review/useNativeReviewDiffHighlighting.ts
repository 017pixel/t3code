import type { HighlightScheme } from "../../lib/highlights";

import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
  highlightNativeReviewDiffVisibleRows,
  type NativeReviewDiffHighlightChunk,
} from "../diffs/nativeReviewDiffHighlighter";
import type { NativeReviewDiffRow } from "../diffs/nativeReviewDiffSurface";
import type { NativeReviewDiffFile } from "../diffs/nativeReviewDiffTypes";
import { diffHighlightTraceId, traceDiffHighlight } from "../diffs/nativeReviewDiffTrace";

import {
  createReviewDiffHighlightScheduler,
  type NativeReviewVisibleRange,
} from "./reviewDiffHighlightScheduler";

function createEmptyTokenPatch(resetKey: string): string {
  return JSON.stringify({ resetKey, tokensByRowId: {} });
}

interface HighlightSessionInput {
  readonly files: ReadonlyArray<NativeReviewDiffFile>;
  readonly rows: ReadonlyArray<NativeReviewDiffRow>;
  readonly scheme: HighlightScheme;
  readonly collapsedFileIds: ReadonlySet<string>;
  readonly resetKey: string;
  readonly enabled: boolean;
}

interface HookMemory {
  // The view's last native range outlives sessions, which restart on a token reset.
  range: NativeReviewVisibleRange | undefined;
  session: { readonly key: string; readonly atom: SessionAtom } | undefined;
}

type TokenPatchPayload = Readonly<Record<string, unknown>>;

interface HighlightSession {
  readonly tokensPatchJson: string;
  readonly updateVisibleRange: (range: NativeReviewVisibleRange) => void;
  readonly acknowledgeTokenPatch: (payload: TokenPatchPayload) => void;
  readonly rejectTokenPatch: (payload: TokenPatchPayload) => void;
  readonly setInputs: (input: HighlightSessionInput) => void;
}

// Sessions sharing a reset key share native token state, so chunk indexes must never repeat.
let nextChunkIndex = 0;

/**
 * One highlighting session per token reset (enabled, resetKey, row count): it highlights each
 * visible range the scheduler requests, feeds native one undelivered chunk at a time, and aborts
 * in-flight work when the last reader goes away or a newer range or input supersedes it.
 */
function makeHighlightSessionAtom(initialInput: HighlightSessionInput, memory: HookMemory) {
  const { enabled, resetKey } = initialInput;
  return Atom.make((get): HighlightSession => {
    // Collapsed files, scheme and row content change what a range highlights, not which tokens
    // native already accepted, so they swap in without a reset.
    let inputs = initialInput;
    let requestedRange: NativeReviewVisibleRange | undefined;
    const highlightedRowIds = new Set<string>();
    // Keep undelivered chunks, rather than repeatedly serializing every highlighted row.
    const pendingPatches: Array<{ chunkIndex: number; json: string; rowIds: string[] }> = [];
    const reset = diffHighlightTraceId(resetKey);
    let inFlight: { readonly controller: AbortController; readonly generation: number } | null =
      null;
    let session: HighlightSession;

    const publish = (tokensPatchJson: string) => {
      if (session.tokensPatchJson === tokensPatchJson) return;
      session = { ...session, tokensPatchJson };
      get.setSelf(session);
    };

    const abortInFlight = () => {
      if (!inFlight) return;
      traceDiffHighlight("viewport-abort", { generation: inFlight.generation, reset });
      inFlight.controller.abort();
      inFlight = null;
    };

    const highlight = (requestRange: NativeReviewVisibleRange) => {
      requestedRange = requestRange;
      const { collapsedFileIds, files, rows, scheme } = inputs;
      if (!enabled || rows.length === 0) {
        return;
      }
      abortInFlight();
      const abortController = new AbortController();
      const generation = diffHighlightTraceId(abortController);
      inFlight = { controller: abortController, generation };
      traceDiffHighlight("viewport-start", {
        generation,
        reset,
        first: requestRange.firstRowIndex,
        last: requestRange.lastRowIndex,
        pending: pendingPatches.length,
      });

      const enqueueChunk = (result: NativeReviewDiffHighlightChunk) => {
        if (abortController.signal.aborted || result.rowCount === 0) return;
        const retryableRowIds = new Set(result.retryableRowIds);
        const rowIds = Object.keys(result.tokensByRowId);
        for (const rowId of rowIds) {
          if (!retryableRowIds.has(rowId)) highlightedRowIds.add(rowId);
        }
        const chunkIndex = nextChunkIndex++;
        const json = JSON.stringify({
          resetKey,
          chunkIndex,
          fileId: "visible",
          filePath: "visible rows",
          language: "diff",
          lineCount: result.rowCount,
          durationMs: result.durationMs,
          tokensByRowId: result.tokensByRowId,
        });
        pendingPatches.push({ chunkIndex, json, rowIds });
        traceDiffHighlight("patch-queued", {
          generation,
          reset,
          chunk: chunkIndex,
          rows: rowIds.length,
          pending: pendingPatches.length,
        });
        if (pendingPatches.length === 1) publish(json);
      };

      void (async () => {
        // Deliver viewport tokens before offscreen source fetches can delay them.
        let retryableViewportRowIds: ReadonlyArray<string> = [];
        for (const overscanRows of [0, undefined]) {
          const deliveredRowIds = new Set<string>();
          const settled = await settlePromise(() =>
            highlightNativeReviewDiffVisibleRows({
              files,
              rows,
              scheme,
              collapsedFileIds,
              firstRowIndex: requestRange.firstRowIndex,
              lastRowIndex: requestRange.lastRowIndex,
              overscanRows,
              alreadyHighlightedRowIds:
                retryableViewportRowIds.length > 0
                  ? new Set([...highlightedRowIds, ...retryableViewportRowIds])
                  : highlightedRowIds,
              signal: abortController.signal,
              onChunk: (chunk) => {
                for (const rowId of Object.keys(chunk.tokensByRowId)) deliveredRowIds.add(rowId);
                enqueueChunk(chunk);
              },
            }),
          );
          if (abortController.signal.aborted) return;
          if (AsyncResult.isFailure(settled)) {
            console.warn("[review-sheet] native visible highlight failed", {
              error: squashAtomCommandFailure(settled),
              resetKey,
              scheme,
              collapsedFileIds,
              firstRowIndex: requestRange.firstRowIndex,
              lastRowIndex: requestRange.lastRowIndex,
            });
            return;
          }
          const result = settled.value;
          traceDiffHighlight("viewport-result", {
            generation,
            reset,
            overscan: overscanRows ?? 160,
            rows: result.rowCount,
            retryable: result.retryableRowIds.length,
          });
          if (result.rowCount === 0) continue;
          retryableViewportRowIds = result.retryableRowIds;

          const remaining = Object.fromEntries(
            Object.entries(result.tokensByRowId).filter(([rowId]) => !deliveredRowIds.has(rowId)),
          );
          enqueueChunk({
            ...result,
            tokensByRowId: remaining,
            rowCount: Object.keys(remaining).length,
          });
        }
      })();
    };

    const isPendingHead = (payload: TokenPatchPayload) => {
      const head = pendingPatches[0];
      return !!head && payload.resetKey === resetKey && payload.chunkIndex === head.chunkIndex;
    };

    const acknowledgeTokenPatch = (payload: TokenPatchPayload) => {
      const matches = isPendingHead(payload);
      traceDiffHighlight("patch-ack", {
        reset: diffHighlightTraceId(payload.resetKey),
        chunk: typeof payload.chunkIndex === "number" ? payload.chunkIndex : -1,
        matches,
        pending: pendingPatches.length,
      });
      if (!matches) return;
      pendingPatches.shift();
      publish(pendingPatches[0]?.json ?? createEmptyTokenPatch(resetKey));
    };

    const rejectTokenPatch = (payload: TokenPatchPayload) => {
      const matches = isPendingHead(payload);
      traceDiffHighlight("patch-rejected", {
        reset: diffHighlightTraceId(payload.resetKey),
        chunk: typeof payload.chunkIndex === "number" ? payload.chunkIndex : -1,
        matches,
      });
      const head = pendingPatches[0];
      if (!matches || !head) return;
      for (const rowId of head.rowIds) highlightedRowIds.delete(rowId);
      // Retry these rows only on a later viewport request, not in a failure loop.
      acknowledgeTokenPatch(payload);
    };

    const setInputs = (next: HighlightSessionInput) => {
      if (
        next.files === inputs.files &&
        next.rows === inputs.rows &&
        next.scheme === inputs.scheme &&
        next.collapsedFileIds === inputs.collapsedFileIds
      ) {
        return;
      }
      inputs = next;
      abortInFlight();
      if (requestedRange) highlight(requestedRange);
    };

    const scheduler = createReviewDiffHighlightScheduler(highlight);
    get.addFinalizer(() => {
      scheduler.cancel();
      abortInFlight();
    });
    session = {
      tokensPatchJson: createEmptyTokenPatch(resetKey),
      updateVisibleRange: (range) => {
        memory.range = range;
        scheduler.update(range);
      },
      acknowledgeTokenPatch,
      rejectTokenPatch,
      setInputs,
    };
    traceDiffHighlight("viewport-reset", { reset, enabled, rows: inputs.rows.length });
    // A new session need not get another native range event. Reuse only an observed
    // viewport, with the same coalescing that lets a new jump replace it.
    if (memory.range) scheduler.update(memory.range);
    return session;
  }).pipe(Atom.withLabel(`mobile:review-diff:highlight:${resetKey}`));
}

type SessionAtom = ReturnType<typeof makeHighlightSessionAtom>;

function highlightSessionAtom(input: HighlightSessionInput, memory: HookMemory): SessionAtom {
  const key = JSON.stringify([input.enabled, input.resetKey, input.rows.length]);
  if (memory.session?.key !== key) {
    memory.session = { key, atom: makeHighlightSessionAtom(input, memory) };
  }
  return memory.session.atom;
}

export function useNativeReviewDiffHighlighting(input: HighlightSessionInput): HighlightSession {
  const [memory] = useState<HookMemory>(() => ({ range: undefined, session: undefined }));
  const session = useAtomValue(highlightSessionAtom(input, memory));
  const { collapsedFileIds, enabled, files, resetKey, rows, scheme } = input;
  // Native keeps the accepted tokens across a collapse, scheme or row change, so the running
  // session takes the new inputs and re-highlights instead of restarting.
  useEffect(() => {
    session.setInputs({ collapsedFileIds, enabled, files, resetKey, rows, scheme });
  }, [session, collapsedFileIds, enabled, files, resetKey, rows, scheme]);
  return session;
}
