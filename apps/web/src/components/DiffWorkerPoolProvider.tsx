import { WorkerPoolContext, useWorkerPool } from "@pierre/diffs/react";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import * as Schema from "effect/Schema";
import { useSyncExternalStore, type ReactNode } from "react";
import { getRenderedAppearance, subscribeRenderedAppearance } from "../hooks/useTheme";
import { resolveDiffThemeName } from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";

export class DiffWorkerError extends Schema.TaggedError<DiffWorkerError>()("DiffWorkerError", {
  operation: Schema.Literals(["create-worker", "get-render-options", "set-render-options"]),
  themeName: Schema.Literals(["pierre-light", "pierre-dark"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Diff worker operation ${this.operation} failed for theme ${this.themeName}.`;
  }
}

const DIFF_WORKER_IDLE_TTL_MS = 30_000;
function resolveDiffWorkerPoolSize() {
  const cores =
    typeof navigator === "undefined" ? 4 : Math.max(1, navigator.hardwareConcurrency || 4);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}
let sharedWorkerPool:
  | {
      readonly pool: WorkerPoolManager;
      readonly unsubscribeTheme: () => void;
      consumers: number;
      idleTimer: ReturnType<typeof setTimeout> | undefined;
    }
  | undefined;

function applyDiffWorkerTheme(pool: WorkerPoolManager) {
  const themeName = resolveDiffThemeName(getRenderedAppearance());
  let operation: DiffWorkerError["operation"] = "get-render-options";
  void (async () => {
    try {
      const current = pool.getDiffRenderOptions();
      if (current.theme === themeName) return;
      operation = "set-render-options";
      await pool.setRenderOptions({ ...current, theme: themeName });
    } catch (cause) {
      console.error(new DiffWorkerError({ operation, themeName, cause }));
    }
  })();
}

function createDiffWorkerPool(poolSize: number) {
  const themeName = resolveDiffThemeName(getRenderedAppearance());
  const pool = new WorkerPoolManager(
    {
      workerFactory: () => {
        try {
          return new DiffsWorker();
        } catch (cause) {
          throw new DiffWorkerError({ operation: "create-worker", themeName, cause });
        }
      },
      poolSize,
      totalASTLRUCacheSize: 240,
    },
    {
      theme: themeName,
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      tokenizeMaxLineLength: 1_000,
      useTokenTransformer: true,
    },
  );
  return {
    pool,
    unsubscribeTheme: subscribeRenderedAppearance(() => applyDiffWorkerTheme(pool)),
    consumers: 0,
    idleTimer: undefined,
  };
}

function acquireDiffWorkerPool(poolSize: number) {
  const entry = (sharedWorkerPool ??= createDiffWorkerPool(poolSize));
  clearTimeout(entry.idleTimer);
  entry.idleTimer = undefined;
  entry.consumers += 1;
  return entry;
}

// A failed start still counts as settled: the views fall back to plain text.
const settledWorkerPools = new WeakSet<WorkerPoolManager>();
const settlingWorkerPools = new WeakMap<WorkerPoolManager, Promise<void>>();

function isWorkerPoolReady(workerPool: WorkerPoolManager): boolean {
  return (
    settledWorkerPools.has(workerPool) || workerPool.isInitialized() || !workerPool.isWorkingPool()
  );
}

function subscribeWorkerPoolReady(workerPool: WorkerPoolManager, onReady: () => void) {
  if (isWorkerPoolReady(workerPool)) return () => {};
  let settling = settlingWorkerPools.get(workerPool);
  if (settling === undefined) {
    const settle = () => {
      settledWorkerPools.add(workerPool);
    };
    settling = workerPool.initialize().then(settle, settle);
    settlingWorkerPools.set(workerPool, settling);
  }
  void settling.then(onReady);
  // React ignores a store change for a component that has unmounted.
  return () => {};
}

function DiffWorkerLoading() {
  return (
    <div
      role="status"
      className="flex min-h-0 flex-1 items-center justify-center p-4 text-xs text-muted-foreground"
    >
      Loading code...
    </div>
  );
}

// Plain-text views do not queue a highlight task that could retry a blank first render.
function DiffWorkerReady({ children }: { children?: ReactNode }) {
  const workerPool = useWorkerPool();
  const ready = useSyncExternalStore(
    (onReady) =>
      workerPool === undefined ? () => {} : subscribeWorkerPoolReady(workerPool, onReady),
    () => (workerPool === undefined ? false : isWorkerPoolReady(workerPool)),
    () => true,
  );
  return ready ? children : <DiffWorkerLoading />;
}

// Module-level so the subscribe identity is stable: a new one would release and reacquire
// the shared pool on every render.
function subscribeSharedWorkerPool(onStoreChange: () => void) {
  if (typeof window === "undefined") return () => {};
  const entry = acquireDiffWorkerPool(resolveDiffWorkerPoolSize());
  onStoreChange();
  return () => {
    entry.consumers -= 1;
    if (entry.consumers !== 0) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      entry.unsubscribeTheme();
      entry.pool.terminate();
      if (sharedWorkerPool === entry) sharedWorkerPool = undefined;
    }, DIFF_WORKER_IDLE_TTL_MS);
  };
}

export function DiffWorkerPoolProvider({ children }: { children?: ReactNode }) {
  const workerPool = useSyncExternalStore(
    subscribeSharedWorkerPool,
    () => sharedWorkerPool?.pool,
    () => undefined,
  );

  return (
    <WorkerPoolContext value={workerPool}>
      <DiffWorkerReady>{children}</DiffWorkerReady>
    </WorkerPoolContext>
  );
}
