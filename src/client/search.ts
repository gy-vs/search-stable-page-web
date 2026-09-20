import {DEFAULT_PAGE_SIZE, type SearchParams} from '../shared/search';

export type SearchDocView = {id: string; title: string; state: string; score: number};

// 服务端判定游标失效后给出的结构化原因；前端据此保留结果并提示刷新。
export type InvalidCursor = {
  error: string;
  message: string;
  currentRevision: number;
  expectedFingerprint?: string;
};

export type PaginatorState = {
  params: SearchParams;
  items: SearchDocView[];
  revision: number | null;
  loading: boolean; // 首屏 / 刷新
  loadingMore: boolean; // 追加下一页
  invalid: InvalidCursor | null; // 游标失效（revision/配置/篡改）
  networkError: string | null; // 网络或 5xx：可重试，不丢结果
  nextCursor: string | null;
};

type SuccessResponse = {
  ok: true;
  revision: number;
  fingerprint: string;
  items: SearchDocView[];
  nextCursor: string | null;
};

type ErrorResponse = {
  ok: false;
  error: string;
  message: string;
  restartable?: boolean;
  currentRevision?: number;
  expectedFingerprint?: string;
};

export const initialPaginatorState: PaginatorState = {
  params: {q: '', state: 'all', sort: 'desc'},
  items: [],
  revision: null,
  loading: false,
  loadingMore: false,
  invalid: null,
  networkError: null,
  nextCursor: null,
};

export function buildSearchUrl(params: SearchParams, cursor: string | null): string {
  const search = new URLSearchParams({
    q: params.q,
    state: params.state,
    sort: params.sort,
    pageSize: String(DEFAULT_PAGE_SIZE),
  });
  if (cursor) search.set('cursor', cursor);
  return `/api/search?${search.toString()}`;
}

export class SearchPaginator {
  #state: PaginatorState = initialPaginatorState;
  #listeners = new Set<() => void>();
  #gen = 0; // 每次新搜索（首页）自增，使旧响应无法覆盖新结果
  #inflight: Promise<void> | null = null; // loadMore 串行化：同游标不可能并发追加两次

  getState = (): PaginatorState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #patch(patch: Partial<PaginatorState>) {
    this.#state = {...this.#state, ...patch};
    this.#listeners.forEach((listener) => listener());
  }

  /** 新查询 / 参数变化 / 刷新：丢弃旧游标，从第一页开始。 */
  search(params: SearchParams): Promise<void> {
    return this.#run({mode: 'search', params});
  }

  refresh(): Promise<void> {
    return this.#run({mode: 'search', params: this.#state.params});
  }

  /** 追加下一页；快速连点时复用同一个 in-flight Promise。 */
  loadMore(): Promise<void> {
    if (this.#inflight) return this.#inflight;
    if (this.#state.loading || this.#state.invalid) return Promise.resolve();
    if (!this.#state.nextCursor) return Promise.resolve();
    const promise = this.#run({mode: 'more', params: this.#state.params});
    this.#inflight = promise;
    promise.finally(() => {
      if (this.#inflight === promise) this.#inflight = null;
    });
    return promise;
  }

  async #run(
    request: {mode: 'search'; params: SearchParams} | {mode: 'more'; params: SearchParams},
  ): Promise<void> {
    const {mode, params} = request;
    const gen = mode === 'search' ? (this.#gen += 1) : this.#gen;
    const cursor = mode === 'more' ? this.#state.nextCursor : null;
    this.#patch(
      mode === 'more'
        ? {loadingMore: true, networkError: null}
        : {loading: true, invalid: null, networkError: null},
    );

    let response: Response;
    try {
      response = await fetch(buildSearchUrl(params, cursor), {headers: {accept: 'application/json'}});
    } catch {
      // 被更新的搜索取代（用户快速切换条件）则忽略；网络错误保留现有结果。
      if (gen !== this.#gen) return;
      this.#patch({
        loading: false,
        loadingMore: false,
        networkError: '网络异常，现有结果已保留，请重试',
      });
      return;
    }

    if (gen !== this.#gen) return; // 旧查询迟到：绝不覆盖更新的结果集

    let body: SuccessResponse | ErrorResponse;
    try {
      body = (await response.json()) as SuccessResponse | ErrorResponse;
    } catch {
      this.#patch({
        loading: false,
        loadingMore: false,
        networkError: '服务响应异常，现有结果已保留，请重试',
      });
      return;
    }

    if (response.ok && body.ok !== false) {
      const value = body as SuccessResponse;
      if (mode === 'more') {
        // 防御性去重：稳定键保证服务端不重不漏，这里再按 id 兜底，绝不重复拼接。
        const seen = new Set(this.#state.items.map((item) => item.id));
        const appended = value.items.filter((item) => !seen.has(item.id));
        this.#patch({
          items: [...this.#state.items, ...appended],
          nextCursor: value.nextCursor,
          revision: value.revision,
          loadingMore: false,
          networkError: null,
        });
      } else {
        this.#patch({
          params,
          items: value.items,
          nextCursor: value.nextCursor,
          revision: value.revision,
          loading: false,
          invalid: null,
          networkError: null,
        });
      }
      return;
    }

    const error = body as ErrorResponse;
    if (response.status === 409 || response.status === 400) {
      // 游标失效：保留当前结果，不自动拼接新 revision 数据，等待用户手动刷新。
      this.#patch({
        loading: false,
        loadingMore: false,
        nextCursor: null,
        invalid: {
          error: error.error ?? 'invalid_cursor',
          message: error.message ?? '游标已失效，请刷新后从第一页重新查询',
          currentRevision: error.currentRevision ?? this.#state.revision ?? 0,
          expectedFingerprint: error.expectedFingerprint,
        },
      });
      return;
    }

    this.#patch({
      loading: false,
      loadingMore: false,
      networkError: `服务暂时不可用（${response.status}），现有结果已保留`,
    });
  }
}
