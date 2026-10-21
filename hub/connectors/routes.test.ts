// The route allow-list matrix (D01 R[10]): method AND path template AND query AND body, route by route. A write route under
// the prefix of the reads is refused whatever its body; a read that uses POST is allowed on its listed route only; dot
// segments, encoded slashes and the like never slip past a template.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SystemProfile, type HttpMethod } from '../../contracts/src/resources.ts';
import { ConnectorError } from './errors.ts';
import { buildPath, compileRoutes, matchRoute, matchTemplate, splitPath } from './routes.ts';
import { docStoreSystem, plmSystem } from './testing/packs.ts';

const plm = compileRoutes(SystemProfile.parse(plmSystem()).routes);
const docs = compileRoutes(SystemProfile.parse(docStoreSystem()).routes);

function verdict(routes: typeof plm, method: HttpMethod, path: string, body?: unknown, query: Record<string, string> = {}, named?: string): string {
  try {
    return matchRoute(routes, { method, path, query, body }, named).declaration.id;
  } catch (error) {
    assert.ok(error instanceof ConnectorError && error.code === 'ROUTE_REFUSED', String(error));
    return 'refused';
  }
}

test('allow-list matrix of the PLM-like profile', () => {
  const rows: [HttpMethod, string, unknown, Record<string, string>, string][] = [
    ['GET', '/plmquery/product/all/', undefined, {}, 'products'],
    ['POST', '/plmquery/product/all/', undefined, {}, 'refused'],
    ['PROPFIND', '/plmquery/product/all/', undefined, {}, 'refused'],
    ['GET', '/plmquery/product/all', undefined, {}, 'refused'],
    ['GET', '/plmquery/product/all/x', undefined, {}, 'refused'],
    ['GET', '/plmquery/product/', undefined, {}, 'refused'],
    ['GET', '/plmquery/', undefined, {}, 'refused'],
    ['GET', '/plmquery/build/', undefined, { product: '28' }, 'builds'],
    ['GET', '/plmquery/build/', undefined, {}, 'refused'],
    ['GET', '/plmquery/build/', undefined, { product: 'x' }, 'refused'],
    ['GET', '/plmquery/build/', undefined, { product: '28', page: '2' }, 'refused'],
    ['GET', '/plmquery/product/all/', undefined, { debug: '1' }, 'refused'],
    ['POST', '/plmquery/bug/detail/', { bug_ids: [4242] }, {}, 'bug-detail'],
    ['POST', '/plmquery/bug/detail/', { bug_ids: ['4242', 1] }, {}, 'bug-detail'],
    ['GET', '/plmquery/bug/detail/', undefined, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/', undefined, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/', { bug_ids: [] }, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/', { bug_ids: [1], status: 'closed' }, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/', { story_ids: [1] }, {}, 'refused'],
    ['POST', '/plmquery/story/detail/', { story_ids: ['777'] }, {}, 'story-detail'],
    ['POST', '/plmquery/story/detail/', { bug_ids: ['777'] }, {}, 'refused'],
    // The write route shares the /plmquery/ prefix and uses POST like the reads: no body gets it through.
    ['POST', '/plmquery/testtask/edit/', { id: 1 }, {}, 'refused'],
    ['POST', '/plmquery/testtask/edit/', { bug_ids: [1] }, {}, 'refused'],
    ['POST', '/plmquery/testtask/edit/', undefined, {}, 'refused'],
    ['GET', '/plmquery/testtask/edit/', undefined, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/../../testtask/edit/', { bug_ids: [1] }, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/%2e%2e/%2e%2e/testtask/edit/', { bug_ids: [1] }, {}, 'refused'],
    ['POST', '/plmquery/bug%2Fdetail/', { bug_ids: [1] }, {}, 'refused'],
    ['POST', '//plmquery/bug/detail/', { bug_ids: [1] }, {}, 'refused'],
    ['POST', '/plmquery/bug/detail/?', { bug_ids: [1] }, {}, 'refused'],
    ['POST', 'plmquery/bug/detail/', { bug_ids: [1] }, {}, 'refused'],
  ];
  for (const [method, path, body, query, expected] of rows) {
    assert.equal(verdict(plm, method, path, body, query), expected, `${method} ${path} ${JSON.stringify(body)} ${JSON.stringify(query)}`);
  }
});

test('a request must match the route it names', () => {
  assert.equal(verdict(plm, 'POST', '/plmquery/bug/detail/', { bug_ids: [1] }, {}, 'bug-detail'), 'bug-detail');
  assert.equal(verdict(plm, 'POST', '/plmquery/bug/detail/', { bug_ids: [1] }, {}, 'story-detail'), 'refused');
  assert.equal(verdict(plm, 'POST', '/plmquery/testtask/edit/', { bug_ids: [1] }, {}, 'bug-detail'), 'refused');
});

