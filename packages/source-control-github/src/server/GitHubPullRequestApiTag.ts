// @effect-diagnostics deterministicKeys:off -- Preserve the service key while moving its lazy interface.
import { cacheInOwnerScope } from "@t3tools/shared/lazyService";
import type { makeChecksRevalidator } from "./gitHubConditionalChecks.ts";
import type { GitHubStackActionError } from "./githubStackActions.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  PullRequestAction,
  PullRequestStackHead,
  PullRequestFileViewed,
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestOmittedFileStat,
  PullRequestReactionContent,
  PullRequestReviewCommentDraft,
  PullRequestReviewVerdict,
  PullRequestReviewerCandidateList,
  PullRequestReviewerKind,
  PullRequestLabelCandidateList,
  PullRequestThreadCommentsResult,
  PullRequestUpdateMethod,
  PullRequestPreview,
} from "@t3tools/contracts";
import type * as GitHubApi from "./GitHubApiTag.ts";
import type * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import type {
  GitHubPullRequestCore,
  GitHubPullRequestWatchFingerprint,
  GitHubPullRequestActivity,
  GitHubPullRequestListItem,
  GitHubPullRequestSearchItem,
  GitHubPullRequestStack,
  GitHubReviewThreadComments,
  GitHubRepositoryAccess,
  GitHubWorkflowRunApproval,
  GitHubViewerAccess,
} from "./gitHubPullRequestJson.ts";
import type {
  ProviderChangeRequestSummary,
  ProviderListCursor,
} from "@t3tools/source-control-core/server/PullRequestProvider";

export class GitHubPullRequestReadError extends Schema.TaggedError<GitHubPullRequestReadError>()(
  "GitHubPullRequestReadError",
  {
    cwd: Schema.String,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `GitHub returned an unreadable ${this.operation} response.`;
  }
}

/** Not a decode failure: GitHub answered, the account it answered for just has no login. */
export class GitHubViewerLoginUnavailableError extends Schema.TaggedError<GitHubViewerLoginUnavailableError>()(
  "GitHubViewerLoginUnavailableError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "GitHub returned no login for the authenticated account.";
  }
}

/** Not a decode failure: GitHub answered, but the pull request carried no update time. */
export class GitHubPullRequestUpdatedAtUnavailableError extends Schema.TaggedError<GitHubPullRequestUpdatedAtUnavailableError>()(
  "GitHubPullRequestUpdatedAtUnavailableError",
  {
    cwd: Schema.String,
    repository: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `Pull request ${this.repository}#${this.number} reported no update time.`;
  }
}

/** Not a decode failure: the reader asked to carry on from a cursor this walk never handed out. */
export class GitHubDiffCursorError extends Schema.TaggedError<GitHubDiffCursorError>()(
  "GitHubDiffCursorError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The diff cursor was not one this pull request handed out.";
  }
}

/** Not a decode failure: the reader named a commit that is not a sha this repository could hold. */
export class GitHubDiffCommitError extends Schema.TaggedError<GitHubDiffCommitError>()(
  "GitHubDiffCommitError",
  {
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return "The named commit was not a commit sha.";
  }
}

/** The revisions read successfully, but cannot name both sides this file needs. */
export class GitHubDiffRevisionsUnavailableError extends Schema.TaggedError<GitHubDiffRevisionsUnavailableError>()(
  "GitHubDiffRevisionsUnavailableError",
  {
    cwd: Schema.String,
    number: Schema.Int,
    commit: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.commit === undefined
      ? `Pull request #${this.number} reported no usable base and head revisions.`
      : `Commit ${this.commit} reported no usable revisions for this file.`;
  }
}

/** A blob exists, but expanding it would be unsafe or would not produce text. */
export class GitHubDiffFileContentsUnavailableError extends Schema.TaggedError<GitHubDiffFileContentsUnavailableError>()(
  "GitHubDiffFileContentsUnavailableError",
  {
    cwd: Schema.String,
    path: Schema.String,
    reason: Schema.Literals(["oversized", "binary"]),
  },
) {
  override get message(): string {
    return this.reason === "oversized"
      ? `The diff file '${this.path}' exceeds the 1 MB expansion limit.`
      : `The diff file '${this.path}' is binary.`;
  }
}

