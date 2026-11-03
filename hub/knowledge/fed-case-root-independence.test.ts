// Root-independent fed-case fields (fed-case-reprojection, part C): a root-less projection decides `only=` membership for
// stories, defects, document and title, never for commands or path; a field the projection does not state stays unknown.
// Synthetic cut only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize } from '../records/api.ts';
import { normalizedId, onlyMatcher, rootIndependentField, rootIndependentValues, ROOT_INDEPENDENT_CASE_FIELDS } from './fed-case-fields.ts';
import type { FeedingCut, KnowledgeStructureObject } from './feeding-types.ts';
import { fedScope, rootlessCases } from './views.ts';

const ROOT = 'a'.repeat(64);
const SHA = 'b'.repeat(64);
const EXTERNAL = 'agile:mindmap:SYN-DOC';

function fedCase(id: string, extra: Record<string, unknown>, root: string | null = null): KnowledgeStructureObject {
  return { schema: 'fed-case@1', object: id.repeat(64).slice(0, 64), product: 'synthetic', root, path: null, source: { system: 'agile', document: 'SYN-DOC', element: `case-${id}`, revision: null, bytes: SHA }, commands: [], ...extra };
}

/** A cut whose cases have root-less projections, and those named in `rooted` also one under ROOT from the same source. */
function cutOf(cases: KnowledgeStructureObject[], rooted: readonly string[] = []): FeedingCut {
  const byRoot = new Map<string | null, Map<string, Map<string, { body: KnowledgeStructureObject; record: string; position: number }>>>();
  let position = 0;
  const put = (root: string | null, body: KnowledgeStructureObject) => {
    const cases = byRoot.get(root) ?? new Map();
    const key = canonicalize({ source: body.source, node: (body.source as { element: string }).element, external: EXTERNAL });
    cases.set(body.object, new Map([[key, { body, record: `${position}`.padStart(64, '0'), position: position++ }]]));
    byRoot.set(root, cases);
  };
  for (const body of cases) {
    put(null, body);
    if (rooted.includes(body.object)) put(ROOT, { ...body, root: ROOT });
  }
  return { offset: null, objects: new Map(cases.map((body) => [body.object, body])), casesByRoot: byRoot, bindings: new Map(), retracted: new Set(), contradicted: new Set(), usages: [] };
}

const A = fedCase('1', { stories: ['033001'], defects: ['0077'], title: 'Case A' });
const B = fedCase('2', { stories: ['44'], defects: [], title: 'Case B' });
const C = fedCase('3', {});

test('core marks which fed-case fields do not depend on the root', () => {
  assert.deepEqual(Object.keys(ROOT_INDEPENDENT_CASE_FIELDS).sort(), ['defects', 'document', 'stories', 'title']);
  for (const key of ['commands', 'command_identities', 'path', 'command_tree_root']) assert.equal(rootIndependentField(key), false, key);
  assert.deepEqual(rootIndependentValues(A, 'stories'), ['033001']);
  assert.deepEqual(rootIndependentValues(A, 'document'), ['SYN-DOC']);
  assert.deepEqual(rootIndependentValues(A, 'title'), ['Case A']);
  assert.equal(rootIndependentValues(C, 'stories'), null, 'an unstated field is unknown, not empty');
  assert.equal(rootIndependentValues(C, 'title'), null);
});

test('identity fields match by normalized id, other fields by exact text', () => {
  assert.equal(normalizedId('00021'), '21');
  assert.equal(normalizedId('000'), '0');
  assert.equal(normalizedId('SYN-021'), 'SYN-021');
  assert.equal(onlyMatcher('stories', ['21'])!('00021'), true);
  assert.equal(onlyMatcher('defects', ['0077'])!('77'), true);
  assert.equal(onlyMatcher('document', ['7'])!('007'), false);
  assert.equal(onlyMatcher('title', ['Case A'])!('Case A'), true);
  assert.equal(onlyMatcher('stories', null), null);
});

test('a root-less projection decides only= membership for root-independent keys and stays unknown otherwise', () => {
  const cut = cutOf([A, B, C]);
  assert.equal(rootlessCases(cut, ROOT).missing, 3, 'without only every root-less case is unknown to the root');
  assert.equal(rootlessCases(cut, ROOT, 'stories', ['33001']).missing, 2, 'A matches by normalized id; C states no stories and stays unknown');
  assert.equal(rootlessCases(cut, ROOT, 'stories', ['99']).missing, 1, 'only the case without a stories field can still carry 99');
  assert.equal(rootlessCases(cut, ROOT, 'defects', ['77']).missing, 2);
  assert.equal(rootlessCases(cut, ROOT, 'document', ['OTHER']).missing, 0, 'every case states its document');
  assert.equal(rootlessCases(cut, ROOT, 'document', ['SYN-DOC']).missing, 3);
  assert.equal(rootlessCases(cut, ROOT, 'title', ['Case B']).missing, 2);
  assert.equal(rootlessCases(cut, ROOT, 'commands', ['/commands/system/show']).missing, 3, 'commands depend on the root');
  assert.equal(rootlessCases(cut, ROOT, 'path', ['/']).missing, 3);
});

test('a case projected onto the root is not missing, and the originals of the missing ones are named with counts', () => {
  const cut = cutOf([A, B, C], [A.object]);
  const rootless = rootlessCases(cut, ROOT);
  assert.equal(rootless.missing, 2);
  assert.equal(rootless.originals.length, 1);
  assert.deepEqual({ ...rootless.originals[0], records: rootless.originals[0].records.length }, { document: 'SYN-DOC', sha256: SHA, external: EXTERNAL, cases: 2, records: 2 });
  const scope = fedScope(cut, ROOT);
  assert.deepEqual(scope, { root: ROOT, originals: 1, cases: 3, projected: 1, rootless: 2, documents: [{ external: EXTERNAL, sha256: SHA, document: 'SYN-DOC', cases: 3, projected: 1, rootless: 2 }] });
});
