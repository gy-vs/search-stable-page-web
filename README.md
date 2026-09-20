# Search Relevance Lab

Local workbench for query judgments, with a stable-cursor search workbench.

Run `npm install`, then `npm run dev` (UI on :4173, API on :4174).
Tests: `npm test`; type check + build: `npm run build`.

## 稳定排序键

排序键为完整二元组 **(score, id)**：

- `score` 按请求方向（desc/asc）比较；
- 同分时 `id` 永远按字典序升序决胜。

因此任意两条文档都有确定的全局先后顺序，与索引物理存储顺序无关，
固定 revision 下连续翻页每个文档恰好出现一次。

## 不透明游标

`GET /api/search?q=&state=&sort=&pageSize=&cursor=`

游标格式 `v1.<base64url payload>.<base64url HMAC-SHA256>`，payload 内含：

| 字段 | 含义 |
| --- | --- |
| `rev` | 游标签发时的索引 revision（增删文档时单调 +1） |
| `fp` | 查询指纹：规范化参数 `{q,sort,state}` 的 SHA-256（pageSize 不参与） |
| `score`,`id` | 最后一条返回文档的完整稳定键 |

客户端不可读、不可伪造（HMAC 校验，常量时间比较）。服务端对每次续页校验：

1. 版本/格式/签名 → 400 `malformed_cursor` / `bad_signature` / `unsupported_cursor_version`
2. `rev === 当前 revision` → 409 `revision_mismatch`（索引增删过文档）
3. `fp === 当前查询指纹` → 409 `query_mismatch`（排序方向、筛选、关键词变化）

所有错误都带 `restartable:true`、`currentRevision`，409 还带
`expectedFingerprint`，客户端丢弃旧游标从第一页重新查询即可恢复。

## 前端失效语义（SearchPaginator）

- 游标失效时**保留当前结果**，置空 nextCursor，展示“刷新并重新开始”横幅，
  绝不自动拼接新 revision 的数据；失效后点击加载更多不会发请求。
- `loadMore()` 以单个 in-flight Promise 串行化：快速连点复用同一请求，
  同一游标不可能并发追加两次；追加时按 id 防御性去重。
- 每次新搜索自增 generation，迟到的旧响应不会覆盖新条件结果。
- 网络/5xx 错误与游标失效分离：保留结果、允许重试，不标记为过期。

## 变更接口（驱动 revision 变化）

- `POST /api/search/docs` `{id,title,state,score}` → 201，revision+1
- `DELETE /api/search/docs/:id` → revision+1
- `GET /api/search/state` → `{revision,count}`
