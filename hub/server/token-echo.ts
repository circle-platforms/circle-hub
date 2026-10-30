// The caller's own Hub token written into the body of its request (issue #105). The bearer token is known only while the
// request is authenticated; a body that holds it is refused before anything in it is handled or stored, and the answer does
// not echo it. Credentials in the output are otherwise the credential scan's business, not this check's.
const BEARER = /^Bearer[ \t]+([A-Za-z0-9_-]{43})[ \t]*$/i;

/** The token of a well-formed authorization header, or null. */
export function bearerToken(authorization: unknown): string | null {
  return typeof authorization === 'string' ? BEARER.exec(authorization)?.[1] ?? null : null;
}
