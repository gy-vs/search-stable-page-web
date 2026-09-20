// Framework-agnostic paging state machine for the search workbench.
// React binds to it via useSyncExternalStore; unit tests drive it directly.
//
// Guarantees:
//  - A cursor is never used twice: loadMore() is a no-op while a request
//    is in flight, so rapid "load more" clicks cannot fire two requests
//    with the same cursor.
//  - Appended pages are deduped by document id (defense in depth on top
//    of the server's keyset pagination).
//  - When the server rejects a cursor, already-loaded items are KEPT and
//    the pager enters an `invalidated` state. It never silently restarts
//    or merges data from a different index revision; the user decides
//    when to refresh via restart().

export type Page<T> = {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  revision: number;
};

export class CursorInvalidError extends Error {
  constructor(
    public readonly reason: string,
    public readonly currentRevision?: number,
  ) {
    super(`cursor invalid: ${reason}`);
    this.name = 'CursorInvalidError';
  }
}

export type PagerState<T> = {
  items: T[];
  hasMore: boolean;
  loading: boolean;
  revision: number | null;
  invalidated: {reason: string; currentRevision?: number} | null;
};

export type FetchPage<Q, T> = (cursor: string | null, query: Q) => Promise<Page<T>>;

export class SearchPager<Q, T extends {id: string}> {
  private state: PagerState<T> = {
    items: [],
    hasMore: true,
    loading: false,
    revision: null,
    invalidated: null,
  };
  private cursor: string | null = null;
  private seen = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(
    private readonly fetchPage: FetchPage<Q, T>,
    private query: Q,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PagerState<T> => this.state;

  private emit() {
    for (const listener of this.listeners) listener();
  }

  private patch(partial: Partial<PagerState<T>>) {
    this.state = {...this.state, ...partial};
    this.emit();
  }

  /** Start over with a (possibly new) query: drops all items and the cursor. */
  async restart(query: Q): Promise<void> {
    this.query = query;
    this.cursor = null;
    this.seen = new Set();
    this.patch({items: [], hasMore: true, invalidated: null, revision: null});
    await this.loadMore();
  }

  async loadMore(): Promise<void> {
    // In-flight guard: a second call while one request is pending must
    // not reuse the same cursor. Also refuse to page while invalidated
    // (user must refresh) or when the result set is exhausted.
    if (this.state.loading || this.state.invalidated || !this.state.hasMore) return;
    this.patch({loading: true});
    try {
      const page = await this.fetchPage(this.cursor, this.query);
      const fresh = page.items.filter((item) => {
        if (this.seen.has(item.id)) return false;
        this.seen.add(item.id);
        return true;
      });
      this.cursor = page.nextCursor;
      this.patch({
        items: [...this.state.items, ...fresh],
        hasMore: page.hasMore,
        revision: page.revision,
      });
    } catch (error) {
      if (error instanceof CursorInvalidError) {
        // Keep everything already loaded; just flag it and stop paging.
        this.patch({invalidated: {reason: error.reason, currentRevision: error.currentRevision}});
        return;
      }
      throw error;
    } finally {
      this.patch({loading: false});
    }
  }
}
