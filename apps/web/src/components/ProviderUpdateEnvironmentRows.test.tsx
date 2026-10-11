import type { Dispatch, ReactElement, SetStateAction } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AuthProvidersManageScope,
  type AuthEnvironmentScope,
  type EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import type {
  LocalEnvironmentUpdateGroup,
  ProviderUpdateCandidate,
  ProviderUpdateRowStatus,
} from "./ProviderUpdateLaunchNotification.logic";

const testState = vi.hoisted(() => ({
  groups: [] as LocalEnvironmentUpdateGroup[],
  permittedEnvironmentIds: new Set<EnvironmentId>(),
  updateProvider: vi.fn(),
  primaryProviders: [] as ServerProvider[],
  addToast: vi.fn(),
  updateToast: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  let effects: Array<() => void> = [];

  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
      effects = [];
    },
    useEffect(effect: () => void, dependencies: readonly unknown[]) {
      const index = nextIndex();
      const previous = slots[index] as readonly unknown[] | undefined;
      if (!previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) {
        slots[index] = dependencies;
        effects.push(effect);
      }
    },
    flushEffects() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    useCallback<T>(callback: T): T {
      nextIndex();
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      nextIndex();
      return factory();
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = { current: initialValue };
      }
      return slots[index] as { current: T };
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: hooks.useCallback,
    useEffect: hooks.useEffect,
    useLayoutEffect: hooks.useEffect,
    useMemo: hooks.useMemo,
    useRef: hooks.useRef,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({
  c: hooks.useMemoCache,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { updateProvider: Symbol("updateProvider") },
  primaryServerProvidersAtom: Symbol("providers"),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => testState.primaryProviders }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "env-wsl" }),
}));
vi.mock("~/providerUpdateDismissal", () => ({
  useDismissedProviderUpdateNotificationKeys: () => ({
    dismissedNotificationKeys: new Set(),
    dismissNotificationKey: vi.fn(),
  }),
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast, update: testState.updateToast, close: vi.fn() },
  hiddenToastActionProps: { hidden: true },
  stackedThreadToast: (options: unknown) => options,
}));

