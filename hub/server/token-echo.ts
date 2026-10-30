// A caller's own Hub token, or any 12-character run of it, inside what the caller sends (issue #105). The bearer token is
// known only while the request is authenticated; this answers whether the request holds it without storing or echoing it,
// so the request can be refused before anything in it is handled, logged or stored.
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

/** The bytes an upload_file call carries, decoded, so a token inside the file is found as well. */
function uploadedText(message: unknown): string | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const { method, params } = message as { method?: unknown; params?: { name?: unknown; arguments?: { file_path?: unknown } } };
  if (method !== 'tools/call' || params?.name !== 'upload_file' || typeof params.arguments?.file_path !== 'string') return null;
  return Buffer.from(params.arguments.file_path, 'base64').toString('latin1');
}

/** Whether a parsed request, its text as received, or an uploaded file in it holds the token. */
export function holdsToken(runs: RegExp, text: string, message: unknown): boolean {
  if (runs.test(text) || runs.test(JSON.stringify(message) ?? '')) return true;
  const uploaded = uploadedText(message);
  return uploaded !== null && runs.test(uploaded);
}
