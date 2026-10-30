// A caller's own Hub token, or any 12-character run of it, inside what the caller sends (issue #105). The bearer token is
// known only while the request is authenticated; this answers whether the request holds it without storing or echoing it,
// so the request can be refused before anything in it is handled, logged or stored.
import type { IncomingMessage } from 'node:http';

const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]{43})[ \t]*$/i;
const RUN = 12;

/** A matcher for the token in an authorization header and every 12-character run of it; null without a well-formed token. */
export function tokenRuns(authorization: unknown): RegExp | null {
  if (typeof authorization !== 'string') return null;
  const token = BEARER.exec(authorization)?.[1];
  if (token === undefined) return null;
  // A base64url character means itself outside a character class, so the runs join into one alternation as they are.
  return new RegExp(Array.from({ length: token.length - RUN + 1 }, (_, index) => token.slice(index, index + RUN)).join('|'));
}

/** Whether the method, the target or any header but the authorization holds the token: all of them may reach a log. */
export function headersHold(runs: RegExp, request: IncomingMessage): boolean {
  if (runs.test(request.method ?? '') || runs.test(request.url ?? '')) return true;
  for (const [name, value] of Object.entries(request.headers)) {
    if (name === 'authorization' || value === undefined) continue;
    if ((Array.isArray(value) ? value : [value]).some(one => runs.test(one))) return true;
  }
  return false;
}

/** Every key and string of a parsed JSON value, walked without recursion, so a value of any depth is checked. */
function valueHolds(runs: RegExp, value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      if (runs.test(current)) return true;
    } else if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
    } else if (current !== null && typeof current === 'object') {
      for (const [key, item] of Object.entries(current)) {
        if (runs.test(key)) return true;
        pending.push(item);
      }
    }
  }
  return false;
}

/** The decoded bytes of every upload_file call in a message or in a batch of them. */
function uploadedTexts(message: unknown): string[] {
  return (Array.isArray(message) ? message : [message]).flatMap(one => {
    if (one === null || typeof one !== 'object' || Array.isArray(one)) return [];
    const { method, params } = one as { method?: unknown; params?: { name?: unknown; arguments?: { file_path?: unknown } } };
    const file = method === 'tools/call' && params?.name === 'upload_file' ? params.arguments?.file_path : undefined;
    return typeof file === 'string' ? [Buffer.from(file, 'base64').toString('latin1')] : [];
  });
}

/** Whether a parsed body, its text as received, or a file uploaded in it holds the token. */
export function holdsToken(runs: RegExp, text: string, message: unknown): boolean {
  return runs.test(text) || valueHolds(runs, message) || uploadedTexts(message).some(uploaded => runs.test(uploaded));
}