/**
 * Not a decode failure: a repository was named that cannot go into a search or into a GraphQL
 * document as itself. Every qualifier and every alias below is composed from `owner/name`, so a
 * name that is not one is refused here rather than escaped into something GitHub might read as a
 * qualifier of its own.
 */
export class GitHubRepositorySelectorError extends Schema.TaggedError<GitHubRepositorySelectorError>()(
  "GitHubRepositorySelectorError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "A repository was named that GitHub cannot address.";
  }
}

/** Not a decode failure: the reader named a subject this pull request never handed out. */
export class GitHubSubjectScopeError extends Schema.TaggedError<GitHubSubjectScopeError>()(
  "GitHubSubjectScopeError",
  {
    cwd: Schema.String,
    operation: Schema.String,
  },
) {
  override get message(): string {
    return "The named subject did not belong to the named pull request.";
  }
}

/** GitHub answered successfully, but approving every returned workflow would be unsafe. */
export class GitHubWorkflowApprovalRefusedError extends Schema.TaggedError<GitHubWorkflowApprovalRefusedError>()(
  "GitHubWorkflowApprovalRefusedError",
  {
    cwd: Schema.String,
    number: Schema.Int,
    reason: Schema.Literals(["head-list-truncated", "head-not-unique", "run-list-truncated"]),
    observedCount: Schema.Int,
    limit: Schema.Int,
  },
) {
  override get message(): string {
    if (this.reason === "head-list-truncated") {
      return `GitHub returned more than ${this.limit} pull requests for this head branch.`;
    }
    if (this.reason === "head-not-unique") {
      return `The head revision matched ${this.observedCount} pull requests instead of uniquely matching #${this.number}.`;
    }
    return `GitHub returned more than ${this.limit} workflow runs awaiting approval.`;
  }
}

/** GitHub omitted the immutable head identity needed to scope an approval safely. */
export class GitHubWorkflowApprovalHeadUnavailableError extends Schema.TaggedError<GitHubWorkflowApprovalHeadUnavailableError>()(
  "GitHubWorkflowApprovalHeadUnavailableError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `GitHub did not report a complete head revision for #${this.number}.`;
  }
}

/** The pull request moved after its approval candidates were read. */
export class GitHubWorkflowApprovalHeadChangedError extends Schema.TaggedError<GitHubWorkflowApprovalHeadChangedError>()(
  "GitHubWorkflowApprovalHeadChangedError",
  {
    cwd: Schema.String,
    number: Schema.Int,
  },
) {
  override get message(): string {
    return `The head revision of #${this.number} changed before its workflows could be approved.`;
  }
}

export type GitHubPullRequestApiError =
  | GitHubStackActionError
  | GitHubApi.GitHubApiError
  | GitHubPullRequestReadError
  | GitHubDiffCursorError
  | GitHubDiffCommitError
  | GitHubDiffRevisionsUnavailableError
  | GitHubDiffFileContentsUnavailableError
  | GitHubRepositorySelectorError
  | GitHubSubjectScopeError
  | GitHubWorkflowApprovalRefusedError
  | GitHubWorkflowApprovalHeadUnavailableError
  | GitHubWorkflowApprovalHeadChangedError
  | SourceControlRateLimit.SourceControlRateLimitPausedError
  | GitHubViewerLoginUnavailableError
  | GitHubPullRequestUpdatedAtUnavailableError;

export const NODE_ID_CACHE_CAPACITY = 128;

export interface GitHubPullRequestListBatch {
  readonly items: ReadonlyArray<GitHubPullRequestListItem>;
  readonly truncated: boolean;
  /** False for a page GitHub would not search, which came back in `gh`'s own order instead. */
  readonly continues: boolean;
}

export interface GitHubPullRequestStat {
  readonly repository: string;
  readonly number: number;
  readonly additions: number;
  readonly deletions: number;
}

export interface GitHubPullRequestSearchBatch {
  /** Rows across every repository asked for, newest update first, each naming its own. */
  readonly items: ReadonlyArray<GitHubPullRequestSearchItem>;
  readonly truncated: boolean;
}

export interface GitHubPullRequestDiffSlice {
  readonly patch: string;
  /** Files in this slice had their hunks withheld, as opposed to there being more slices. */
  readonly truncated: boolean;
  /** Where the next slice starts, or null once the patch is whole. */
  readonly nextCursor: string | null;
  /** GitHub's own counts for the files whose hunks it withheld from this slice. */
  readonly omittedFileStats?: ReadonlyArray<PullRequestOmittedFileStat>;
}

