import {useEffect, useMemo, useRef, useSyncExternalStore} from 'react';
import {RefreshCw, Search, AlertTriangle, ChevronDown} from 'lucide-react';
import {SearchPaginator} from './search';
import type {SortDirection, StateFilter} from '../shared/search';

const STATE_LABELS: Record<StateFilter, string> = {
  all: '全部状态',
  active: 'active',
  review: 'review',
  archived: 'archived',
};

export default function SearchWorkbench() {
  const paginatorRef = useRef<SearchPaginator | null>(null);
  if (!paginatorRef.current) paginatorRef.current = new SearchPaginator();
  const paginator = paginatorRef.current;
  const state = useSyncExternalStore(paginator.subscribe, paginator.getState);

  // 输入草稿；提交后才改变查询指纹，避免翻页中途悄悄换查询。
  const qRef = useRef<HTMLInputElement>(null);
  const initial = useMemo(() => ({q: state.params.q, state: state.params.state, sort: state.params.sort}), []);

  useEffect(() => {
    void paginator.refresh();
    // 仅挂载时发起一次首页查询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    void paginator.search({
      q: (qRef.current?.value ?? '').trim(),
      state: state.params.state,
      sort: state.params.sort,
    });
  }

  function changeState(next: StateFilter) {
    if (next === state.params.state) return;
    void paginator.search({...state.params, state: next});
  }

  function changeSort(next: SortDirection) {
    if (next === state.params.sort) return;
    void paginator.search({...state.params, sort: next});
  }

  return (
    <section className="search-shell">
      <div className="search-controls">
        <form
          className="search-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            ref={qRef}
            key={initial.q}
            defaultValue={initial.q}
            aria-label="搜索关键词"
            placeholder="按标题搜索，回车提交"
          />
          <button type="submit" className="primary">
            <Search size={15} />
            搜索
          </button>
        </form>
        <div className="search-filters">
          <select
            aria-label="状态筛选"
            value={state.params.state}
            onChange={(event) => changeState(event.target.value as StateFilter)}
          >
            {(Object.keys(STATE_LABELS) as StateFilter[]).map((value) => (
              <option key={value} value={value}>
                {STATE_LABELS[value]}
              </option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="排序方向">
            <button className={state.params.sort === 'desc' ? 'on' : ''} onClick={() => changeSort('desc')}>
              分数高→低
            </button>
            <button className={state.params.sort === 'asc' ? 'on' : ''} onClick={() => changeSort('asc')}>
              分数低→高
            </button>
          </div>
          <button className="ghost" onClick={() => void paginator.refresh()} disabled={state.loading}>
            <RefreshCw size={14} />
            刷新
          </button>
          <span className="rev-tag">索引 revision {state.revision ?? '…'}</span>
        </div>
      </div>

      {state.invalid && (
        <div className="stale-banner" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>
              {state.invalid.error === 'revision_mismatch'
                ? '索引已更新，当前列表已过期'
                : state.invalid.error === 'query_mismatch'
                  ? '搜索条件已变化'
                  : '分页游标无效'}
            </strong>
            <span>{state.invalid.message}</span>
            <small>当前结果已保留，未与新数据拼接。</small>
          </div>
          <button className="primary" onClick={() => void paginator.refresh()}>
            刷新并重新开始
          </button>
        </div>
      )}
      {state.networkError && <div className="net-banner" role="status">{state.networkError}</div>}

      <ul className="search-results">
        {state.items.map((item) => (
          <li key={item.id} className="search-item">
            <span className="score">{item.score}</span>
            <span className="title">{item.title}</span>
            <span className={`doc-state s-${item.state}`}>{item.state}</span>
            <small>{item.id}</small>
          </li>
        ))}
        {!state.loading && state.items.length === 0 && <li className="empty">没有匹配的文档</li>}
      </ul>

      <div className="search-footer">
        {state.loading && <span>加载中…</span>}
        {!state.loading && state.nextCursor && !state.invalid && (
          <button
            className="primary load-more"
            onClick={() => void paginator.loadMore()}
            disabled={state.loadingMore}
          >
            <ChevronDown size={15} />
            {state.loadingMore ? '加载中…' : '加载更多'}
          </button>
        )}
        {!state.loading && !state.nextCursor && state.items.length > 0 && !state.invalid && (
          <span className="done">已到末尾</span>
        )}
      </div>
    </section>
  );
}
