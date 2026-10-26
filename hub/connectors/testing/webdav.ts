// A WebDAV-like document store stub (architecture brief section 8, structure only, invented content): anonymous reads;
// PROPFIND with Depth 1 answers 207 Multi-Status with `D:` namespace prefixes; a collection URL needs its trailing slash (the
// form without it is redirected, which the Hub refuses); files are Markdown, one with NUL bytes in it.
import { notFound, startStub, text, type StubServer } from './stub.ts';

export const DOCUMENTS: Record<string, string> = {
  '/spec/widget-range.md': '# 组件参数范围\n\n参数取值 1 到 100，超出时提示取值范围。\n',
  '/spec/widget-list.md': '# Widget list\n\nThe list shows every widget.\n',
  '/spec/other-topic.md': '# 其他主题\n\n与组件无关。\n',
  '/manuals/line-2.1/cli.md': '# CLI\n\n**widget set** *\\<value\\>*\n\n设置组件参数。\u0000\u0000\n',
};

const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function multistatus(collection: string, files: Record<string, string>): string {
  const children = new Set<string>();
  for (const path of Object.keys(files)) {
    if (!path.startsWith(collection)) continue;
    const rest = path.slice(collection.length);
    const slash = rest.indexOf('/');
    children.add(slash < 0 ? path : `${collection}${rest.slice(0, slash + 1)}`);
  }
  const response = (href: string, isCollection: boolean, size: number) =>
    `<D:response><D:href>${escape(encodeURI(href))}</D:href><D:propstat><D:prop>` +
    `${isCollection ? '<D:resourcetype><D:collection/></D:resourcetype>' : `<D:resourcetype/><D:getcontentlength>${size}</D:getcontentlength>`}` +
    `<D:getlastmodified>Mon, 12 Jan 2026 10:00:00 GMT</D:getlastmodified></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
    response(collection, true, 0) +
    [...children]
      .sort()
      .map((child) => (child.endsWith('/') ? response(child, true, 0) : response(child, false, Buffer.byteLength(files[child] ?? '', 'utf8'))))
      .join('') +
    '</D:multistatus>'
  );
}

export async function startWebDavStub(files: Record<string, string> = DOCUMENTS): Promise<StubServer> {
  const collections = new Set<string>(['/']);
  for (const path of Object.keys(files)) {
    const parts = path.split('/').slice(1, -1);
    for (let i = 1; i <= parts.length; i++) collections.add(`/${parts.slice(0, i).join('/')}/`);
  }
  return startStub((request) => {
    const path = decodeURIComponent(request.path);
    if (request.method === 'PROPFIND') {
      if (!path.endsWith('/') && collections.has(`${path}/`)) return { status: 301, headers: { location: `${request.path}/` }, body: '' };
      if (!collections.has(path)) return notFound();
      if (request.headers.depth !== '1') return text('Depth 1 only', 'text/plain', 403);
      return text(multistatus(path, files), 'application/xml; charset=utf-8', 207);
    }
    if (request.method === 'GET') {
      const body = files[path];
      return body === undefined ? notFound() : text(body, 'text/markdown; charset=utf-8', 200, { etag: `"${Buffer.byteLength(body)}-1"` });
    }
    return text('method not allowed', 'text/plain', 405);
  });
}
