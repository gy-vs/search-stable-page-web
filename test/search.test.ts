import {describe,expect,it} from 'vitest';
import request from 'supertest';
import {createApp} from '../src/server/index';
import {SearchIndex,type SearchDoc} from '../src/server/documents';
import {encodeCursor} from '../src/server/cursor';
import {compareSortKeys,type SearchParams} from '../src/shared/search';
import type {Express} from 'express';

type Page = {revision:number;fingerprint:string;items:SearchDoc[];nextCursor:string|null};

function expectParams(): SearchParams {
  return {q:'',state:'all',sort:'desc'};
}

// 用共享比较器独立推导期望顺序，避免拿被测代码验证被测代码。
function expectedOrder(index: SearchIndex, params: SearchParams): SearchDoc[] {
  const needle = params.q.toLowerCase();
  return index
    .all()
    .filter((doc) => (params.state === 'all' ? true : doc.state === params.state))
    .filter((doc) => (needle ? doc.title.toLowerCase().includes(needle) : true))
    .sort((a,b) => compareSortKeys(a,b,params.sort));
}

async function readAll(app: Express, params: SearchParams, pageSize = 8): Promise<{pages: Page[]; status: number; body: any}> {
  const pages: Page[] = [];
  let cursor: string | null = null;
  let body: any;
  let status = 200;
  for (;;) {
    const q: Record<string,string> = {q:params.q,state:params.state,sort:params.sort,pageSize:String(pageSize)};
    if (cursor) q.cursor = cursor;
    const res = await request(app).get('/api/search').query(q);
    status = res.status;
    body = res.body;
    if (res.status !== 200) break;
    pages.push(res.body as Page);
    cursor = res.body.nextCursor;
    if (!cursor) break;
    if (pages.length > 100) throw new Error('pagination did not terminate');
  }
  return {pages,status,body};
}

describe('search keyset pagination', () => {
  it('连续读取固定 revision：desc 方向每个文档恰好出现一次', async () => {
    const app = createApp();
    const {pages,status} = await readAll(app, expectParams(), 8);
    expect(status).toBe(200);
    const seen = pages.flatMap((p) => p.items);
    expect(seen.length).toBe(31);
    expect(new Set(seen.map((d) => d.id)).size).toBe(31);
    const revs = new Set(pages.map((p) => p.revision));
    expect(revs.size).toBe(1); // 全程同一 revision
    const index = new SearchIndex();
    expect(seen.map((d) => d.id)).toEqual(expectedOrder(index, expectParams()).map((d) => d.id));
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });

  it('asc 方向同样不重不漏，同分按 id 升序决胜', async () => {
    const app = createApp();
    const params: SearchParams = {q:'',state:'all',sort:'asc'};
    const {pages,status} = await readAll(app, params, 7);
    expect(status).toBe(200);
    const seen = pages.flatMap((p) => p.items);
    expect(seen.length).toBe(31);
    expect(new Set(seen.map((d) => d.id)).size).toBe(31);
    // 显式验证稳定键：分数非递减，同分时 id 严格递增
    for (let i = 1; i < seen.length; i++) {
      const [a,b] = [seen[i-1],seen[i]];
      expect(a.score < b.score || (a.score === b.score && a.id < b.id)).toBe(true);
    }
    const index = new SearchIndex();
    expect(seen.map((d) => d.id)).toEqual(expectedOrder(index, params).map((d) => d.id));
  });

  it('大量同分：关键词筛出 7 个同分文档，仅靠 id 决胜键翻页', async () => {
    const app = createApp();
    const params: SearchParams = {q:'judgments',state:'all',sort:'desc'};
    const {pages,status} = await readAll(app, params, 3);
    expect(status).toBe(200);
    const seen = pages.flatMap((p) => p.items);
    expect(seen.map((d) => d.id)).toEqual(['doc-00','doc-01','doc-02','doc-03','doc-04','doc-05','doc-06']);
    expect(seen.every((d) => d.score === 100)).toBe(true);
  });

  it('跨页边界恰在同分块内：相邻两页无重复无丢失', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'10'}).expect(200);
    const r2 = await request(app).get('/api/search').query({sort:'desc',pageSize:'10',cursor:r1.body.nextCursor}).expect(200);
    // 第一页恰好以 10 个同分文档结尾，第二页第一条必须是 doc-10，而不是重复 doc-09
    expect(r1.body.items.at(-1).id).toBe('doc-09');
    expect(r2.body.items[0].id).toBe('doc-10');
    const ids = [...r1.body.items,...r2.body.items].map((d:SearchDoc) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pageSize 不参与指纹：同游标换页大小可继续且位置不错位', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'10'}).expect(200);
    const r2 = await request(app).get('/api/search').query({sort:'desc',pageSize:'5',cursor:r1.body.nextCursor}).expect(200);
    expect(r2.body.items[0].id).toBe('doc-10');
  });
});

