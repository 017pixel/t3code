import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import type { ReviewSectionItem } from "./reviewModel";
import {
  getCachedReviewParsedDiff,
  getReviewParsedDiffSourceCharacterCount,
  MAX_CACHED_REVIEW_DIFFS,
  MAX_CACHED_REVIEW_SOURCE_CHARACTERS,
} from "./reviewState";

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdle(callback: IdleCallback): number {
  if (typeof globalThis.requestIdleCallback === "function") {
    return globalThis.requestIdleCallback(callback, { timeout: 2_000 });
  }

  return setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    100,
  ) as unknown as number;
}

function cancelIdle(handle: number): void {
  if (typeof globalThis.cancelIdleCallback === "function") {
    globalThis.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

export function prewarmReviewDiffSection(input: {
  readonly threadKey: string;
  readonly section: ReviewSectionItem;
}): void {
  const { section, threadKey } = input;
  if (section.diff === null || section.diff.length > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
    return;
  }

  const parsedDiff = getCachedReviewParsedDiff({
    threadKey,
    sectionId: section.id,
    diff: section.diff,
  });
  getCachedNativeReviewDiffData({ parsedDiff, comments: [] });
}

export function getReviewDiffPrewarmSections(input: {
  readonly threadKey: string;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
}): ReadonlyArray<ReviewSectionItem> {
  const { threadKey, sections, selectedSectionId } = input;
  const selectedIndex = sections.findIndex((section) => section.id === selectedSectionId);
  const selectedSection = sections[selectedIndex];
  if (!selectedSection) {
    return [];
  }

  let sourceCharacterCount = getReviewParsedDiffSourceCharacterCount({
    threadKey,
    sectionId: selectedSection.id,
    diff: selectedSection.diff,
  });
  if (sourceCharacterCount > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
    return [];
  }

  const pendingSections: ReviewSectionItem[] = [];
  for (let distance = 1; distance < sections.length; distance += 1) {
    for (const index of [selectedIndex - distance, selectedIndex + distance]) {
      if (pendingSections.length >= MAX_CACHED_REVIEW_DIFFS - 1) {
        return pendingSections;
      }
      const section = sections[index];
      if (!section || section.diff === null) {
        continue;
      }
      const sectionCharacterCount = getReviewParsedDiffSourceCharacterCount({
        threadKey,
        sectionId: section.id,
        diff: section.diff,
      });
      if (sourceCharacterCount + sectionCharacterCount > MAX_CACHED_REVIEW_SOURCE_CHARACTERS) {
        continue;
      }
      pendingSections.push(section);
      sourceCharacterCount += sectionCharacterCount;
    }
  }
  return pendingSections;
}

interface PrewarmJob {
  readonly threadKey: string;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
  handle: number | null;
}

let currentJob: PrewarmJob | null = null;

function cancelReviewDiffPrewarm(): void {
  if (currentJob?.handle != null) {
    cancelIdle(currentJob.handle);
  }
  currentJob = null;
}

/**
 * Ref callback for the native diff view: prewarming starts from its draw events, so it stops when
 * that view goes away (the sheet closes or falls back to an empty, loading or error state).
 * Module-level so its identity is stable and React does not detach it on every render.
 */
export function stopReviewDiffPrewarmOnDetach(): () => void {
  return cancelReviewDiffPrewarm;
}

/**
 * Parses the selected section's neighbors while idle. Call it on the selected section's draw and
 * visible-range events so prewarming never competes with its first draw. Skipped while the native
 * view is hidden, since only that view uses the parsed data.
 */
export function prewarmReviewDiffNeighbors(input: {
  readonly threadKey: string | null;
  readonly sections: ReadonlyArray<ReviewSectionItem>;
  readonly selectedSectionId: string | null;
}): void {
  const { sections, selectedSectionId, threadKey } = input;
  if (
    currentJob !== null &&
    currentJob.threadKey === threadKey &&
    currentJob.sections === sections &&
    currentJob.selectedSectionId === selectedSectionId
  ) {
    return;
  }
  cancelReviewDiffPrewarm();
  if (!threadKey) {
    return;
  }

  const job: PrewarmJob = { threadKey, sections, selectedSectionId, handle: null };
  currentJob = job;
  const pendingSections = getReviewDiffPrewarmSections({ threadKey, sections, selectedSectionId });
  let nextSectionIndex = 0;
  const scheduleNext = () => {
    job.handle = scheduleIdle(() => {
      job.handle = null;
      const section = pendingSections[nextSectionIndex];
      if (currentJob !== job || !section) {
        return;
      }
      nextSectionIndex += 1;
      prewarmReviewDiffSection({ threadKey, section });
      if (nextSectionIndex < pendingSections.length) {
        scheduleNext();
      }
    });
  };
  if (pendingSections.length > 0) {
    scheduleNext();
  }
}
