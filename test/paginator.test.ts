import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Server} from 'node:http';
import {createApp} from '../src/server/index';
import {SearchPaginator} from '../src/client/search';
import type {SearchParams} from '../src/shared/search';

const DESC: SearchParams = {q:'',state:'all',sort:'desc'};

describe('SearchPaginator', () => {
  let server: Server;
  let base: string;
  let realFetch: typeof fetch;
  let calls: string[];
  let failCursorOnce: boolean;
  let gateFirst: {promise: Promise<void>; release: () => void} | null;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('bad server address');
    base = `http://127.0.0.1:${address.port}`;
    realFetch = globalThis.fetch;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    calls = [];
    failCursorOnce = false;
    gateFirst = null;
    globalThis.fetch = (vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const isFirstCall = calls.length === 1;
      if (gateFirst && isFirstCall && !url.includes('cursor=')) {
        await gateFirst.promise;
      }
      if (failCursorOnce && url.includes('cursor=')) {
        failCursorOnce = false;
        throw new TypeError('network down');
      }
      return realFetch(new URL(url, base));
    }) as unknown as typeof fetch);
  });

  it('快速连点“加载更多”：同一游标只发一次请求，全部文档恰好出现一次', async () => {
    const p = new SearchPaginator();
    await p.search(DESC);
    const afterFirst = calls.length; // 首页请求数

    while (p.getState().nextCursor && !p.getState().invalid) {
      const cursor = p.getState().nextCursor;
      const a = p.loadMore();
      const b = p.loadMore(); // 同一事件循环内连点
      await Promise.all([a, b]);
      // 每个游标恰好产生一次请求
      const uses = calls.filter((url) => url.includes(`cursor=${encodeURIComponent(cursor ?? '')}`)).length;
      expect(uses).toBe(1);
    }
    const state = p.getState();
    expect(calls.filter((url) => url.includes('cursor=')).length).toBe(calls.length - afterFirst);
    expect(state.items.length).toBe(31);
    expect(new Set(state.items.map((d) => d.id)).size).toBe(31);
    expect(state.nextCursor).toBeNull();
  });

  it('游标失效：保留已有结果、不再发请求；手动刷新后恢复', async () => {
    const p = new SearchPaginator();
    await p.search(DESC);
    await p.loadMore();
    expect(p.getState().items.length).toBe(16);

    // 服务端索引变更（用真实 fetch 绕过计数桩）
    await realFetch(`${base}/api/search/docs/doc-20`, {method: 'DELETE'});

    await p.loadMore();
    const state = p.getState();
    expect(state.invalid?.error).toBe('revision_mismatch');
    expect(state.items.length).toBe(16); // 结果保留，未拼接新 revision 数据
    expect(state.nextCursor).toBeNull();
    expect(state.loadingMore).toBe(false);

    const requestsBefore = calls.length;
    await p.loadMore(); // 失效后连点不应触发任何请求
    expect(calls.length).toBe(requestsBefore);

    await p.refresh();
    const recovered = p.getState();
    expect(recovered.invalid).toBeNull();
    expect(recovered.items.length).toBe(8); // 从第一页重新开始
    expect(recovered.items.find((d) => d.id === 'doc-20')).toBeUndefined();
    while (p.getState().nextCursor && !p.getState().invalid) {
      await p.loadMore();
    }
    const all = p.getState();
    expect(all.items.length).toBe(30);
    expect(new Set(all.items.map((d) => d.id)).size).toBe(30);
  });

  it('快速切换查询：迟到的旧响应不能覆盖新结果', async () => {
    let release = () => {};
    gateFirst = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release(),
    };
    const p = new SearchPaginator();
    const slow = p.search(DESC); // gen1 被挂起
    const judgments: SearchParams = {q: 'judgments', state: 'all', sort: 'desc'};
    const fast = p.search(judgments); // gen2 立即完成
    await fast;
    expect(p.getState().params.q).toBe('judgments');
    expect(p.getState().items.length).toBe(7);

    gateFirst.release();
    await slow;
    expect(p.getState().params.q).toBe('judgments'); // 旧响应被丢弃
    expect(p.getState().items.length).toBe(7);
  });

  it('翻页时网络失败：保留结果并标记 networkError，恢复后可继续', async () => {
    const p = new SearchPaginator();
    await p.search(DESC);
    failCursorOnce = true;
    await p.loadMore();
    let state = p.getState();
    expect(state.networkError).toContain('网络异常');
    expect(state.items.length).toBe(8); // 结果保留
    expect(state.loadingMore).toBe(false);

    await p.loadMore();
    state = p.getState();
    expect(state.networkError).toBeNull();
    expect(state.items.length).toBe(16);
  });

  it('配置变化（排序/筛选）走首页而非旧游标', async () => {
    const p = new SearchPaginator();
    await p.search(DESC);
    const cursorBefore = p.getState().nextCursor;
    expect(cursorBefore).toBeTruthy();
    await p.search({q: '', state: 'active', sort: 'desc'});
    const state = p.getState();
    expect(state.items.every((d) => d.state === 'active')).toBe(true);
    // 新查询的首页请求不带 cursor
    const latest = calls[calls.length - 1];
    expect(latest).not.toContain('cursor=');
    expect(latest).toContain('state=active');
  });
});
