// A WebDAV-like store for the document-library tests: PROPFIND Depth 1 answers 207 with `D:` names and the collection first,
// GET serves files, every request must carry the expected Authorization header (Basic authentication) or is answered 401.
import { startStub, text, type StubServer } from '../../../hub/connectors/testing/api.ts';

const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** The members of a collection of `files` (paths below the root, starting with /), as a multistatus document. */
export function multistatusOf(collection: string, files: Record<string, string>): string {
  const children = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(collection)) continue;
    const rest = path.slice(collection.length);
    const slash = rest.indexOf('/');
    children.add(slash < 0 ? path : `${collection}${rest.slice(0, slash + 1)}`);
  }
  const response = (href: string) => `<D:response><D:href>${escape(encodeURI(href))}</D:href><D:propstat><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${response(collection)}${[...children].sort().map(response).join('')}</D:multistatus>`;
}

export interface GuardedStore extends StubServer {
  /** Requests answered 401. */
  readonly refused: number;
}

/** A store that answers only requests carrying `authorization` exactly. */
export async function startGuardedStore(files: Record<string, string>, authorization: string, prefix = ''): Promise<GuardedStore> {
  let refused = 0;
  const collections = new Set<string>(['/']);
  for (const path of Object.keys(files)) {
    const parts = path.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) collections.add(`/${parts.slice(0, i).join('/')}/`);
  }
  const stub = await startStub((request) => {
    if (request.headers.authorization !== authorization) {
      refused += 1;
      return { ...text('unauthorized', 'text/plain', 401), headers: { 'content-type': 'text/plain', 'www-authenticate': 'Basic realm="docs"' } };
    }
    const decoded = decodeURIComponent(request.path);
    if (!decoded.startsWith(prefix)) return text('not found', 'text/plain', 404);
    const path = decoded.slice(prefix.length) || '/';
    if (request.method === 'PROPFIND') {
      if (!collections.has(path) || request.headers.depth !== '1') return text('not found', 'text/plain', 404);
      const local: Record<string, string> = {};
      for (const [key, value] of Object.entries(files)) local[key] = value;
      return text(multistatusOf(path, local).replaceAll('<D:href>', `<D:href>${escape(encodeURI(prefix))}`), 'application/xml; charset=utf-8', 207);
    }
    if (request.method === 'GET' && files[path] !== undefined) return text(files[path], 'text/markdown; charset=utf-8');
    return text('not found', 'text/plain', 404);
  });
  return Object.defineProperty(stub, 'refused', { get: () => refused }) as GuardedStore;
}
