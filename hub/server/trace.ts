// W3C Trace Context and the client session header (B08 F[1], F[3]). The trace id comes from a valid `traceparent`, else a
// new random one; the session id is what the client declares in Circle-Session-Id, kept as its digest when it is not short
// printable ASCII (the same rule as the call log, so a run's session and its call-log lines agree).
import { createHash, randomBytes } from 'node:crypto';

/** version-traceid-parentid-flags, then (for a future version only) more fields after a dash. */
const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const SESSION = /^[\x21-\x7e]{1,200}$/;

function single(header: string | string[] | undefined): string | undefined {
  if (Array.isArray(header)) return header.length === 1 ? header[0] : undefined;
  return header;
}

/** The trace id of a valid traceparent header, or null (absent, repeated, malformed, version ff, all-zero ids). */
export function traceIdFrom(header: string | string[] | undefined): string | null {
  const value = single(header);
  if (typeof value !== 'string' || value.length > 512) return null;
  const match = TRACEPARENT.exec(value);
  if (match === null) return null;
  const [, version, traceId, parentId, , rest] = match;
  if (version === 'ff') return null;
  if (version === '00' && rest !== undefined) return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return traceId;
}

/** A new W3C trace id: 16 random bytes in lowercase hex, never all zero. */
export function newTraceId(): string {
  for (;;) {
    const id = randomBytes(16).toString('hex');
    if (!/^0+$/.test(id)) return id;
  }
}

/** The client session id of a Circle-Session-Id header: null when absent or empty, `sha256:<hex>` when not short printable ASCII. */
export function sessionIdOf(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(', ') : header;
  if (value === undefined || value === '') return null;
  return SESSION.test(value) ? value : `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}
