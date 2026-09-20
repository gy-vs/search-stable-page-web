// 前后端共享的搜索契约：稳定排序键、参数规范化、查询指纹规范串。
// 本模块不依赖 node API，客户端可直接打包。

export type SortDirection = 'desc' | 'asc';
export type DocState = 'active' | 'review' | 'archived';
export type StateFilter = DocState | 'all';

/** 一次搜索的配置；游标只能在完全相同的配置下继续使用。 */
export type SearchParams = {
  q: string;
  state: StateFilter;
  sort: SortDirection;
};

/**
 * 稳定排序键 = (score, id)。
 * score 按排序方向比较；同分时 id 永远按字典序升序决胜，
 * 因此任意两条文档都有确定且唯一的先后顺序，翻页不会重复或丢失。
 */
export type SortKey = {score: number; id: string};

export const DEFAULT_PARAMS: SearchParams = {q: '', state: 'all', sort: 'desc'};
export const DEFAULT_PAGE_SIZE = 8;
export const MAX_PAGE_SIZE = 100;

const STATES: readonly StateFilter[] = ['all', 'active', 'review', 'archived'];

export function normalizeParams(raw: {
  q?: unknown;
  state?: unknown;
  sort?: unknown;
}): SearchParams {
  const q = typeof raw.q === 'string' ? raw.q.trim() : '';
  const state = STATES.includes(raw.state as StateFilter)
    ? (raw.state as StateFilter)
    : 'all';
  const sort: SortDirection = raw.sort === 'asc' ? 'asc' : 'desc';
  return {q, state, sort};
}

export function normalizePageSize(raw: unknown): number | null {
  if (raw === undefined || raw === '') return DEFAULT_PAGE_SIZE;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_SIZE) return null;
  return n;
}

/**
 * 查询指纹的规范输入：键顺序固定、参数已规范化。
 * 服务端对其做 SHA-256 得到指纹并写入游标；
 * 排序方向、筛选、关键词任一变化都会得到不同指纹。
 * 注意 pageSize 不参与指纹——游标标记的是“位置”，与页大小无关。
 */
export function canonicalFingerprintInput(params: SearchParams): string {
  return JSON.stringify({q: params.q, sort: params.sort, state: params.state});
}

/** 比较稳定排序键 (score,id)：返回负数表示 a 在 b 之前。 */
export function compareSortKeys(a: SortKey, b: SortKey, sort: SortDirection): number {
  if (a.score !== b.score) {
    return sort === 'desc' ? b.score - a.score : a.score - b.score;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 文档在给定方向下是否严格落在游标位置之后。
 * 同分决胜 id 始终升序，所以相等分数时只接受 id 更大的文档。
 */
export function isAfterCursor(
  doc: SortKey,
  cursor: SortKey,
  sort: SortDirection,
): boolean {
  if (doc.score !== cursor.score) {
    return sort === 'desc' ? doc.score < cursor.score : doc.score > cursor.score;
  }
  return doc.id > cursor.id;
}
