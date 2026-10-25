import { useAtomValue } from "@effect/atom-react";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import {
  createLinkedPullRequestSummaryAtomFamily,
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import {
  PullRequestListResult,
  type EnvironmentId,
  type ProjectId,
  type PullRequestChecks,
  type PullRequestDetail,
  type PullRequestListInput,
  type PullRequestFilterOptionsInput,
  type PullRequestListStatsInput,
  type PullRequestListEntry,
  type PullRequestRef,
  type PullRequestSummary,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/client-runtime/thread-pull-requests";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  mergePullRequestLists,
  type EnvironmentPullRequestStat,
  type MergedPullRequestList,
} from "../components/pullRequest/pullRequestList.logic";
import { resolvePullRequestDetailChecks } from "@t3tools/client-runtime/pull-request-checks";
import { writePullRequestDetailSnapshot } from "../components/pullRequest/pullRequestDetail.logic";
import { pullRequestChecksState } from "../components/pullRequest/pullRequestPresentation";
import { useGuideRunStore } from "../components/pullRequest/guide/guideRunStore";
import { formatEnvironmentQueryError } from "./query";
import { environmentThreadShells } from "./threads";

export interface ObservedPullRequestSummary {
  readonly summary: PullRequestSummary;
  /** Client arrival time, the only ordering older servers leave us for same-dated snapshots. */
  readonly observedAt: number;
}

const observedPullRequestSummaryAtom = Atom.family((key: string) =>
  Atom.make<ObservedPullRequestSummary | null>(null).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-pull-requests:observed-summary:${key}`),
  ),
);

function compareSummaries(current: PullRequestSummary, incoming: PullRequestSummary): number {
  const merged = Number(incoming.state === "merged") - Number(current.state === "merged");
  if (merged !== 0) return merged;
  const updated = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
  if (updated !== 0) return updated;
  if (current.observedAt === undefined && incoming.observedAt === undefined) return 0;
  return (incoming.observedAt ?? -Infinity) - (current.observedAt ?? -Infinity);
}

export function newestPullRequestSummary(
  current: PullRequestSummary | null,
  observed: PullRequestSummary | null,
): PullRequestSummary | null {
  if (current === null) return observed;
  if (observed === null) return current;
  return compareSummaries(current, observed) >= 0 ? observed : current;
}

export function pullRequestListEntryToSummary(entry: PullRequestListEntry): PullRequestSummary {
  return {
    provider: entry.provider,
    projectId: entry.projectId,
    repository: entry.repository,
    number: entry.number,
    title: entry.title,
    url: entry.url,
    state: entry.state,
    isDraft: entry.isDraft,
    headBranch: entry.headBranch,
    baseBranch: entry.baseBranch,
    updatedAt: entry.updatedAt,
    ...(entry.observedAt === undefined ? {} : { observedAt: entry.observedAt }),
    author: entry.author,
    ...(entry.reviewDecision === undefined ? {} : { reviewDecision: entry.reviewDecision }),
    ...(entry.checksState === undefined ? {} : { checksState: entry.checksState }),
    mergeability: entry.mergeability,
  };
}

// Project ids pin the remote host; omit host so legacy, URL, and list references share entries.
function pullRequestSummaryKey(environmentId: EnvironmentId, reference: PullRequestRef): string {
  return JSON.stringify([
    environmentId,
    reference.projectId,
    reference.repository.toLowerCase(),
    reference.number,
  ]);
}

export function newestPullRequestObservation(
  current: ObservedPullRequestSummary | null,
  incoming: ObservedPullRequestSummary | null,
): ObservedPullRequestSummary | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  let order = compareSummaries(current.summary, incoming.summary);
  if (
    order === 0 &&
    current.summary.observedAt === undefined &&
    incoming.summary.observedAt === undefined
  ) {
    order = incoming.observedAt - current.observedAt;
  }
  if (!(order > 0)) return current;
  // A sparse summary must not erase known status, or carry old detail stats into a new list read.
  return {
    ...incoming,
    summary: {
      ...incoming.summary,
      isDraft: incoming.summary.isDraft ?? current.summary.isDraft,
      mergeability: incoming.summary.mergeability ?? current.summary.mergeability,
      reviewDecision:
        incoming.summary.reviewDecision === undefined
          ? current.summary.reviewDecision
          : incoming.summary.reviewDecision,
      checksState:
        incoming.summary.checksState === undefined
          ? current.summary.checksState
          : incoming.summary.checksState,
    },
  };
}

function observePullRequestSummary(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  summary: PullRequestSummary,
  observedAt: number,
): void {
  registry.modify(observedPullRequestSummaryAtom(key), (previous) => {
    const next = newestPullRequestObservation(previous, { summary, observedAt });
    return next === previous ? [false, previous] : [true, next];
  });
}

interface Answered<A> {
  readonly value: A;
  readonly at: number;
}

export interface LivePullRequestAnswers {
  readonly detail: Answered<PullRequestDetail> | null;
  readonly checks: Answered<PullRequestChecks | null> | null;
}

/** Detail answers carry checks too, so whichever of the two arrived last decides them. */
export function livePullRequestObservation(
  answers: LivePullRequestAnswers,
): ObservedPullRequestSummary | null {
  const { detail, checks } = answers;
  if (detail === null) return null;
  const live = resolvePullRequestDetailChecks(
    detail.value,
    checks?.value ?? null,
    checks !== null && checks.at >= detail.at,
  );
  if (live === null) return null;
  return {
    summary: { ...live, checksState: pullRequestChecksState(live.checks) },
    observedAt: Math.max(detail.at, checks?.at ?? 0),
  };
}

const livePullRequestAnswersAtom = Atom.family((key: string) =>
  Atom.make<LivePullRequestAnswers>({ detail: null, checks: null }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel(`web-pull-requests:live-answers:${key}`),
  ),
);

function recordLiveAnswer(
  registry: AtomRegistry.AtomRegistry,
  key: string,
  patch: Partial<LivePullRequestAnswers>,
): void {
  const atom = livePullRequestAnswersAtom(key);
  const answers = { ...registry.get(atom), ...patch };
  registry.set(atom, answers);
  const observation = livePullRequestObservation(answers);
  if (observation !== null) {
    observePullRequestSummary(registry, key, observation.summary, observation.observedAt);
  }
}

function snapshotStorage(): Storage | undefined {
  return typeof window === "undefined" ? undefined : window.localStorage;
}

type ListAnswerStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const LIST_SCOPE_INDEX_KEY = "t3.pullRequests.listScopes";
const LIST_SCOPE_KEY_PREFIX = "t3.pullRequests.listScope:";
const LEGACY_SNAPSHOT_KEY_PREFIX = "t3.pullRequests.list:";
const LIST_ANSWER_MAX_ENTRIES = 99;
/**
 * A scope holds a page of rows per environment, so only the scopes visited most recently are
 * kept. Eviction drops a whole scope, never one environment's answer, so a restored list is never
 * missing environments that did answer.
 */
const LIST_SCOPE_MAX_KEPT = 8;
const listScopeCodec = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.toCodecJson(PullRequestListResult)),
);
const decodeListScope = Schema.decodeUnknownOption(listScopeCodec);
const encodeListScope = Schema.encodeOption(listScopeCodec);
const decodeListScopeIndex = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);
const sweptStorages = new WeakSet<ListAnswerStorage>();

/**
 * The project assignment is left out: a cold start asks before the project shells load, when
 * every environment is asked for all of its projects, while the answers were remembered after
 * overlapping projects were split between environments. Each environment's answer covers only
 * its assigned projects, so the scope's answers together still cover the whole scope.
 */
const listScopeKey = ({ projectIds: _projectIds, ...scope }: PullRequestListInput) =>
  `${LIST_SCOPE_KEY_PREFIX}${JSON.stringify(scope)}`;

function readListScope(storage: ListAnswerStorage | undefined, key: string) {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(key) ?? null;
  } catch {}
  return Option.getOrElse(decodeListScope(raw), (): Record<string, PullRequestListResult> => ({}));
}

/** The single composite snapshot this replaced is never read again. */
function sweepLegacySnapshots(storage: ListAnswerStorage): void {
  if (sweptStorages.has(storage)) return;
  sweptStorages.add(storage);
  const legacy: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(LEGACY_SNAPSHOT_KEY_PREFIX)) legacy.push(key);
  }
  for (const key of legacy) storage.removeItem(key);
}

/**
 * Keeps what a cold start can show before the host answers again. Searches, continuation pages
 * and grown pages are never shown that way, so only first-page reads are kept. Failures and
 * cursors are dropped: they describe the moment of the read, and a restored list must not
 * continue from it.
 */
export function rememberPullRequestListAnswer(
  storage: ListAnswerStorage | undefined,
  target: EnvironmentQueryTarget<PullRequestListInput>,
  answer: PullRequestListResult,
): void {
  const { input } = target;
  if (storage === undefined || input.query !== undefined || input.cursors !== undefined) return;
  if (input.limit !== undefined && input.limit > LIST_ANSWER_MAX_ENTRIES) return;
  const key = listScopeKey(input);
  try {
    sweepLegacySnapshots(storage);
    const encoded = encodeListScope({
      ...readListScope(storage, key),
      [target.environmentId]: {
        ...answer,
        entries: answer.entries.slice(0, LIST_ANSWER_MAX_ENTRIES),
        errors: [],
        nextCursors: {},
      },
    });
    if (Option.isNone(encoded)) return;
    const index = Option.getOrElse(
      decodeListScopeIndex(storage.getItem(LIST_SCOPE_INDEX_KEY)),
      () => [],
    );
    const kept = [key, ...index.filter((held) => held !== key)];
    for (const evicted of kept.slice(LIST_SCOPE_MAX_KEPT)) storage.removeItem(evicted);
    storage.setItem(key, encoded.value);
    storage.setItem(LIST_SCOPE_INDEX_KEY, JSON.stringify(kept.slice(0, LIST_SCOPE_MAX_KEPT)));
  } catch {}
}

/**
 * The kept answers for these reads, merged the way live answers are. An environment without a
 * kept answer is left out rather than failing the restore: one whose projects were all assigned
 * to another environment was never asked, and its pull requests are in that environment's answer.
 */
export function restorePullRequestList(
  storage: ListAnswerStorage | undefined,
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestList | null {
  const scopes = new Map<string, Record<string, PullRequestListResult>>();
  const answers: Array<readonly [EnvironmentId, PullRequestListResult]> = [];
  for (const target of targets) {
    const key = listScopeKey(target.input);
    const scope = scopes.get(key) ?? readListScope(storage, key);
    scopes.set(key, scope);
    const answer = scope[target.environmentId];
    if (answer !== undefined) answers.push([target.environmentId, answer]);
  }
  const merged = mergePullRequestLists(answers);
  if (merged === null) return null;
  // Answers kept before the projects were reassigned between environments can overlap.
  const seen = new Set<string>();
  const entries = merged.entries.filter((entry) => {
    const key = `${entry.host}:${entry.repository}#${entry.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...merged, entries };
}

export function restoredPullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestList | null {
  return restorePullRequestList(snapshotStorage(), targets);
}

// Answers are stamped on arrival: older servers leave no other ordering for same-dated reads.
export const pullRequestEnvironment = createPullRequestEnvironmentAtoms(connectionAtomRuntime, {
  list: ({ environmentId, input }, answer, registry) =>
    Effect.map(Clock.currentTimeMillis, (observedAt) => {
      rememberPullRequestListAnswer(snapshotStorage(), { environmentId, input }, answer);
      for (const entry of answer.entries) {
        observePullRequestSummary(
          registry,
          pullRequestSummaryKey(environmentId, entry),
          pullRequestListEntryToSummary(entry),
          observedAt,
        );
      }
    }),
  detail: ({ environmentId, input }, detail, registry) =>
    Effect.map(Clock.currentTimeMillis, (at) => {
      // Only fresh reads seed the cold-start snapshot; a stale one could replace a newer record.
      if (input.allowStale === false) {
        writePullRequestDetailSnapshot(snapshotStorage(), environmentId, input, detail);
      }
      recordLiveAnswer(registry, pullRequestSummaryKey(environmentId, input), {
        detail: { value: detail, at },
      });
    }),
  checks: ({ environmentId, input }, checks, registry) =>
    Effect.map(Clock.currentTimeMillis, (at) =>
      recordLiveAnswer(registry, pullRequestSummaryKey(environmentId, input), {
        checks: { value: checks, at },
      }),
    ),
  // Covers runs started elsewhere (another client, an agent) as well as this client's own.
  reviewGuide: ({ environmentId, input }, guide) =>
    Effect.map(Clock.currentTimeMillis, (since) => {
      if (guide.run?._tag !== "Running") return;
      useGuideRunStore.getState().watch({
        environmentId,
        reference: input,
        title: null,
        previousGuideAt: guide.guide?.generatedAt ?? null,
        previousFailedAt: null,
        since,
        answeredRunning: true,
      });
    }),
});
// Keyed by the source so the last revision read lives as long as the query it describes. The
// families below only cache atom identity, and their entries are collectable.
const revisionReadBySource = new WeakMap<
  Atom.Atom<unknown>,
  WeakMap<AtomRegistry.AtomRegistry, string>
>();

/**
 * Reads a pull request query as of a host revision (its `updatedAt`, plus any explicit refresh):
 * the first read under a revision other than the one last read refetches it. A read already in
 * flight settles first, since interrupting a mutation's refresh can leave SWR showing the value
 * from before the mutation.
 */
const revisionedRead = Atom.family(<A, E>(source: Atom.Atom<AsyncResult.AsyncResult<A, E>>) =>
  Atom.family((revision: string) =>
    Atom.transform(
      source,
      (get) => {
        get.subscribe(source, (value) => get.setSelf(value));
        let readUnder = revisionReadBySource.get(source);
        if (readUnder === undefined) {
          readUnder = new WeakMap();
          revisionReadBySource.set(source, readUnder);
        }
        const previous = readUnder.get(get.registry);
        readUnder.set(get.registry, revision);
        const current = get.once(source);
        if (previous === undefined || previous === revision) return current;
        if (!current.waiting) {
          get.refresh(source);
        } else {
          const release = get.registry.subscribe(source, (value) => {
            if (value.waiting) return;
            release();
            get.registry.refresh(source);
          });
          get.addFinalizer(release);
        }
        return get.once(source);
      },
      { initialValueTarget: source },
    ),
  ),
);

export function readAtRevision<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  revision: string | null,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  if (revision === null) return source;
  return (revisionedRead(source) as (revision: string) => Atom.Atom<AsyncResult.AsyncResult<A, E>>)(
    revision,
  );
}

