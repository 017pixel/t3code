import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestDiffResult,
  type PullRequestListEntry,
} from "@t3tools/contracts";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { usePullToRefresh } from "../../state/use-pull-to-refresh";
import type { ReviewParsedDiff } from "../review/reviewModel";
import {
  getCachedPullRequestDiffPages,
  parsePullRequestDiffPage,
  requestPullRequestDiffPaths,
  walkPullRequestDiffPages,
} from "./pullRequestDiffPages";

export type PullRequestParams = {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly number: number;
  readonly host?: string;
  readonly initialSummary?: PullRequestListEntry;
};

export type PullRequestDiffParams = PullRequestParams & { readonly commit?: string };

export function pullRequestTarget(params: PullRequestParams) {
  return {
    environmentId: EnvironmentId.make(params.environmentId),
    input: {
      projectId: ProjectId.make(params.projectId),
      repository: params.repository,
      number: params.number,
      ...(params.host ? { host: params.host } : {}),
    },
  };
}

type PullRequestDiffTarget = ReturnType<typeof pullRequestTarget> & {
  readonly input: { readonly commit?: string };
};

export function usePullRequestDiffEntry(navigation: {
  readonly addListener: (
    type: "transitionStart" | "transitionEnd",
    listener: (event: { readonly data: { readonly closing: boolean } }) => void,
  ) => () => void;
}) {
  const [ready, setReady] = useState(false);
  // The loading shell renders only until the diff opens, so its element owns the wait.
  const attachShell = (node: object | null) => {
    if (node === null) return;
    let opening = false;
    let closing = false;
    const finish = () => {
      if (!closing) setReady(true);
    };
    const removeStart = navigation.addListener("transitionStart", ({ data }) => {
      closing = data.closing;
      if (!closing) opening = true;
    });
    const removeEnd = navigation.addListener("transitionEnd", ({ data }) => {
      closing = data.closing;
      if (!closing) finish();
    });
    // Initial and unanimated presentations may have no transition events; let the shell paint first.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        if (!opening) finish();
      });
    });
    // A missing native completion must not strand the route on its loading state.
    const fallback = setTimeout(finish, 1_000);
    return () => {
      removeStart();
      removeEnd();
      cancelAnimationFrame(frame);
      clearTimeout(fallback);
    };
  };
  return { ready, attachShell };
}

const pageTarget = (target: PullRequestDiffTarget, cursor: string | null) => ({
  ...target,
  input: { ...target.input, ...(cursor ? { cursor } : {}) },
});

// Pages parse once however many readers combine them; each answer is its own object.
const parseCache = new WeakMap<PullRequestDiffResult, ReviewParsedDiff>();

// Reads the cached pages in order and mounts the next one a reader still needs, so paging toward
// a wanted file continues as each page lands, without the screen asking again.
const diffPagesFamily = Atom.family((key: string) => {
  const [target, count, wanted] = JSON.parse(key) as [
    PullRequestDiffTarget,
    number,
    readonly string[],
  ];
  const scope = JSON.stringify(target);
  return Atom.make((get) =>
    walkPullRequestDiffPages(
      (cursor) =>
        Option.getOrNull(
          AsyncResult.value(get(composerPullRequests.diff(pageTarget(target, cursor)))),
        ),
      count,
      wanted,
      (page) => {
        const parsed = parsePullRequestDiffPage(page, parseCache, scope);
        return parsed.kind === "files" ? parsed.files.map((file) => file.path) : [];
      },
    ),
  );
});

const NO_PATHS: readonly string[] = [];

/** `wantedPaths` keeps paging until those files have loaded or the diff ends. */
export function usePullRequestDiff(
  params: PullRequestDiffParams,
  terminology: ChangeRequestTerminology,
  wantedPaths: readonly string[] = NO_PATHS,
) {
  const reference = pullRequestTarget(params);
  const target: PullRequestDiffTarget = {
    ...reference,
    input: { ...reference.input, ...(params.commit ? { commit: params.commit } : {}) },
  };
  const key = JSON.stringify(target);
  const firstPageAtom = composerPullRequests.diff(target);
  const refreshFirstPage = useAtomRefresh(firstPageAtom);
  const { refreshing, onRefresh } = usePullToRefresh(firstPageAtom);
  const [stored, setRequested] = useState(() => ({ key, count: 1, wanted: wantedPaths }));
  // React's adjust-state-while-rendering form: the request outlives a single wanted path.
  const requested = requestPullRequestDiffPaths(stored, key, wantedPaths);
  if (requested !== stored) setRequested(requested);
  const { pages, frontier } = useAtomValue(
    diffPagesFamily(JSON.stringify([target, requested.count, requested.wanted])),
  );
  const query = useEnvironmentQuery(composerPullRequests.diff(pageTarget(target, frontier)));
  const parsed = getCachedPullRequestDiffPages(pages, key, terminology, parseCache);
  const patch = pages.map((page) => page.result.patch).join("\n");
  const nextCursor = pages.at(-1)?.result.nextCursor ?? null;
  const canLoadMore = nextCursor !== null && !query.isPending && query.error === null;
  const loadMore = () => {
    if (canLoadMore) setRequested({ ...requested, count: pages.length + 1 });
  };
  const refresh = () => {
    // A failed continuation retries alone, keeping the pages already loaded.
    if (frontier !== null && query.error !== null) {
      query.refresh();
      return;
    }
    setRequested({ key, count: 1, wanted: wantedPaths });
    refreshFirstPage();
    if (frontier !== null) query.refresh();
  };
  const onPullRefresh = () => {
    setRequested({ key, count: 1, wanted: wantedPaths });
    onRefresh();
  };
  return {
    ...query,
    refresh,
    parsed,
    patch,
    nextCursor,
    canLoadMore,
    loadMore,
    refreshing,
    onPullRefresh,
  };
}
