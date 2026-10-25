import { AuthFilesystemWriteScope, type EnvironmentId } from "@t3tools/contracts";
import { type AtomCommandResult, runAtomCommand } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { environmentSession, readEnvironmentScope, sessionHasScope } from "~/state/session";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getUnsavedProjectFileQueryData,
} from "./projectFilesQueryState";

export interface FileSaveTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

export type FilePendingListener = (relativePath: string, pending: boolean) => void;

export interface FileSaveSessionDeps {
  readonly debounceMs: number;
  readonly canPersist: (target: FileSaveTarget) => boolean;
  /** Calls `onWritable` each time the target environment regains write access. */
  readonly subscribeWritable: (target: FileSaveTarget, onWritable: () => void) => () => void;
  readonly persist: (
    target: FileSaveTarget,
    contents: string,
  ) => Promise<AtomCommandResult<unknown, unknown>>;
  readonly confirm: (target: FileSaveTarget, contents: string) => boolean;
  readonly readUnsaved: (target: FileSaveTarget) => string | null;
}

type FileSaveSessionRef = (node: object | null) => (() => void) | undefined;

interface FileSaveSession {
  readonly coordinator: FileSaveCoordinator;
  readonly listeners: Set<FilePendingListener>;
  readonly unsubscribeWritable: () => void;
  leases: number;
}

/**
 * One save session per file, shared by every surface editing it. The last
 * surface to leave flushes and disposes the session. The next surface for
 * that file starts a fresh one, which resumes any draft left unsaved, as does
 * a live session whose environment regains write access.
 */
export function createFileSaveSessions(deps: FileSaveSessionDeps) {
  const sessions = new Map<string, FileSaveSession>();
  // A disposed session may still be writing its final flush; a replacement
  // session must not queue that same draft a second time.
  const inFlight = new Map<string, string>();

  const recover = (key: string, target: FileSaveTarget, coordinator: FileSaveCoordinator) => {
    if (!deps.canPersist(target)) return;
    const unsaved = deps.readUnsaved(target);
    if (unsaved !== null && inFlight.get(key) !== unsaved) coordinator.change(unsaved);
  };

  const create = (key: string, target: FileSaveTarget): FileSaveSession => {
    const listeners = new Set<FilePendingListener>();
    let session: FileSaveSession | undefined;
    const coordinator = new FileSaveCoordinator({
      debounceMs: deps.debounceMs,
      canPersist: () => deps.canPersist(target),
      // Listeners outlive their surface: a flush that settles after the last
      // surface is gone still has to clear the pending marker.
      onPendingChange: (pending) => {
        for (const listener of listeners) listener(target.relativePath, pending);
      },
      persist: async (contents) => {
        inFlight.set(key, contents);
        let succeeded = false;
        try {
          const result = await deps.persist(target, contents);
          succeeded = result._tag === "Success";
          return result;
        } finally {
          if (inFlight.get(key) === contents) inFlight.delete(key);
          // A replacement session skipped this draft while it was in flight,
          // and a disposed session never retries, so the live one picks it up.
          const live = sessions.get(key);
          if (!succeeded && live && live !== session) recover(key, target, live.coordinator);
        }
      },
      onConfirmed: (contents) => deps.confirm(target, contents),
    });
    const unsubscribeWritable = deps.subscribeWritable(target, () =>
      recover(key, target, coordinator),
    );
    session = { coordinator, listeners, unsubscribeWritable, leases: 0 };
    return session;
  };

  const acquire = (target: FileSaveTarget, onPendingChange: FilePendingListener): (() => void) => {
    const key = fileSaveKey(target);
    const existing = sessions.get(key);
    const session = existing ?? create(key, target);
    sessions.set(key, session);
    session.leases += 1;
    session.listeners.add(onPendingChange);
    if (!existing) recover(key, target, session.coordinator);

    let released = false;
    return () => {
      if (released) return;
      released = true;
      session.leases -= 1;
      if (session.leases > 0) return;
      sessions.delete(key);
      session.unsubscribeWritable();
      session.coordinator.dispose();
    };
  };

  // React releases and reacquires a ref whose identity changes, and releasing
  // the last lease flushes at once. Callers rebuild the target every render,
  // so the callback is cached per (listener, file) instead of relying on the
  // compiler to memoize it.
  const refs = new WeakMap<FilePendingListener, Map<string, FileSaveSessionRef>>();

  return {
    /** Holds the file's session open until the returned release runs. */
    acquire,
    /** Ref callback holding the file's session open while the element is mounted. */
    ref(target: FileSaveTarget, onPendingChange: FilePendingListener): FileSaveSessionRef {
      const key = fileSaveKey(target);
      let byKey = refs.get(onPendingChange);
      if (!byKey) {
        byKey = new Map();
        refs.set(onPendingChange, byKey);
      }
      let ref = byKey.get(key);
      if (!ref) {
        const owned = { ...target };
        ref = (node) => (node ? acquire(owned, onPendingChange) : undefined);
        byKey.set(key, ref);
      }
      return ref;
    },
    /** Edits for a file nobody holds open are dropped, so retired editors stay inert. */
    change(target: FileSaveTarget, contents: string): void {
      sessions.get(fileSaveKey(target))?.coordinator.change(contents);
    },
  };
}

function fileSaveKey({ environmentId, cwd, relativePath }: FileSaveTarget): string {
  return `${environmentId}\u0000${cwd}\u0000${relativePath}`;
}

const fileSaveSessions = createFileSaveSessions({
  debounceMs: 500,
  canPersist: ({ environmentId }) => readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
  subscribeWritable: ({ environmentId }, onWritable) => {
    let writable = readEnvironmentScope(environmentId, AuthFilesystemWriteScope);
    return appAtomRegistry.subscribe(
      environmentSession.sessionStateAtom(environmentId),
      (state) => {
        const next = sessionHasScope(state, AuthFilesystemWriteScope);
        if (next && !writable) onWritable();
        writable = next;
      },
    );
  },
  persist: ({ environmentId, cwd, relativePath }, contents) =>
    runAtomCommand(appAtomRegistry, projectEnvironment.writeFile, {
      environmentId,
      input: { cwd, relativePath, contents },
    }),
  confirm: ({ environmentId, cwd, relativePath }, contents) =>
    confirmProjectFileQueryData(environmentId, cwd, relativePath, contents),
  readUnsaved: ({ environmentId, cwd, relativePath }) =>
    getUnsavedProjectFileQueryData(environmentId, cwd, relativePath)?.contents ?? null,
});

export function fileSaveSessionRef(target: FileSaveTarget, onPendingChange: FilePendingListener) {
  return fileSaveSessions.ref(target, onPendingChange);
}

export function changeFileSaveSession(target: FileSaveTarget, contents: string): void {
  fileSaveSessions.change(target, contents);
}
