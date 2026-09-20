import {decodeCursor, encodeCursor, queryFingerprint} from './cursor';
import type {SearchIndex, SearchDoc} from './documents';
import {
  compareSortKeys,
  isAfterCursor,
  normalizeParams,
  normalizePageSize,
  type SearchParams,
} from '../shared/search';

export type SearchSuccess = {
  ok: true;
  revision: number;
  fingerprint: string;
  items: SearchDoc[];
  nextCursor: string | null;
};

// 所有失效原因都是“可重新开始”的：前端丢弃旧游标、从第一页重新查询即可恢复。
export type SearchErrorCode =
  | 'invalid_page_size'
  | 'malformed_cursor'
  | 'bad_signature'
  | 'unsupported_cursor_version'
  | 'revision_mismatch'
  | 'query_mismatch';

export type SearchFailure = {
  ok: false;
  status: number;
  error: SearchErrorCode;
  message: string;
  restartable: true;
  currentRevision: number;
  expectedFingerprint?: string;
};

export type SearchOutcome = SearchSuccess | SearchFailure;

export type SearchRequest = {
  raw: {q?: unknown; state?: unknown; sort?: unknown; pageSize?: unknown; cursor?: unknown};
  index: SearchIndex;
};

function failure(
  status: number,
  error: SearchErrorCode,
  message: string,
  index: SearchIndex,
  params?: SearchParams,
): SearchFailure {
  return {
    ok: false,
    status,
    error,
    message,
    restartable: true,
    currentRevision: index.revision,
    ...(params ? {expectedFingerprint: queryFingerprint(params)} : {}),
  };
}

export function executeSearch({raw, index}: SearchRequest): SearchOutcome {
  const params = normalizeParams(raw);
  const pageSize = normalizePageSize(raw.pageSize);
  if (pageSize === null) {
    return failure(400, 'invalid_page_size', 'pageSize must be an integer between 1 and 100', index);
  }

  const fingerprint = queryFingerprint(params);
  const revision = index.revision;

  let cursor: {score: number; id: string} | null = null;
  if (raw.cursor !== undefined && raw.cursor !== '') {
    const decoded = decodeCursor(raw.cursor);
    if (!decoded.ok) {
      return failure(
        400,
        decoded.reason,
        '游标无法解析或已被篡改，请从第一页重新开始',
        index,
      );
    }
    const {payload} = decoded;
    // revision 不匹配：索引自游标签发后发生过文档增删，拒绝拼接两套 revision 的数据。
    if (payload.rev !== revision) {
      return failure(
        409,
        'revision_mismatch',
        `索引已更新（游标 revision ${payload.rev} → 当前 ${revision}），请从第一页重新查询`,
        index,
        params,
      );
    }
    // 查询指纹不匹配：排序方向、筛选或关键词变了却沿用旧游标。
    if (payload.fp !== fingerprint) {
      return failure(
        409,
        'query_mismatch',
        '搜索条件已变化，旧游标仅适用于原查询，请从第一页重新查询',
        index,
        params,
      );
    }
    cursor = {score: decoded.payload.score, id: decoded.payload.id};
  }

  const needle = params.q.toLowerCase();
  const matched = index.all().filter((doc) => {
    if (params.state !== 'all' && doc.state !== params.state) return false;
    if (needle && !doc.title.toLowerCase().includes(needle)) return false;
    return true;
  });

  const ordered = matched
    .filter((doc) => (cursor ? isAfterCursor(doc, cursor, params.sort) : true))
    .sort((a, b) => compareSortKeys(a, b, params.sort));

  // 多取一条判断是否还有下一页；nextCursor 始终基于最后一条“实际返回”的文档，
  // 因此空页（游标之后已无文档）返回空列表 + nextCursor=null，且结果仍可继续。
  const window = ordered.slice(0, pageSize + 1);
  const items = window.slice(0, pageSize);
  const hasMore = window.length > pageSize;
  const last = items[items.length - 1];

  return {
    ok: true,
    revision,
    fingerprint,
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({revision, fingerprint, last: {score: last.score, id: last.id}})
        : null,
  };
}
