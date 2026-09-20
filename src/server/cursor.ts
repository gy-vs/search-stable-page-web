import {createHash, createHmac, timingSafeEqual} from 'node:crypto';
import type {SortKey} from '../shared/search';
import {canonicalFingerprintInput, type SearchParams} from '../shared/search';

// 不透明游标：客户端只能原样传回，无法读取、伪造或修改。
// 形态：v1.<base64url payload>.<base64url HMAC-SHA256(payload)>
// payload 内含完整稳定键 (score,id)、查询指纹、索引 revision。

const VERSION = 'v1';
const DEFAULT_DEV_SECRET = 'dev-only-search-cursor-secret';
const SECRET = process.env.SEARCH_CURSOR_SECRET ?? DEFAULT_DEV_SECRET;

export type CursorPayload = {
  v: 1;
  rev: number; // 签发时的索引 revision
  fp: string; // 查询指纹（规范化参数的 SHA-256）
  score: number; // 稳定键第 1 段：最后返回文档的分数
  id: string; // 稳定键第 2 段（同分决胜）：最后返回文档的 id
};

export type InvalidCursorReason =
  | 'malformed_cursor'
  | 'bad_signature'
  | 'unsupported_cursor_version';

export type DecodeResult =
  | {ok: true; payload: CursorPayload}
  | {ok: false; reason: InvalidCursorReason};

export function queryFingerprint(params: SearchParams): string {
  return createHash('sha256').update(canonicalFingerprintInput(params)).digest('base64url');
}

function b64urlEncode(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function encodeCursor(input: {
  revision: number;
  fingerprint: string;
  last: SortKey;
}): string {
  const payload: CursorPayload = {
    v: 1,
    rev: input.revision,
    fp: input.fingerprint,
    score: input.last.score,
    id: input.last.id,
  };
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${VERSION}.${body}.${sig}`;
}

export function decodeCursor(token: unknown): DecodeResult {
  if (typeof token !== 'string' || token.length > 2048) {
    return {ok: false, reason: 'malformed_cursor'};
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) {
    return {ok: false, reason: 'malformed_cursor'};
  }
  const [version, body, sig] = parts;
  if (version !== VERSION) return {ok: false, reason: 'unsupported_cursor_version'};

  const expected = createHmac('sha256', SECRET).update(body).digest('base64url');
  let sigBuf: Buffer;
  let expectedBuf: Buffer;
  try {
    sigBuf = Buffer.from(sig, 'base64url');
    expectedBuf = Buffer.from(expected, 'base64url');
  } catch {
    return {ok: false, reason: 'malformed_cursor'};
  }
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return {ok: false, reason: 'bad_signature'};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return {ok: false, reason: 'malformed_cursor'};
  }
  const p = parsed as Partial<CursorPayload> | null;
  if (
    !p ||
    p.v !== 1 ||
    typeof p.rev !== 'number' ||
    !Number.isInteger(p.rev) ||
    typeof p.fp !== 'string' ||
    typeof p.score !== 'number' ||
    typeof p.id !== 'string'
  ) {
    return {ok: false, reason: 'malformed_cursor'};
  }
  return {ok: true, payload: p as CursorPayload};
}