vi.mock("~/state/session", () => ({
  readEnvironmentScope: (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
    scope === AuthProvidersManageScope && testState.permittedEnvironmentIds.has(environmentId),
  useEnvironmentScope: (environmentId: EnvironmentId | null, scope: AuthEnvironmentScope) =>
    environmentId !== null &&
    scope === AuthProvidersManageScope &&
    testState.permittedEnvironmentIds.has(environmentId),
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.updateProvider,
}));

vi.mock("./ProviderUpdateLaunchNotification.environments", () => ({
  useLocalEnvironmentUpdateGroups: () => ({
    groups: testState.groups,
    isAnySettling: false,
  }),
}));

import { ProviderUpdateEnvironmentRows } from "./ProviderUpdateEnvironmentRows";
import { ProviderUpdatePrimaryNotification } from "./ProviderUpdatePrimaryNotification";

const environmentId = "env-wsl" as EnvironmentId;
const pendingExpiryMs = 6 * 60_000;

function provider(updateStatus?: "succeeded"): ServerProvider {
  const result: ServerProvider = {
    instanceId: ProviderInstanceId.make("codex-wsl"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: updateStatus ? "1.1.0" : "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-26T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    versionAdvisory: {
      status: updateStatus ? "current" : "behind_latest",
      currentVersion: updateStatus ? "1.1.0" : "1.0.0",
      latestVersion: "1.1.0",
      updateCommand: "npm install -g @openai/codex@latest",
      canUpdate: true,
      checkedAt: "2026-06-26T12:00:00.000Z",
      message: updateStatus ? "Up to date." : "Update available.",
    },
  };

  return updateStatus
    ? {
        ...result,
        updateState: {
          status: updateStatus,
          startedAt: "2026-06-26T12:00:00.000Z",
          finishedAt: "2026-06-26T12:00:01.000Z",
          message: "Provider updated.",
          output: null,
        },
      }
    : result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type RowElement = ReactElement<{
  readonly status: ProviderUpdateRowStatus;
  readonly onUpdate: () => void;
}>;

function renderRow(): RowElement {
  hooks.beginRender();
  const output = ProviderUpdateEnvironmentRows({}) as ReactElement<{
    readonly children: RowElement | RowElement[];
  }>;
  const children = output.props.children;
  return Array.isArray(children) ? children[0]! : children;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("ProviderUpdatePrimaryNotification", () => {
  it("settles a batch when a queued provider disappears during an earlier update", async () => {
    hooks.reset();
    testState.permittedEnvironmentIds.add(environmentId);
    testState.addToast.mockReset().mockReturnValue("removed-provider-toast");
    testState.updateToast.mockReset();
    testState.updateProvider.mockReset();
    const first = { ...provider(), instanceId: ProviderInstanceId.make("removal-first") };
    const second = {
      ...provider(),
      instanceId: ProviderInstanceId.make("removal-second"),
      driver: ProviderDriverKind.make("claude"),
    };
    const pending =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    testState.updateProvider.mockReturnValueOnce(pending.promise);
    testState.primaryProviders = [first, second];
    const render = () => {
      hooks.beginRender();
      ProviderUpdatePrimaryNotification();
      hooks.flushEffects();
    };
    render();
    testState.addToast.mock.calls[0]![0].actionProps.onClick();
    expect(testState.updateProvider).toHaveBeenCalledTimes(1);
    testState.primaryProviders = [first];
    render();
    pending.resolve(
      AsyncResult.success({
        providers: [{ ...provider("succeeded"), instanceId: first.instanceId }],
      }),
    );
    await flushPromises();
    expect(testState.updateProvider).toHaveBeenCalledTimes(1);
    expect(testState.addToast.mock.calls.at(-1)?.[0].title).toBe("Provider updated");
    testState.primaryProviders = [
      {
        ...first,
        instanceId: ProviderInstanceId.make("removal-next"),
        versionAdvisory: { ...first.versionAdvisory!, latestVersion: "1.2.0" },
      },
    ];
    render();
    expect(testState.addToast.mock.calls.at(-1)?.[0].actionProps.children).toBe("Update");
  });

  it("removes the stale launch Update action when an unsolicited update starts", () => {
    hooks.reset();
    testState.permittedEnvironmentIds.add(environmentId);
    testState.updateProvider.mockReset();
    testState.addToast.mockReset().mockReturnValue("launch-toast");
    testState.updateToast.mockReset();
    const initial = provider();
    testState.primaryProviders = [initial];
    const render = () => {
      hooks.beginRender();
      ProviderUpdatePrimaryNotification();
      hooks.flushEffects();
    };
    render();
    const staleAction = testState.addToast.mock.calls[0]![0].actionProps;
    expect(staleAction.children).toBe("Update");
    testState.primaryProviders = [
      {
        ...initial,
        updateState: {
          status: "running",
          origin: "background",
          startedAt: initial.checkedAt,
          finishedAt: null,
          message: "Updating",
          output: null,
        },
      },
    ];
    render();
    expect(testState.updateToast.mock.calls.at(-1)?.[1].actionProps.children).toBe("Settings");
    staleAction.onClick();
    expect(testState.updateProvider).not.toHaveBeenCalled();
    testState.primaryProviders = [
      {
        ...testState.primaryProviders[0]!,
        updateState: { ...testState.primaryProviders[0]!.updateState!, status: "failed" },
      },
    ];
    render();
    expect(testState.updateToast.mock.calls.at(-1)?.[1].actionProps.children).toBe("Update");
  });
});

describe("ProviderUpdateEnvironmentRows", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    hooks.reset();
    testState.permittedEnvironmentIds.clear();
    testState.permittedEnvironmentIds.add(environmentId);
    testState.updateProvider.mockReset();
    const candidate = provider() as ProviderUpdateCandidate;
    testState.groups = [
      {
        environmentId,
        label: "WSL",
        isPrimary: false,
        isSettling: false,
        candidates: [candidate],
        providers: [candidate],
      },
    ];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a successor pending when an expired request resolves late, then shows its success", async () => {
    const firstRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    const successorRequest =
      deferred<ReturnType<typeof AsyncResult.success<{ providers: ServerProvider[] }>>>();
    testState.updateProvider
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(successorRequest.promise);

    renderRow().props.onUpdate();
    expect(renderRow().props.status.kind).toBe("loading");

    await vi.advanceTimersByTimeAsync(pendingExpiryMs);
    expect(renderRow().props.status.kind).toBe("failed");

    renderRow().props.onUpdate();
    expect(testState.updateProvider).toHaveBeenCalledTimes(2);
    expect(renderRow().props.status.kind).toBe("loading");

    firstRequest.resolve(AsyncResult.success({ providers: [provider("succeeded")] }));
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("loading");

    successorRequest.resolve(AsyncResult.success({ providers: [provider("succeeded")] }));
    await flushPromises();

    expect(renderRow().props.status.kind).toBe("success");
  });
});
