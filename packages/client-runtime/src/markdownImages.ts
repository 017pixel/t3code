import {
  isNetworkPath,
  isWindowsAbsolutePath,
  stripSlashPrefixedWindowsDrive,
  workspaceRelativeFilePath,
} from "@t3tools/shared/path";

import {
  normalizeMarkdownLinkDestination,
  safeDecodeURIComponent,
  splitMarkdownLinkSearchAndHash,
} from "@t3tools/shared/markdownLinks";
import { parseFileUrlHref } from "@t3tools/shared/fileLinks";

const DIRECT_IMAGE_SOURCE_PATTERN = /^(?:https?:|data:|blob:|\/\/)/i;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export type MarkdownImageSource =
  | { readonly _tag: "Direct"; readonly uri: string }
  | { readonly _tag: "WorkspaceFile"; readonly path: string }
  | { readonly _tag: "Blocked" };

export function markdownImageSourceFragment(source: string): string {
  return splitMarkdownLinkSearchAndHash(normalizeMarkdownLinkDestination(source)).hash;
}

function joinWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const separator = isWindowsAbsolutePath(workspaceRoot) ? "\\" : "/";
  const root = workspaceRoot.replace(/[\\/]+$/, "");
  const path = relativePath.replace(/[\\/]/g, separator).replace(/^[\\/]+/, "");
  return `${root}${separator}${path}`;
}

/** Rendering is not a click, so a network path loads only from the project's own share. */
function hostFileSource(
  path: string,
  workspaceRoot: string | null | undefined,
): MarkdownImageSource {
  return isNetworkPath(path) && workspaceRelativeFilePath(path, workspaceRoot) === null
    ? { _tag: "Blocked" }
    : { _tag: "WorkspaceFile", path };
}

/**
 * The media-file path for a classified workspace image. A source authored relative
 * to its document stays relative to the thread workspace, `..` included for a
 * document outside it, so only the thread's own host resolves it; an explicit host
 * path may still be served from this desktop when the host lacks it. A path with no
 * relative form from the root, such as another Windows drive or share, stays absolute.
 */
export function markdownImageMediaPath(
  value: string,
  classifiedPath: string,
  threadWorkspaceRoot: string | null | undefined,
): string {
  const authored = classifyMarkdownImageSource(value, ".");
  if (
    !threadWorkspaceRoot ||
    authored._tag !== "WorkspaceFile" ||
    !authored.path.startsWith("./")
  ) {
    return classifiedPath;
  }
  const rootSegments = threadWorkspaceRoot.split(/[\\/]+/).filter(Boolean);
  const pathSegments = classifiedPath.split(/[\\/]+/).filter(Boolean);
  let shared = 0;
  while (
    shared < rootSegments.length &&
    shared < pathSegments.length &&
    rootSegments[shared] === pathSegments[shared]
  ) {
    shared += 1;
  }
  const ascents = rootSegments.slice(shared);
  if (
    // Both sides must start on the same drive, and `..` cannot leave a share's root.
    (isWindowsAbsolutePath(threadWorkspaceRoot) && shared === 0) ||
    (ascents.length > 0 && (isNetworkPath(threadWorkspaceRoot) || isNetworkPath(classifiedPath))) ||
    ascents.some((segment) => segment === "." || segment === "..") ||
    shared === pathSegments.length
  ) {
    return classifiedPath;
  }
  const separator = isWindowsAbsolutePath(threadWorkspaceRoot) ? "\\" : "/";
  return [...ascents.map(() => ".."), ...pathSegments.slice(shared)].join(separator);
}

/**
 * Filesystem paths belong to the environment host and must never reach a
 * browser or native image component without first becoming a signed asset URL.
 */
export function classifyMarkdownImageSource(
  value: string | null | undefined,
  workspaceRoot?: string | null,
): MarkdownImageSource {
  if (value === null || value === undefined) return { _tag: "Blocked" };

  const source = normalizeMarkdownLinkDestination(value);
  if (source.length === 0 || source.startsWith("#") || source.startsWith("?")) {
    return { _tag: "Blocked" };
  }
  if (DIRECT_IMAGE_SOURCE_PATTERN.test(source)) {
    return { _tag: "Direct", uri: source };
  }

  if (/^file:/i.test(source)) {
    const target = parseFileUrlHref(source);
    return target === null
      ? { _tag: "Blocked" }
      : hostFileSource(
          stripSlashPrefixedWindowsDrive(safeDecodeURIComponent(target.path)),
          workspaceRoot,
        );
  }

  const path = stripSlashPrefixedWindowsDrive(
    safeDecodeURIComponent(splitMarkdownLinkSearchAndHash(source).path),
  );
  if (path.length === 0) return { _tag: "Blocked" };
  if (path.startsWith("/") || isWindowsAbsolutePath(path)) {
    return hostFileSource(path, workspaceRoot);
  }
  if (URI_SCHEME_PATTERN.test(path) || path.startsWith("~/") || path.startsWith("~\\")) {
    return { _tag: "Blocked" };
  }
  if (!workspaceRoot) return { _tag: "Blocked" };

  return { _tag: "WorkspaceFile", path: joinWorkspacePath(workspaceRoot, path) };
}
