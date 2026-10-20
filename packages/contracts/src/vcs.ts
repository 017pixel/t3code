import * as Schema from "effect/Schema";
import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const VcsDriverKind = Schema.Literals(["git", "jj", "unknown"]);
export type VcsDriverKind = typeof VcsDriverKind.Type;

export const VcsFreshnessSource = Schema.Literals([
  "live-local",
  "cached-local",
  "cached-remote",
  "explicit-remote",
]);
export type VcsFreshnessSource = typeof VcsFreshnessSource.Type;

export const VcsFreshness = Schema.Struct({
  source: VcsFreshnessSource,
  observedAt: Schema.DateTimeUtc,
  expiresAt: Schema.Option(Schema.DateTimeUtc),
});
export type VcsFreshness = typeof VcsFreshness.Type;

export const VcsDriverCapabilities = Schema.Struct({
  kind: VcsDriverKind,
  supportsWorktrees: Schema.Boolean,
  supportsBookmarks: Schema.Boolean,
  supportsAtomicSnapshot: Schema.Boolean,
  supportsPushDefaultRemote: Schema.Boolean,
  ignoreClassifier: Schema.Literals(["native", "git-compatible-fallback"]),
});
export type VcsDriverCapabilities = typeof VcsDriverCapabilities.Type;

export const VcsRepositoryIdentity = Schema.Struct({
  kind: VcsDriverKind,
  rootPath: TrimmedNonEmptyString,
  metadataPath: Schema.NullOr(TrimmedNonEmptyString),
  freshness: VcsFreshness,
});
export type VcsRepositoryIdentity = typeof VcsRepositoryIdentity.Type;

export const VcsListWorkspaceFilesResult = Schema.Struct({
  paths: Schema.Array(TrimmedNonEmptyString),
  truncated: Schema.Boolean,
  freshness: VcsFreshness,
});
export type VcsListWorkspaceFilesResult = typeof VcsListWorkspaceFilesResult.Type;

export const VcsRemote = Schema.Struct({
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  pushUrl: Schema.Option(TrimmedNonEmptyString),
  isPrimary: Schema.Boolean,
});
export type VcsRemote = typeof VcsRemote.Type;

export const VcsListRemotesResult = Schema.Struct({
  remotes: Schema.Array(VcsRemote),
  freshness: VcsFreshness,
});
export type VcsListRemotesResult = typeof VcsListRemotesResult.Type;

export interface VcsProcessErrorContext {
  readonly operation: string;
  readonly command: string;
  readonly cwd: string;
  readonly argumentCount?: number;
}

export interface VcsProcessSpawnFailure {
  readonly cause: unknown;
}

export interface VcsProcessTimeoutFailure {
  readonly timeoutMs: number;
}

export const VcsProcessExitFailureKind = Schema.Literals([
  "authentication",
  "not-found",
  "rate-limited",
  "command-failed",
]);
export type VcsProcessExitFailureKind = typeof VcsProcessExitFailureKind.Type;

export interface VcsProcessExitFailure {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stderrTruncated: boolean;
}

// glab's stderr is the only clue to a self-hosted failure (a proxy 404, for
// example). It can also echo tokens, so only a short redacted excerpt may
// leave the process boundary. Other CLIs stay excerpt-free.
const GLAB_STDERR_EXCERPT_MAX_CHARS = 200;

const GLAB_STDERR_ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const GLAB_STDERR_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const GLAB_STDERR_USERINFO_PATTERN = /(https?:\/\/)[^\s/@]+:[^\s@]+@/gi;
const GLAB_STDERR_QUERY_SECRET_PATTERN =
  /([?&](?:access_token|private_token|job_token|token|password|secret)=)[^&\s]+/gi;
const GLAB_STDERR_BEARER_PATTERN = /\bBearer\s+\S+/gi;
const GLAB_STDERR_BASIC_PATTERN = /\bAuthorization:\s*Basic\s+\S+/gi;
const GLAB_STDERR_HEADER_SECRET_PATTERN =
  /\b(private-token|job-token|deploy-token|x-api-key|api-key)\s*[:=]\s*\S+/gi;
const GLAB_STDERR_ASSIGNMENT_SECRET_PATTERN =
  /\b(token|password|secret|passwd|access_token|private_token|job_token)\s*[:=]\s*\S+/gi;
const GLAB_STDERR_PREFIXED_TOKEN_PATTERN =
  /\b(?:glpat|gldt|glrt|glcbt|glsoat|gloas|glft|glagent|github_pat|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9][A-Za-z0-9-]{7,}|\bxox[baprs]-[A-Za-z0-9-]+/gi;

export function glabStderrExcerpt(stderr: string): string | undefined {
  const text = stderr
    .replace(GLAB_STDERR_ANSI_PATTERN, "")
    .replace(GLAB_STDERR_CONTROL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(GLAB_STDERR_USERINFO_PATTERN, "$1[redacted]@")
    .replace(GLAB_STDERR_QUERY_SECRET_PATTERN, "$1[redacted]")
    .replace(GLAB_STDERR_BEARER_PATTERN, "Bearer [redacted]")
    .replace(GLAB_STDERR_BASIC_PATTERN, "Authorization: Basic [redacted]")
    .replace(GLAB_STDERR_HEADER_SECRET_PATTERN, "$1 [redacted]")
    .replace(GLAB_STDERR_ASSIGNMENT_SECRET_PATTERN, "$1 [redacted]")
    .replace(GLAB_STDERR_PREFIXED_TOKEN_PATTERN, "[redacted]");
  if (text.length === 0) return undefined;
  if (text.length <= GLAB_STDERR_EXCERPT_MAX_CHARS) return text;
  return `${text.slice(0, GLAB_STDERR_EXCERPT_MAX_CHARS - 3).trimEnd()}...`;
}

export class VcsProcessSpawnError extends Schema.TaggedError<VcsProcessSpawnError>()(
  "VcsProcessSpawnError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to spawn in ${this.operation}: ${this.command} (${this.cwd})`;
  }

  static fromProcessSpawnError(context: VcsProcessErrorContext, error: VcsProcessSpawnFailure) {
    return new VcsProcessSpawnError({
      ...context,
      cause: error.cause,
    });
  }
}