describe('search 游标失效', () => {
  it('翻页途中删除文档：旧游标因 revision 不匹配被拒绝，重新开始后不重不漏', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'8'}).expect(200);
    expect(r1.body.revision).toBe(1);
    await request(app).delete('/api/search/docs/doc-20').expect(200);

    const stale = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:r1.body.nextCursor}).expect(409);
    expect(stale.body.error).toBe('revision_mismatch');
    expect(stale.body.restartable).toBe(true);
    expect(stale.body.currentRevision).toBe(2);
    expect(stale.body.expectedFingerprint).toBeTruthy();

    const restarted = await readAll(app, expectParams(), 8);
    expect(restarted.status).toBe(200);
    const ids = restarted.pages.flatMap((p) => p.items).map((d) => d.id);
    expect(ids.length).toBe(30);
    expect(new Set(ids).size).toBe(30);
    expect(ids).not.toContain('doc-20');
    const index = new SearchIndex();
    index.delete('doc-20');
    expect(ids).toEqual(expectedOrder(index, expectParams()).map((d) => d.id));
  });

  it('翻页途中新增文档同样拒绝旧游标，不静默拼接新 revision 数据', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'8'}).expect(200);
    await request(app).post('/api/search/docs').send({id:'doc-new',title:'new doc',state:'active',score:100}).expect(201);
    const stale = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:r1.body.nextCursor}).expect(409);
    expect(stale.body.error).toBe('revision_mismatch');
    expect(stale.body.currentRevision).toBe(2);
  });

  it('排序方向切换：desc 游标用于 asc 查询返回 query_mismatch', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'8'}).expect(200);
    const switched = await request(app).get('/api/search').query({sort:'asc',pageSize:'8',cursor:r1.body.nextCursor}).expect(409);
    expect(switched.body.error).toBe('query_mismatch');
    expect(switched.body.restartable).toBe(true);
    expect(switched.body.currentRevision).toBe(1); // revision 未变，纯粹是配置不匹配
  });

  it('筛选与关键词变化都导致指纹不匹配', async () => {
    const app = createApp();
    const byState = await request(app).get('/api/search').query({state:'active',pageSize:'3'}).expect(200);
    const mismatch1 = await request(app).get('/api/search').query({state:'review',pageSize:'3',cursor:byState.body.nextCursor}).expect(409);
    expect(mismatch1.body.error).toBe('query_mismatch');

    const byQuery = await request(app).get('/api/search').query({q:'judgments',pageSize:'3'}).expect(200);
    const mismatch2 = await request(app).get('/api/search').query({q:'ranking',pageSize:'3',cursor:byQuery.body.nextCursor}).expect(409);
    expect(mismatch2.body.error).toBe('query_mismatch');
  });

  it('游标篡改：改签名载荷返回 bad_signature，垃圾串返回 malformed_cursor，错版本返回 unsupported_cursor_version', async () => {
    const app = createApp();
    const r1 = await request(app).get('/api/search').query({sort:'desc',pageSize:'8'}).expect(200);
    const token: string = r1.body.nextCursor;
    const [v,body,sig] = token.split('.');

    // 翻转 payload 第一个字符（base64url 字母表内），签名失效
    const swap = (c: string) => (c === 'A' ? 'B' : 'A');
    const tampered = `${v}.${swap(body[0])}${body.slice(1)}.${sig}`;
    const badSig = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:tampered}).expect(400);
    expect(badSig.body.error).toBe('bad_signature');
    expect(badSig.body.restartable).toBe(true);

    const garbage = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:'not-a-cursor'}).expect(400);
    expect(garbage.body.error).toBe('malformed_cursor');

    const wrongVersion = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:`v2.${body}.${sig}`}).expect(400);
    expect(wrongVersion.body.error).toBe('unsupported_cursor_version');
  });
});

describe('search 边界', () => {
  it('空结果页：无匹配返回空列表且 nextCursor 为 null', async () => {
    const app = createApp();
    const res = await request(app).get('/api/search').query({q:'nonexistent-term-xyz'}).expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('落在末页之后的有效游标返回空页（null cursor），不报错可重新开始', async () => {
    const app = createApp();
    const first = await request(app).get('/api/search').query({sort:'desc',pageSize:'8'}).expect(200);
    const beyond = encodeCursor({revision:first.body.revision,fingerprint:first.body.fingerprint,last:{score:-99999,id:'zzz'}});
    const res = await request(app).get('/api/search').query({sort:'desc',pageSize:'8',cursor:beyond}).expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.revision).toBe(1);
  });

  it('非法 pageSize 返回 400', async () => {
    const app = createApp();
    const res = await request(app).get('/api/search').query({pageSize:'0'}).expect(400);
    expect(res.body.error).toBe('invalid_page_size');
    expect(res.body.restartable).toBe(true);
  });

  it('asc 方向末页之后：构造超高分水游标返回空页', async () => {
    const app = createApp();
    const first = await request(app).get('/api/search').query({sort:'asc',pageSize:'8'}).expect(200);
    const beyond = encodeCursor({revision:first.body.revision,fingerprint:first.body.fingerprint,last:{score:99999,id:'zzz'}});
    const res = await request(app).get('/api/search').query({sort:'asc',pageSize:'8',cursor:beyond}).expect(200);
    expect(res.body.items).toEqual([]);
    expect(res.body.nextCursor).toBeNull();
  });

  it('不支持的状态参数回退为 all，未知 sort 回退为 desc（不泄漏错误指纹）', async () => {
    const app = createApp();
    const res = await request(app).get('/api/search').query({state:'weird',sort:'sideways',pageSize:'8'}).expect(200);
    expect(res.body.items.length).toBe(8);
  });
});
