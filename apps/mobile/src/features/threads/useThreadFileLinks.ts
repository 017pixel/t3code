import { useAtomValue } from "@effect/atom-react";
import {
  AuthFilesystemReadScope,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { formatFilePathPosition, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  resolveMarkdownFileLinkTarget,
  resolveThreadFilePathCandidate,
} from "@t3tools/shared/markdownLinks";
import { isAbsolutePath, resolveWorkspaceFilePath } from "@t3tools/shared/path";
import { collectThreadFilePaths, createThreadFilePathIndex } from "@t3tools/shared/threadFilePaths";
import { Atom } from "effect/reactivity";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { projectEnvironment } from "../../state/projects";
import { useEnvironmentScope, usePreparedConnection } from "../../state/session";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
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
  const checkpoints = useAtomValue(
    environmentThreadDetails.threadAtom(ref),
    (thread) => thread?.projection.checkpoints,
  );
  const invalidate = useAtomCommand(projectEnvironment.invalidateFileMetadata, {
    reportFailure: false,
  });
  const previous = useRef<{
    environmentId: ScopedThreadRef["environmentId"];
    threadId: ScopedThreadRef["threadId"];
    cwd: string | null;
    checkpoints: OrchestrationV2ThreadProjection["checkpoints"];
  } | null>(null);
  useEffect(() => {
    if (!checkpoints) {
      previous.current = null;
      return;
    }
    const before = previous.current;
    previous.current = { environmentId, threadId, cwd, checkpoints };
    if (
      !before ||
      before.environmentId !== environmentId ||
      before.threadId !== threadId ||
      before.cwd !== cwd
    )
      return;
    const oldById = new Map(before.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const paths = new Set<string>();
    const addPath = (path: string) => {
      if (cwd !== null || isAbsolutePath(path))
        paths.add(cwd === null ? path : resolveWorkspaceFilePath(path, cwd));
    };
    for (const checkpoint of checkpoints) {
      const old = oldById.get(checkpoint.id);
      oldById.delete(checkpoint.id);
      if (old?.files === checkpoint.files && old?.status === checkpoint.status) continue;
      for (const file of checkpoint.files) addPath(file.path);
      for (const file of old?.files ?? []) addPath(file.path);
    }
    for (const checkpoint of oldById.values())
      for (const file of checkpoint.files) addPath(file.path);
    if (paths.size > 0) void invalidate({ environmentId, input: { paths: [...paths] } });
  }, [environmentId, threadId, cwd, checkpoints, invalidate]);
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current++;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Leaving this scope invalidates delayed native actions.
    [environmentId, threadId, cwd, connection, canRead, enabled],
  );
  const capture = () => {
    const current = generation.current;
    return () => generation.current === current;
  };
  const scope = useMemo(
    () => ({ environmentId, threadId, cwd, connection, canRead, enabled }),
    [environmentId, threadId, cwd, connection, canRead, enabled],
  );
  return { ...scope, index, capture, scope };
}

export const ThreadFileLinksContext = createContext<ReturnType<typeof useThreadFileLinks> | null>(
  null,
);

export function useThreadFileBindings(assets: ReadonlyArray<{ readonly url: string }>) {
  const context = useContext(ThreadFileLinksContext);
  const scope = context?.scope;
  const captureScope = context?.capture;
  const ownerGeneration = useRef(0);
  useLayoutEffect(
    () => () => {
      ownerGeneration.current++;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A menu may outlive this document or its owner, but keeps its opening selection.
    [scope],
  );
  const bindingsAtom = Atom.make((get) => {
    const selected = new Map<string, string>();
    if (!context?.enabled) return selected;
    const { environmentId, threadId, cwd, index } = context;
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
        candidateResult.value?.kind === "file" &&
        (rootResult === null ||
          (rootResult._tag === "Success" && !rootResult.waiting && rootResult.value === null))
      ) {
        selected.set(href, fileLinkHref(candidate));
      }
    }
    return selected;
  });
  const resolved = useAtomValue(bindingsAtom);
  const selectedKey = JSON.stringify([...resolved]);
  // The native image cache resets when its selected-path resolver changes identity.
  const [binding, setBinding] = useState({ key: selectedKey, selected: resolved });
  let selected = binding.selected;
  if (binding.key !== selectedKey) {
    selected = resolved;
    setBinding({ key: selectedKey, selected });
  }
  const generation = useRef(0);
  useLayoutEffect(
    () => () => {
      generation.current++;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Selection changes invalidate image requests, while menus retain their opening target.
    [scope, selectedKey],
  );
  const capture = () => {
    const isScopeCurrent = scope && captureScope ? captureScope() : null;
    const current = generation.current;
    return () => generation.current === current && (isScopeCurrent?.() ?? true);
  };
  const href = (url: string) => selected.get(url) ?? url;
  const unverifiedRootless = (url: string) =>
    context?.cwd === null &&
    !selected.has(url) &&
    resolveThreadFilePathCandidate(url, null, context.index) !== null;
  const captureOwner = () => {
    const isScopeCurrent = scope && captureScope ? captureScope() : null;
    const current = ownerGeneration.current;
    return () => ownerGeneration.current === current && (isScopeCurrent?.() ?? true);
  };
  return { href, unverifiedRootless, capture, captureOwner };
}