export class VcsProcessExitError extends Schema.TaggedError<VcsProcessExitError>()(
  "VcsProcessExitError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    exitCode: Schema.Number,
    detail: Schema.String,
    failureKind: Schema.optional(VcsProcessExitFailureKind),
    retryable: Schema.optional(Schema.Boolean),
    stderrLength: Schema.optional(NonNegativeInt),
    stderrTruncated: Schema.optional(Schema.Boolean),
    // Set only for glab command failures. See glabStderrExcerpt.
    stderrExcerpt: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `VCS process failed in ${this.operation}: ${this.command} (${this.cwd}) exited with ${this.exitCode} - ${this.detail}`;
  }

  static fromProcessExit(
    context: VcsProcessErrorContext,
    error: VcsProcessExitFailure,
    failureKind: VcsProcessExitFailureKind,
    retryable?: boolean,
  ) {
    const detail =
      failureKind === "authentication"
        ? "Authentication failed."
        : failureKind === "rate-limited"
          ? "API rate limit exceeded."
          : failureKind === "not-found"
            ? context.command === "glab"
              ? "Merge request not found."
              : context.command === "gh" || context.command === "az"
                ? "Pull request not found."
                : "VCS resource not found."
            : "Process exited with a non-zero status.";

    // Auth and rate-limit text is where glab quotes credentials, and those
    // failures already have their own message. Keep their stderr off the error.
    const stderrExcerpt =
      context.command === "glab" &&
      (failureKind === "command-failed" || failureKind === "not-found")
        ? glabStderrExcerpt(error.stderr)
        : undefined;

    return new VcsProcessExitError({
      ...context,
      exitCode: error.exitCode,
      detail,
      failureKind,
      ...(retryable === true ? { retryable: true } : {}),
      stderrLength: error.stderr.length,
      stderrTruncated: error.stderrTruncated,
      ...(stderrExcerpt === undefined ? {} : { stderrExcerpt }),
    });
  }
}

export class VcsProcessTimeoutError extends Schema.TaggedError<VcsProcessTimeoutError>()(
  "VcsProcessTimeoutError",
  {
    operation: Schema.String,
    command: Schema.String,
    cwd: Schema.String,
    argumentCount: Schema.optional(NonNegativeInt),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `VCS process timed out in ${this.operation}: ${this.command} (${this.cwd}) after ${this.timeoutMs}ms`;
  }

  static fromProcessTimeoutError(context: VcsProcessErrorContext, error: VcsProcessTimeoutFailure) {
    return new VcsProcessTimeoutError({
      ...context,
      timeoutMs: error.timeoutMs,
    });
  }
}

const VcsProcessBoundaryErrorFields = {
  operation: Schema.String,
  command: Schema.String,
  cwd: Schema.String,
  argumentCount: Schema.optional(NonNegativeInt),
};

export class VcsProcessStdinWriteError extends Schema.TaggedError<VcsProcessStdinWriteError>()(
  "VcsProcessStdinWriteError",
  {
    ...VcsProcessBoundaryErrorFields,
    stdinBytes: NonNegativeInt,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to write ${this.stdinBytes} bytes to stdin in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputReadError extends Schema.TaggedError<VcsProcessOutputReadError>()(
  "VcsProcessOutputReadError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `VCS process failed to read ${this.stream} in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export class VcsProcessOutputLimitError extends Schema.TaggedError<VcsProcessOutputLimitError>()(
  "VcsProcessOutputLimitError",
  {
    ...VcsProcessBoundaryErrorFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: NonNegativeInt,
    observedBytes: NonNegativeInt,
  },
) {
  override get message(): string {
    return `VCS process ${this.stream} produced ${this.observedBytes} bytes in ${this.operation}: ${this.command} (${this.cwd}), exceeding the ${this.maxBytes} byte limit`;
  }
}

export class VcsProcessMissingExitCodeError extends Schema.TaggedError<VcsProcessMissingExitCodeError>()(
  "VcsProcessMissingExitCodeError",
  VcsProcessBoundaryErrorFields,
) {
  override get message(): string {
    return `VCS process completed without an exit code in ${this.operation}: ${this.command} (${this.cwd})`;
  }
}

export const VcsOutputDecodeError = Schema.Union([
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
]);
export type VcsOutputDecodeError = typeof VcsOutputDecodeError.Type;

export class VcsRepositoryDetectionError extends Schema.TaggedError<VcsRepositoryDetectionError>()(
  "VcsRepositoryDetectionError",
  {
    operation: Schema.String,
    cwd: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `VCS repository detection failed in ${this.operation}: ${this.cwd} - ${this.detail}`;
  }
}

export class VcsUnsupportedOperationError extends Schema.TaggedError<VcsUnsupportedOperationError>()(
  "VcsUnsupportedOperationError",
  {
    operation: Schema.String,
    kind: VcsDriverKind,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `VCS operation is unsupported for ${this.kind} in ${this.operation}: ${this.detail}`;
  }
}

export const VcsError = Schema.Union([
  VcsProcessSpawnError,
  VcsProcessExitError,
  VcsProcessTimeoutError,
  VcsProcessStdinWriteError,
  VcsProcessOutputReadError,
  VcsProcessOutputLimitError,
  VcsProcessMissingExitCodeError,
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
]);
export type VcsError = typeof VcsError.Type;
