// Tests of the feeding-layer view reads (the kb-feeding-views task, docs/hub-r4-tasks/kb-feeding.md): the views over a
// seedling read "locked seedling + feeding layer before the frozen offset"; undeclared-version and contradicted objects
// are counted apart and never enter version differences; when neither the roots nor the layer hold a fed kind, the view
// says so plainly and names the way in (used = fed). All names are synthetic (line 10.8); addresses are in 192.0.2.0/24.
// The feeding bodies are synthetic shapes as the Hub-side write path (kb-feeding-hub) stores them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeWorld, catalogXml } from './test-support.ts';
import { boundLines } from './feeding-reader.ts';
import type { FeedingCut, FeedingReader, KnowledgeStructureObject } from './feeding-types.ts';
import type { VersionBinding } from '../../contracts/src/feeding.ts';

const H = (n: number): string => 'f'.repeat(60) + String(n).padStart(4, '0');

function undeclaredBinding(object: string): VersionBinding {
  return { schema: 'version-binding@1', object, product: 'acme', line: null, basis: 'source_structure', grounds: { quote: { identity: { source_sha256: H(9), parser: 'json@1', path: '/l', span: { unit: 'byte', offset: 0, length: 3 } }, text: '' }, grammar: 'demo@1' }, state: 'undeclared', candidates: [], missing: '目录里没有版本层', next_action: '改目录后下一次读到自动绑定' };
}
function boundBinding(object: string, line: string): VersionBinding {
  return { schema: 'version-binding@1', object, product: 'acme', line, basis: 'source_structure', grounds: { quote: { identity: { source_sha256: H(9), parser: 'json@1', path: '/l', span: { unit: 'byte', offset: 0, length: 3 } }, text: line }, grammar: 'demo@1' }, state: 'bound', candidates: [] };
}

function fedCase(n: number): KnowledgeStructureObject & { position: number } {
  return {
    schema: 'fed-case@1', object: H(n), product: 'acme', root: null, path: null,
    autoid: `SYN-${n}`, priority: 2, resources: ['合成资源'],
    steps: [{ text: '在 192.0.2.10 的设备上执行合成步骤' }], expects: [{ text: '合成期望' }],
    commands: [], unparsed_steps: 0, document_lines: ['10.8'], position: n,
  } as KnowledgeStructureObject & { position: number };
}

test('boundLines separates bound lines, conflict candidates and undeclared; nothing is resolved by picking', () => {
  const declaredBound: VersionBinding = { schema: 'version-binding@1', object: H(1), product: 'acme', line: '10.9', basis: 'declared', grounds: { by: 'u1', run: 'r1' }, state: 'bound', candidates: [] };
  const conflict: VersionBinding = { schema: 'version-binding@1', object: H(2), product: 'acme', line: null, basis: 'source_structure', grounds: { quote: { identity: { source_sha256: H(9), parser: 'json@1', path: '/l', span: { unit: 'byte', offset: 0, length: 3 } }, text: '?' }, grammar: 'demo@1' }, state: 'conflict', candidates: ['10.8', '10.9'] };
  const { bound, conflicts, undeclared } = boundLines(([boundBinding(H(1), '10.8'), declaredBound, conflict, undeclaredBinding(H(3))] as const) as unknown as readonly VersionBinding[]);
  assert.deepEqual(bound, ['10.8', '10.9']);
  assert.deepEqual(conflicts, [['10.8', '10.9']]);
  assert.equal(undeclared, true);
});

async function readFacets(w: Awaited<ReturnType<typeof makeWorld>>): Promise<string[]> {
  const read = await w.knowledge.views.read('knowledge:facets:acme:Synthetic_10_6?kind=case&by=module', { principal: w.user, run: null, purpose: '喂入层视图测试' });
  assert.ok(read.ok, read.ok ? '' : JSON.stringify(read.reason));
  if (!read.ok) return [];
  const bytes = await w.kit.artifacts.source(w.user, read.artifacts[0].artifact.body.sha256, { consumer: 'function' });
  const value = JSON.parse(new TextDecoder().decode(bytes?.bytes ?? new Uint8Array())) as { notes?: string[] };
  assert.ok(bytes?.bytes != null, '视图工件可读');
  return value.notes ?? [];
}

test('a view over roots that hold no cases reads the feeding layer and counts undeclared and contradicted apart', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const cut: FeedingCut = {
    offset: null,
    objects: new Map([[H(1), fedCase(1)], [H(2), fedCase(2)]]),
    bindings: new Map([[H(1), [undeclaredBinding(H(1))]], [H(2), [boundBinding(H(2), '10.8')]]]),
    retracted: new Set(),
    contradicted: new Set([H(2)]),
    usages: [],
  };
  const reader: FeedingReader = { cut: async (product: string) => (product === 'acme' ? cut : null), frozenOffset: async () => null };
  const w = await makeWorld(pg, { knowledge: { feeding: reader }, pack: { functions: { 'plan.ts': `export default input => ({fetch:[],builds:[{name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:'2026-10-24T00:00:00.000Z',released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}}],done:true});` } } });
  t.after(() => w.close());
  await w.external.set('site:tree:synthetic', { bytes: catalogXml({ net: [{ name: 'status', help: '合成命令' }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const notes = await readFacets(w);
  assert.ok(notes.some((note) => note.includes('喂入层')), notes.join('；'));
  assert.ok(notes.some((note) => note.includes('版本未声明')), notes.join('；'));
  assert.ok(notes.some((note) => note.includes('矛盾')), notes.join('；'));
});

test('an empty feeding layer says plainly that this version has not been used yet, and names the way in', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const reader: FeedingReader = { cut: async () => null, frozenOffset: async () => null };
  const w = await makeWorld(pg, { knowledge: { feeding: reader }, pack: { functions: { 'plan.ts': `export default input => ({fetch:[],builds:[{name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:'2026-10-24T00:00:00.000Z',released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}}],done:true});` } } });
  t.after(() => w.close());
  await w.external.set('site:tree:synthetic', { bytes: catalogXml({ net: [{ name: 'status', help: '合成命令' }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const notes = await readFacets(w);
  assert.ok(notes.some((note) => note.includes('还没有被用到过')), notes.join('；'));
});

test('without any feeding reader the old note stands (the transition: old roots keep their meaning)', async t => {
  const pg = await (await import('./test-support.ts')).startPostgres();
  t.after(() => pg.stop());
  const w = await makeWorld(pg, { pack: { functions: { 'plan.ts': `export default input => ({fetch:[],builds:[{name:'Synthetic_10_6',base:'Synthetic_10_6',family:'ACME',line:'10.6',platform:null,built_at:'2026-10-24T00:00:00.000Z',released_at:'2026-10-24T00:00:00.000Z',sources:{tree:'site:tree:synthetic'}}],done:true});` } } });
  t.after(() => w.close());
  await w.external.set('site:tree:synthetic', { bytes: catalogXml({ net: [{ name: 'status', help: '合成命令' }] }), mediaType: 'application/xml' });
  await w.knowledge.syncProduct(w.product, { by: w.admin });
  const notes = await readFacets(w);
  assert.ok(!notes.some((note) => note.includes('喂入层')), notes.join('；'));
  assert.ok(notes.some((note) => note.includes('根里没有')), notes.join('；'));
});