test('templates with a rest parameter and a trailing slash (WebDAV-like)', () => {
  assert.equal(verdict(docs, 'PROPFIND', '/spec/'), 'list');
  assert.equal(verdict(docs, 'PROPFIND', '/spec'), 'refused', 'a collection needs its trailing slash');
  assert.equal(verdict(docs, 'GET', '/spec/a.md'), 'file');
  assert.equal(verdict(docs, 'GET', '/spec/'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/../vault/key'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/%2E%2E/vault/key'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/.%2e/vault/key'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/a%5Cb'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/a%00b'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/a b.md'), 'refused', 'a raw space must be encoded');
  assert.equal(verdict(docs, 'GET', '/spec/a%20b.md'), 'file');
  assert.equal(verdict(docs, 'GET', '/spec/%E4%B8%AD.md'), 'file');
  assert.equal(verdict(docs, 'DELETE' as HttpMethod, '/spec/a.md'), 'refused');
  assert.equal(verdict(docs, 'POST', '/spec/a.md', { x: 1 }), 'refused');
});

test('paths are built from plain values and encoded; climbing out is refused', () => {
  const file = docs.find((r) => r.declaration.id === 'file')!;
  const list = docs.find((r) => r.declaration.id === 'list')!;
  assert.equal(buildPath(file, { path: 'spec/a b.md' }), '/spec/a%20b.md');
  assert.equal(buildPath(file, { path: 'spec/中.md' }), '/spec/%E4%B8%AD.md');
  assert.equal(buildPath(list, { path: 'spec' }), '/spec/');
  for (const path of ['spec/../../etc/passwd', '../x', 'spec//a', '', 'spec/./a', 'a\\b', 'a\u0000b']) {
    assert.throws(() => buildPath(file, { path }), (e: unknown) => e instanceof ConnectorError && e.code === 'PLAN_INVALID', path);
  }
  assert.throws(() => buildPath(file, {}), /缺参数 path/);
  assert.throws(() => buildPath(file, { path: 'a', other: 'b' }), /没有参数 other/);
  const single = compileRoutes([{ id: 'one', role: 'r', method: 'GET', path: '/x/{name}', response: 'text', max_bytes: 10, read: true }])[0];
  assert.equal(buildPath(single, { name: 'a:b' }), '/x/a%3Ab');
  assert.throws(() => buildPath(single, { name: 'a/b' }), /不能含/);
  assert.throws(() => buildPath(single, { name: '\ud800' }), /Unicode/);
});

test('path splitting and template matching are exact', () => {
  assert.deepEqual(splitPath('/'), { segments: [], trailingSlash: false });
  assert.equal(typeof splitPath('/a/./b'), 'string');
  assert.equal(typeof splitPath('/a/%zz'), 'string');
  assert.equal(typeof splitPath(`/${'a'.repeat(5000)}`), 'string');
  const t = compileRoutes([{ id: 'x', role: 'r', method: 'GET', path: '/a/{b}/{c*}', response: 'text', max_bytes: 10, read: true }])[0].template;
  assert.deepEqual(matchTemplate(t, '/a/1/2/3'), { b: '1', c: '2/3' });
  assert.equal(matchTemplate(t, '/a/1'), null);
  assert.equal(matchTemplate(t, '/a/1/2/'), null);
  assert.equal(matchTemplate(t, '/b/1/2'), null);
});

test('a ;-segment never stands for a dot segment and never fills a parameter (servlet containers drop path parameters)', () => {
  for (const path of ['/spec/..;/x', '/spec/.;/x', '/spec/..;jsessionid=1/x', '/spec/%2e%2e;/x', '/spec/..%3B/x', '/spec/;x/y', '/spec/a;b.md', '/spec/x/..;']) {
    assert.equal(verdict(docs, 'GET', path), 'refused', path);
  }
  assert.equal(verdict(docs, 'PROPFIND', '/spec/..;/'), 'refused');
  assert.equal(verdict(docs, 'GET', '/spec/a%3Bb.md'), 'file', 'an encoded ; is data');
  assert.equal(typeof splitPath('/a/..;/b'), 'string');
  assert.equal(typeof splitPath('/a/b;c/d'), 'object', 'a ; after a name is a segment the template may spell out');
  const literal = compileRoutes([{ id: 'x', role: 'r', method: 'GET', path: '/a;v=1/{b}', response: 'text', max_bytes: 10, read: true }]);
  assert.equal(verdict(literal, 'GET', '/a;v=1/c'), 'x', 'a literal segment of the template may hold a ;');
  assert.equal(verdict(literal, 'GET', '/a;v=1/c;d'), 'refused');
});

test('the segment pattern of a parameter is checked on each segment it fills, decoded', () => {
  const routes = compileRoutes([
    { id: 'doc', role: 'r', method: 'GET', path: '/docs/{path*}', params: { path: { type: 'string', maxLength: 20, pattern: '^[a-z0-9.-]{1,20}$' } }, response: 'text', max_bytes: 10, read: true },
  ]);
  assert.equal(verdict(routes, 'GET', '/docs/a/b.md'), 'doc');
  assert.equal(verdict(routes, 'GET', '/docs/a/B.md'), 'refused');
  assert.equal(verdict(routes, 'GET', '/docs/a/%E4%B8%AD.md'), 'refused');
  assert.equal(verdict(routes, 'GET', `/docs/${'a'.repeat(21)}`), 'refused');
  assert.equal(verdict(routes, 'GET', '/docs/a%2Db.md'), 'doc', 'decoded before the pattern');
});