export interface GitHubPullRequestFilesViewed {
  readonly files: ReadonlyArray<PullRequestFileViewed>;
  /** GitHub had more files than the page budget below would read. */
  readonly truncated: boolean;
}

export class GitHubPullRequestApi extends Context.Service<
  GitHubPullRequestApi,
  {
    readonly withVerifiedCredential: <A, E, R>(
      input: { readonly cwd: string; readonly host: string },
      use: (identity: {
        readonly accountId: string;
        readonly viewer: string;
        readonly credentialFingerprint: string;
      }) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | GitHubPullRequestApiError, R>;
    readonly getRoutingIdentity: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<
      { readonly accountId: string; readonly viewer: string },
      GitHubPullRequestApiError
    >;
    readonly getViewerLogin: (input: {
      readonly cwd: string;
      readonly host: string;
    }) => Effect.Effect<string, GitHubPullRequestApiError>;

    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      /** Free text for `--search`, matched as one literal phrase. */
      readonly query?: string | undefined;
      /** Where to carry on from, as a `updated:` qualifier on the same search. */
      readonly cursor?: ProviderListCursor | undefined;
      /** Further narrowings, as qualifiers on the search and as a local pass on the fallback. */
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestListBatch, GitHubPullRequestApiError>;

    /**
     * The same listing for a whole host in one search. `limit` is the size of the slice across
     * all of the repositories rather than per repository, because that is what a search answers:
     * the newest rows of the lot, which is exactly the page.
     */
    readonly searchPullRequests: (input: {
      /** Any checkout on the host; the search names its repositories itself. */
      readonly cwd: string;
      readonly host: string;
      readonly repositories: ReadonlyArray<string>;
      readonly state: PullRequestListState;
      readonly involvement: PullRequestInvolvement;
      readonly viewer: string;
      readonly limit: number;
      readonly query?: string | undefined;
      readonly cursor?: ProviderListCursor | undefined;
      readonly filters?: PullRequestListFilters | undefined;
    }) => Effect.Effect<GitHubPullRequestSearchBatch, GitHubPullRequestApiError>;

    /** The line counts the search leaves out, for rows already on the page. */
    readonly listPullRequestStats: (input: {
      readonly cwd: string;
      readonly host: string;
      readonly changeRequests: ReadonlyArray<{
        readonly repository: string;
        readonly number: number;
      }>;
    }) => Effect.Effect<ReadonlyArray<GitHubPullRequestStat>, GitHubPullRequestApiError>;

    readonly getPullRequestSummary: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<ProviderChangeRequestSummary, GitHubPullRequestApiError>;
    /**
     * What a watch compares between passes, batched like summaries. Null when GitHub gave no
     * answer for this pull request, so the watch reads it in full instead.
     */
    readonly getPullRequestWatchFingerprint: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestWatchFingerprint | null, GitHubPullRequestApiError>;

    readonly revalidateChecks: Effect.Success<typeof makeChecksRevalidator>;

    readonly getPullRequestDetail: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestCore, GitHubPullRequestApiError>;

    readonly getPullRequestPreview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<
      Omit<PullRequestPreview, "projectId" | "repository">,
      GitHubPullRequestApiError
    >;

    readonly listWorkflowRunsRequiringApproval: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly headSha: string;
      readonly headBranch: string;
      readonly headRepositoryOwner: string;
      readonly isCrossRepository: true;
    }) => Effect.Effect<ReadonlyArray<GitHubWorkflowRunApproval>, GitHubPullRequestApiError>;

    /**
     * The host-native stack this pull request is in, or null when it is in none — which is also
     * the answer for a host that refuses the stacks preview altogether.
     */
    readonly getPullRequestStack: (input: {
      readonly cwd: string;
      readonly includeDetails?: boolean;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestStack | null, GitHubPullRequestApiError>;

    readonly getPullRequestActivity: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestActivity, GitHubPullRequestApiError>;

    readonly getPullRequestDiff: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Absent asks for the first slice; anything else is a cursor a slice handed back. */
      readonly cursor?: string | undefined;
      /** One commit's own changes, rather than everything the pull request carries. */
      readonly commit?: string | undefined;
    }) => Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError>;

    readonly getPullRequestDiffFileContents: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commit?: string | undefined;
      readonly changeType: "change" | "rename-pure" | "rename-changed" | "new" | "deleted";
      readonly oldPath: string;
      readonly newPath: string;
    }) => Effect.Effect<
      { readonly oldContents: string; readonly newContents: string },
      GitHubPullRequestApiError
    >;

    /**
     * Which files of the pull request the signed-in account has cleared, and which of those have
     * been pushed to since. Read apart from the patch because GitHub only reports it over GraphQL.
     */
    readonly getPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubPullRequestFilesViewed, GitHubPullRequestApiError>;

    /**
     * Clears files, or puts them back, as one request. GitHub takes a single path per mutation,
     * so a burst is batched with aliases into one document rather than one subprocess per press.
     */
    readonly setPullRequestFilesViewed: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly files: ReadonlyArray<{ readonly path: string; readonly viewed: boolean }>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly listReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<GitHubReviewThreadComments, GitHubPullRequestApiError>;

    /** One request for a listing's authors, since no `gh` JSON field reports an avatar. */
    readonly listActorAvatars: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly ids: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyMap<string, string>, GitHubPullRequestApiError>;

    readonly getReviewThreadComments: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly threadId: string;
      readonly cursor: string;
    }) => Effect.Effect<PullRequestThreadCommentsResult, GitHubPullRequestApiError>;

    /** The viewer's standing on its own, for deciding a write without reading the whole detail. */
    readonly getViewerAccess: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      /** Manual action checks may use the quota held back from automatic reads. */
      readonly allowReserve?: boolean | undefined;
    }) => Effect.Effect<GitHubViewerAccess & GitHubRepositoryAccess, GitHubPullRequestApiError>;

    /** Who this pull request may be sent to, and who it has already been sent to. */
    readonly listReviewerCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestReviewerCandidateList, GitHubPullRequestApiError>;

    readonly setReviewerRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly reviewers: ReadonlyArray<{
        readonly id: string;
        readonly kind: PullRequestReviewerKind;
      }>;
      /** False deletes the same collection a request posts to, which takes the request back. */
      readonly requested: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    /** The repository's labels, and which of them this pull request already wears. */
    readonly listLabelCandidates: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
    }) => Effect.Effect<PullRequestLabelCandidateList, GitHubPullRequestApiError>;

    readonly setLabels: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly labels: ReadonlyArray<string>;
      /** False takes each label off; true adds each to whatever is already there. */
      readonly applied: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly runPullRequestAction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly action: PullRequestAction;
      readonly stackNumber?: number;
      readonly expectedStackHeads?: ReadonlyArray<PullRequestStackHead>;
      readonly removeAgentCreditsOnMerge?: boolean;
      readonly mergeMethod?: PullRequestMergeMethod;
      readonly updateMethod?: PullRequestUpdateMethod;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly commentOnPullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly submitReview: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly verdict: PullRequestReviewVerdict;
      readonly body: string;
      readonly comments: ReadonlyArray<PullRequestReviewCommentDraft>;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly replyToReviewThread: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    readonly setReviewThreadResolution: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly threadId: string;
      readonly resolved: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    /**
     * Adds a reaction to a remark, or takes it back. `subjectId` is any node GitHub calls
     * reactable — a comment, a review, or the pull request itself, which is looked up here
     * because nothing in the conversation names it. A given `subjectId` is confirmed to belong
     * to this pull request before the mutation runs, since nothing else ties the two together.
     */
    readonly setReaction: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly subjectId?: string | undefined;
      readonly content: PullRequestReactionContent;
      readonly reacted: boolean;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    /** Rewrites the pull request's own words, leaving whichever of the two was not given. */
    readonly updatePullRequest: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;

    /**
     * Rewrites a remark. `commentId` is trusted to be whatever node it names, so it is confirmed
     * to belong to this pull request before the mutation runs, the way a reaction subject is.
     * Whether the remark is the reader's to rewrite is GitHub's own answer, not one asked here.
     */
    readonly updateComment: (input: {
      readonly cwd: string;
      readonly repository: string;
      readonly host: string;
      readonly number: number;
      readonly commentId: string;
      readonly kind: "issue-comment" | "review-comment";
      readonly body: string;
    }) => Effect.Effect<void, GitHubPullRequestApiError>;
  }
