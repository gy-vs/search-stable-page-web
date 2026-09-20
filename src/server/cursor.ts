// Opaque pagination cursors.
//
// A cursor carries the FULL stable sort key of the last returned
// document (not just the score), the fingerprint of the query
// configuration that produced it, and the index revision it belongs
// to. The payload is HMAC-signed so clients cannot forge or edit one.
//
//   base64url(json payload) "." base64url(hmac-sha256(payload))

import {createHmac, timingSafeEqual} from 'node:crypto';
import type {SearchQuery} from './searchIndex';

export const CURSOR_VERSION = 1;

export type CursorPayload = {
  v: number;
  rev: number;
  fp: string;
  key: [number, string]; // full stable sort key: [score, id]
};

export type CursorRejection =
  | 'malformed' // not even structurally a cursor
  | 'bad_signature' // forged or tampered payload
  | 'revision_mismatch' // index changed since the cursor was issued
  | 'fingerprint_mismatch'; // query/filter/sort config changed

export type DecodeResult =
  | {ok: true; payload: CursorPayload}
  | {ok: false; reason: 'malformed' | 'bad_signature'};

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

/** Canonical fingerprint of everything that defines the result set besides the cursor. */
export function queryFingerprint(query: SearchQuery): string {
  const canonical = JSON.stringify({
    q: query.q.trim().toLowerCase().replace(/\s+/g, ' '),
    tag: query.tag,
    sortDir: query.sortDir,
  });
  return createHmac('sha256', 'search-fingerprint').update(canonical).digest('base64url').slice(0, 16);
}

export function encodeCursor(payload: CursorPayload, secret: string): string {
  const body = base64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

export function decodeCursor(raw: string, secret: string): DecodeResult {
  const dot = raw.lastIndexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return {ok: false, reason: 'malformed'};
  const body = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = sign(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return {ok: false, reason: 'bad_signature'};
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return {ok: false, reason: 'malformed'};
  }
  if (!isCursorPayload(payload)) return {ok: false, reason: 'malformed'};
  return {ok: true, payload};
}

function isCursorPayload(value: unknown): value is CursorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    p.v === CURSOR_VERSION &&
    Number.isInteger(p.rev) &&
    typeof p.fp === 'string' &&
    Array.isArray(p.key) &&
    p.key.length === 2 &&
    typeof p.key[0] === 'number' &&
    typeof p.key[1] === 'string'
  );
}