const hostRefreshCountAtom = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`web-pull-requests:host-refreshes:${key}`)),
);

/**
 * How many times this pull request was refreshed from its host, on its own or with every pull
 * request in its environment. Reads taken at it refetch after each refresh.
 */
export function usePullRequestHostRefreshes(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): string {
  const environmentRefreshes = useAtomValue(hostRefreshCountAtom(`environment:${environmentId}`));
  const pullRequestRefreshes = useAtomValue(
    hostRefreshCountAtom(pullRequestSummaryKey(environmentId, reference)),
  );
  return `${environmentRefreshes}.${pullRequestRefreshes}`;
}

/** Moves the pull request to a new revision, so its detail, stack, activity, diff and viewed files refetch. */
export function notePullRequestRefreshedFromHost(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): void {
  registry.update(
    hostRefreshCountAtom(pullRequestSummaryKey(environmentId, reference)),
    (n) => n + 1,
  );
}

/** Moves every pull request of the environment to a new revision, after invalidating them all. */
export function notePullRequestsRefreshedFromHost(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
): void {
  registry.update(hostRefreshCountAtom(`environment:${environmentId}`), (n) => n + 1);
}

export const linkedPullRequestDetailAtom = createLinkedPullRequestSummaryAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
  ({ environmentId, input }, summary, registry) =>
    Effect.map(Clock.currentTimeMillis, (observedAt) =>
      observePullRequestSummary(
        registry,
        pullRequestSummaryKey(environmentId, input),
        summary,
        observedAt,
      ),
    ),
);