>()("@t3tools/source-control-github/server/GitHubPullRequestApi") {}

export const make = Effect.gen(function* () {
  const live = yield* cacheInOwnerScope(
    Effect.promise(() => import("./GitHubPullRequestApi.ts")).pipe(
      Effect.flatMap((module) => module.make),
    ),
  );
  return GitHubPullRequestApi.of({
    withVerifiedCredential: (input, use) =>
      live.pipe(Effect.flatMap((value) => value.withVerifiedCredential(input, use))),
    getRoutingIdentity: (input) =>
      live.pipe(Effect.flatMap((value) => value.getRoutingIdentity(input))),
    getViewerLogin: (input) => live.pipe(Effect.flatMap((value) => value.getViewerLogin(input))),
    listPullRequests: (input) =>
      live.pipe(Effect.flatMap((value) => value.listPullRequests(input))),
    searchPullRequests: (input) =>
      live.pipe(Effect.flatMap((value) => value.searchPullRequests(input))),
    listPullRequestStats: (input) =>
      live.pipe(Effect.flatMap((value) => value.listPullRequestStats(input))),
    getPullRequestSummary: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestSummary(input))),
    getPullRequestWatchFingerprint: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestWatchFingerprint(input))),
    revalidateChecks: (input, read) =>
      live.pipe(Effect.flatMap((value) => value.revalidateChecks(input, read))),
    getPullRequestDetail: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestDetail(input))),
    getPullRequestPreview: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestPreview(input))),
    listWorkflowRunsRequiringApproval: (input) =>
      live.pipe(Effect.flatMap((value) => value.listWorkflowRunsRequiringApproval(input))),
    getPullRequestStack: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestStack(input))),
    getPullRequestActivity: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestActivity(input))),
    getPullRequestDiff: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestDiff(input))),
    getPullRequestDiffFileContents: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestDiffFileContents(input))),
    getPullRequestFilesViewed: (input) =>
      live.pipe(Effect.flatMap((value) => value.getPullRequestFilesViewed(input))),
    setPullRequestFilesViewed: (input) =>
      live.pipe(Effect.flatMap((value) => value.setPullRequestFilesViewed(input))),
    listReviewThreadComments: (input) =>
      live.pipe(Effect.flatMap((value) => value.listReviewThreadComments(input))),
    listActorAvatars: (input) =>
      live.pipe(Effect.flatMap((value) => value.listActorAvatars(input))),
    getReviewThreadComments: (input) =>
      live.pipe(Effect.flatMap((value) => value.getReviewThreadComments(input))),
    getViewerAccess: (input) => live.pipe(Effect.flatMap((value) => value.getViewerAccess(input))),
    listReviewerCandidates: (input) =>
      live.pipe(Effect.flatMap((value) => value.listReviewerCandidates(input))),
    setReviewerRequest: (input) =>
      live.pipe(Effect.flatMap((value) => value.setReviewerRequest(input))),
    listLabelCandidates: (input) =>
      live.pipe(Effect.flatMap((value) => value.listLabelCandidates(input))),
    setLabels: (input) => live.pipe(Effect.flatMap((value) => value.setLabels(input))),
    runPullRequestAction: (input) =>
      live.pipe(Effect.flatMap((value) => value.runPullRequestAction(input))),
    commentOnPullRequest: (input) =>
      live.pipe(Effect.flatMap((value) => value.commentOnPullRequest(input))),
    submitReview: (input) => live.pipe(Effect.flatMap((value) => value.submitReview(input))),
    replyToReviewThread: (input) =>
      live.pipe(Effect.flatMap((value) => value.replyToReviewThread(input))),
    setReviewThreadResolution: (input) =>
      live.pipe(Effect.flatMap((value) => value.setReviewThreadResolution(input))),
    setReaction: (input) => live.pipe(Effect.flatMap((value) => value.setReaction(input))),
    updatePullRequest: (input) =>
      live.pipe(Effect.flatMap((value) => value.updatePullRequest(input))),
    updateComment: (input) => live.pipe(Effect.flatMap((value) => value.updateComment(input))),
  });
});
export const layer = Layer.effect(GitHubPullRequestApi, make);
