import { describe, expect, it } from "vite-plus/test";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";

import {
  clearPendingFileDrop,
  queuePendingFileDrop,
  registerSidebarFileDropReceiver,
  retainPendingFileDropsForThread,
} from "./sidebarPendingFileDropStore";

function makeFiles(...names: string[]): File[] {
  return names.map((name) => new File(["x"], name));
}

function refOf(environmentId: string, threadId: string) {
  return scopeThreadRef(environmentId as EnvironmentId, ThreadId.make(threadId));
}

/** Registers a receiver for the thread and returns the names it was handed, per delivery. */
function receive(environmentId: string, threadId: string) {
  const deliveries: string[][] = [];
  const unregister = registerSidebarFileDropReceiver(refOf(environmentId, threadId), (files) => {
    deliveries.push(files.map((file) => file.name));
  });
  return { deliveries, [Symbol.dispose]: unregister };
}

function setup() {
  retainPendingFileDropsForThread(null);
}

describe("sidebarPendingFileDropStore", () => {
  it("hands repeat drops to the composer that mounts later, in one delivery", () => {
    setup();
    queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("a.png") });
    queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("b.png") });

    using receiver = receive("env-1", "thread-1");
    expect(receiver.deliveries).toEqual([["a.png", "b.png"]]);
    using again = receive("env-1", "thread-1");
    expect(again.deliveries).toEqual([]);
  });

  it("delivers straight to a mounted composer and stops once it unregisters", () => {
    setup();
    {
      using receiver = receive("env-1", "thread-1");
      expect(
        queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("a.png") }),
      ).toBeNull();
      expect(receiver.deliveries).toEqual([["a.png"]]);
    }

    expect(
      queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("b.png") }),
    ).not.toBeNull();
    using later = receive("env-1", "thread-1");
    expect(later.deliveries).toEqual([["b.png"]]);
  });

  it("keeps a newer drop deliverable after the first navigation fails", () => {
    setup();
    const firstId = queuePendingFileDrop({
      threadRef: refOf("env-1", "thread-1"),
      files: makeFiles("a.png"),
    });
    queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("b.png") });

    clearPendingFileDrop(firstId);
    using receiver = receive("env-1", "thread-1");
    expect(receiver.deliveries).toEqual([["b.png"]]);
  });

  it("does not confuse refs whose joined keys collide on colons", () => {
    setup();
    using other = receive("a:b", "c");
    queuePendingFileDrop({ threadRef: refOf("a", "b:c"), files: makeFiles("a.png") });
    expect(other.deliveries).toEqual([]);

    using receiver = receive("a", "b:c");
    expect(receiver.deliveries).toEqual([["a.png"]]);
  });

  it("discards drops for every thread but the one the route now shows", () => {
    setup();
    queuePendingFileDrop({ threadRef: refOf("env-1", "thread-1"), files: makeFiles("a.png") });
    queuePendingFileDrop({ threadRef: refOf("env-1", "thread-2"), files: makeFiles("b.png") });

    retainPendingFileDropsForThread(refOf("env-1", "thread-2"));
    using first = receive("env-1", "thread-1");
    using second = receive("env-1", "thread-2");
    expect(first.deliveries).toEqual([]);
    expect(second.deliveries).toEqual([["b.png"]]);
  });
});