export function threadPullRequestLinkToSummary(
  link: ThreadPullRequestLink,
  projectId: ProjectId,
): PullRequestSummary | null {
  const updatedAt = link.snapshot?.updatedAt;
  if (link.snapshot === null || updatedAt == null) return null;
  return {
    ...link.snapshot,
    provider: (
      sourceControlClients.findByChangeRequestUrl(link.url) ?? sourceControlClients.get(undefined)
    ).kind,
    projectId,
    repository: link.repository,
    number: link.number,
    url: link.url,
    updatedAt,
  };
}

function savedPullRequestKey(
  environmentId: EnvironmentId,
  reference: Pick<PullRequestRef, "host" | "repository" | "number">,
): string {
  return reference.host === undefined
    ? ""
    : `${environmentId}:${threadPullRequestKeyOf({ ...reference, host: reference.host })}`;
}

const savedPullRequestSummariesAtom = Atom.make((get) => {
  const summaries = new Map<string, PullRequestSummary>();
  for (const thread of get(environmentThreadShells.threadShellsAtom)) {
    for (const link of visibleThreadPullRequests(thread.pullRequests)) {
      const summary = threadPullRequestLinkToSummary(link, thread.projectId);
      if (summary === null) continue;
      const key = savedPullRequestKey(thread.environmentId, link);
      summaries.set(key, newestPullRequestSummary(summaries.get(key) ?? null, summary) ?? summary);
    }
  }
  return summaries;
});

