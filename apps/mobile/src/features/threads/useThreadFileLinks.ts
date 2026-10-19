import { useAtomValue } from "@effect/atom-react";
import { AuthFilesystemReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  resolveMarkdownFileLinkTarget,
  resolveThreadFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { collectThreadFilePaths, createThreadFilePathIndex } from "@t3tools/shared/threadFilePaths";
import { Atom } from "effect/reactivity";
import { createContext, useContext, useId, useLayoutEffect, useRef, useState } from "react";

import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { useThreadVisibleTurnItems } from "../../state/use-thread-detail";

/** Encode a literal selected path once before giving it back to markdown parsers. */
function fileLinkHref(target: string) {
  const position = splitFilePathPosition(target);
  return formatFilePathPosition({
    ...position,
    path: position.path
      .split(/([\\/])/)
      .map((part) =>
        part === "/" || part === "\\" || /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part),
      )
      .join(""),
  });
}

export function useThreadFileLinks(ref: ScopedThreadRef, cwd: string | null) {
  const visible = useThreadVisibleTurnItems(ref);
  const paths = collectThreadFilePaths(
    visible.map(({ item }) => item),
    cwd,
  );
  const pathsKey = JSON.stringify(paths);
  const [indexed, setIndexed] = useState(() => ({
    key: pathsKey,
    index: createThreadFilePathIndex(paths),
  }));
  let index = indexed.index;
  if (indexed.key !== pathsKey) {
    index = createThreadFilePathIndex(paths);
    setIndexed({ key: pathsKey, index });
  }
  const canRead = useEnvironmentScope(ref.environmentId, AuthFilesystemReadScope);
  const connection = usePreparedConnection(ref.environmentId);
  const enabled = canRead && connection._tag === "Some";
  const { environmentId, threadId } = ref;
  useAtomValue(projectEnvironment.fileMetadataThread(ref));
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current++;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving this scope invalidates delayed native actions.
    [environmentId, threadId, cwd, index, connection, enabled],
  );
  const capture = () => {
    const current = generation.current;
    return () => generation.current === current;
  };
  const supersede = () => {
    generation.current++;
  };
  const scope = { environmentId, threadId, cwd, index, connection, enabled };
  return { ...scope, capture, supersede, scope };
}

export const ThreadFileLinksContext = createContext<ReturnType<typeof useThreadFileLinks> | null>(
  null,
);

export function useThreadFileBindings(assets: ReadonlyArray<{ readonly url: string }>) {
  const scope = useContext(ThreadFileLinksContext);
  const menuId = useId();
  const [menuScope, setMenuScope] = useState({ scope, revision: 0 });
  let menuRevision = menuScope.revision;
  if (menuScope.scope !== scope) {
    menuRevision++;
    setMenuScope({ scope, revision: menuRevision });
  }
  const menuKey = JSON.stringify([menuId, menuRevision]);
  const bindingsAtom = Atom.make((get) => {
    const selected = new Map<string, string>();
    if (!scope?.enabled) return selected;
    const { environmentId, threadId, cwd, index } = scope;
    for (const { url: href } of assets) {
      const candidate = resolveThreadFilePathCandidate(href, cwd, index);
      if (!candidate) continue;
      const root = resolveMarkdownFileLinkTarget(href, cwd ?? undefined);
      const read = (path: string) =>
        get(
          projectEnvironment.fileMetadata({
            environmentId,
            input: { threadId, path: splitFilePathPosition(path).path },
          }),
        );
      const candidateResult = read(candidate);
      const rootResult = root === null ? null : read(root);
      if (
        candidateResult._tag === "Success" &&
        !candidateResult.waiting &&
        candidateResult.value !== null &&
        (rootResult === null ||
          (rootResult._tag === "Success" && !rootResult.waiting && rootResult.value === null))
      ) {
        selected.set(href, fileLinkHref(candidate));
      }
    }
    return selected;
  });
  const selected = useAtomValue(bindingsAtom);
  const selectedKey = JSON.stringify([...selected]);
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current++;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Selection changes invalidate image requests, while menus retain their opening target.
    [scope, selectedKey],
  );
  const capture = () => {
    const isScopeCurrent = scope?.capture();
    const current = generation.current;
    return () => generation.current === current && (isScopeCurrent?.() ?? true);
  };
  const href = (url: string) => selected.get(url) ?? url;
  const unverifiedRootless = (url: string) =>
    scope?.cwd === null &&
    !selected.has(url) &&
    resolveThreadFilePathCandidate(url, null, scope.index) !== null;
  return { href, unverifiedRootless, capture, menuKey };
}
