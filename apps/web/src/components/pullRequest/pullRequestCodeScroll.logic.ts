interface SavedCodeScroll {
  readonly scrollTop: number;
  readonly loadedPageCount: number;
}

type ScrollSurface = Pick<HTMLElement, "scrollTop" | "scrollHeight" | "clientHeight">;

export class PullRequestCodeScrollRestoration {
  pending = true;

  constructor(private readonly saved: SavedCodeScroll) {}

  restore(surface: ScrollSurface | undefined, loadedPageCount: number, hasNextPage: boolean) {
    if (!this.pending || loadedPageCount === 0) return "waiting";
    if (loadedPageCount < this.saved.loadedPageCount && hasNextPage) return "load-more";
    if (surface === undefined || surface.clientHeight === 0) return "waiting";
    // Pierre's position target subtracts the sticky header height. Restore the raw offset
    // only after the saved pages exist, or a short first page would permanently clamp it.
    surface.scrollTop = Math.min(
      this.saved.scrollTop,
      Math.max(0, surface.scrollHeight - surface.clientHeight),
    );
    this.pending = false;
    return "restored";
  }
}