const savedPullRequestSummaryAtom = Atom.family((key: string) =>
  Atom.make((get) => get(savedPullRequestSummariesAtom).get(key) ?? null).pipe(
    Atom.withEquality((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    Atom.setIdleTTL(5 * 60_000),
  ),
);

export function observedPullRequestTitle(
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
  reference: PullRequestRef,
): string | null {
  return (
    registry.get(observedPullRequestSummaryAtom(pullRequestSummaryKey(environmentId, reference)))
      ?.summary.title ?? null
  );
}

/** The newest of every list, detail, checks and linked-summary answer and the thread's saved link. */
export function useSharedPullRequestSummary(
  environmentId: EnvironmentId | null,
  reference: PullRequestRef | null,
): PullRequestSummary | null {
  const key =
    environmentId === null || reference === null
      ? "none"
      : pullRequestSummaryKey(environmentId, reference);
  const observed = useAtomValue(observedPullRequestSummaryAtom(key));
  const saved = useAtomValue(
    savedPullRequestSummaryAtom(
      environmentId === null || reference === null
        ? ""
        : savedPullRequestKey(environmentId, reference),
    ),
  );
  return newestPullRequestSummary(observed?.summary ?? null, saved);
}
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  pullRequestEnvironment.refreshes,
);

export interface EnvironmentQueryTarget<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

interface MergedEnvironmentQueryView<A> {
  readonly values: ReadonlyArray<readonly [EnvironmentId, A]>;
  readonly error: string | null;
  readonly isPending: boolean;
}

// Use one derived atom for variable fan-out; unreachable environments must not hide other rows.
function createMergedEnvironmentQuery<Input, A>(
  label: string,
  atomFor: (
    target: EnvironmentQueryTarget<Input>,
  ) => Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
) {
  const family = Atom.family((key: string) =>
    Atom.make((get): MergedEnvironmentQueryView<A> => {
      const targets = JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>;
      const values: Array<readonly [EnvironmentId, A]> = [];
      let error: string | null = null;
      let isPending = false;
      for (const target of targets) {
        const result = get(atomFor(target));
        isPending ||= result.waiting;
        if (result._tag === "Failure" && error === null) {
          error = formatEnvironmentQueryError(result.cause);
        }
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value !== null) values.push([target.environmentId, value]);
      }
      return { values, error, isPending };
    }).pipe(Atom.withLabel(`${label}:${key}`)),
  );
  const empty = Atom.make<MergedEnvironmentQueryView<A>>({
    values: [],
    error: null,
    isPending: false,
  }).pipe(Atom.withLabel(`${label}:empty`));
  return function useMergedQuery(targets: ReadonlyArray<EnvironmentQueryTarget<Input>>) {
    const key = JSON.stringify(targets);
    const view = useAtomValue(targets.length === 0 ? empty : family(key));
    const refresh = (override?: ReadonlyArray<EnvironmentQueryTarget<Input>>) => {
      const refreshTargets =
        override ?? (JSON.parse(key) as ReadonlyArray<EnvironmentQueryTarget<Input>>);
      for (const atom of new Set(refreshTargets.map(atomFor))) {
        appAtomRegistry.refresh(atom);
      }
    };
    return { ...view, refresh };
  };
}

const usePullRequestListsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list",
  pullRequestEnvironment.list,
);

const usePullRequestStatsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:list-stats",
  pullRequestEnvironment.listStats,
);

const usePullRequestFilterOptionsQuery = createMergedEnvironmentQuery(
  "web-pull-requests:filter-options",
  pullRequestEnvironment.filterOptions,
);

const usePullRequestTurnRefreshQuery = createMergedEnvironmentQuery(
  "web-pull-requests:turn-refreshes",
  ({ environmentId }: EnvironmentQueryTarget<Readonly<Record<string, never>>>) =>
    pullRequestEnvironment.refreshes({ environmentId, input: {} }),
);

export function usePullRequestTurnRefreshes(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<readonly [EnvironmentId, number]> {
  return usePullRequestTurnRefreshQuery(
    environmentIds.map((environmentId) => ({ environmentId, input: {} })),
  ).values;
}

export function usePullRequestTurnRefresh(environmentId: EnvironmentId): number | null {
  const result = useAtomValue(pullRequestEnvironment.refreshes({ environmentId, input: {} }));
  return Option.getOrNull(AsyncResult.value(result));
}

export interface MergedPullRequestListView {
  readonly data: MergedPullRequestList | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: (targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>) => void;
}

export function usePullRequestList(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListInput>>,
): MergedPullRequestListView {
  const query = usePullRequestListsQuery(targets);
  const data = mergePullRequestLists(query.values);
  return { data, error: query.error, isPending: query.isPending, refresh: query.refresh };
}

export function usePullRequestListStats(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
): {
  readonly stats: ReadonlyArray<EnvironmentPullRequestStat> | null;
  readonly isPending: boolean;
  readonly refresh: (
    targets?: ReadonlyArray<EnvironmentQueryTarget<PullRequestListStatsInput>>,
  ) => void;
} {
  const query = usePullRequestStatsQuery(targets);
  const stats =
    query.values.length === 0
      ? null
      : query.values.flatMap(([environmentId, result]) =>
          result.stats.map((stat) => ({ ...stat, environmentId })),
        );
  return { stats, isPending: query.isPending, refresh: query.refresh };
}

export function usePullRequestFilterOptions(
  targets: ReadonlyArray<EnvironmentQueryTarget<PullRequestFilterOptionsInput>>,
) {
  const query = usePullRequestFilterOptionsQuery(targets);
  return {
    labels: query.values.flatMap(([, options]) => options.labels),
    authors: query.values.flatMap(([, options]) => options.authors),
    error: query.error,
    isPending: query.isPending,
  };
}
