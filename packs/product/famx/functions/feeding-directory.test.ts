import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import project from './feeding.ts';
import { kityminderParser } from '../../../../hub/testing/parsers.ts';
import { callPackFunction, osIsolationAvailable } from '../../../../hub/rules/api.ts';
import { startPostgres } from '../../../../hub/knowledge/test-support.ts';
import { world } from '../../../../hub/knowledge/testing/feeding-bounds-fixture.ts';
import { PRODUCT_LINE } from './naming.ts';

const bytes = 'a'.repeat(64);
const model = kityminderParser.parse(Buffer.from(JSON.stringify({
  root: { data: { id: 'root', text: 'Synthetic document' }, children: [
    { data: { id: 'case-1', text: 'Synthetic case', priority: 2, resource: ['functional'] }, children: [
      { data: { text: 'synthetic action' }, children: [{ data: { text: 'synthetic expectation' } }] },
    ] },
  ] },
}))).model;

function input(ancestors: string[], title = 'Synthetic document') {
  return {
    product: 'ORBIT', root: null, parser: 'kityminder@1', model,
    source: { system: 'agile', type: 'mindmap', key: 'SYN-DOC', bytes },
    meta: { ancestors, title, root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] } },
  };
}
function row(ancestors: string[], title = 'Synthetic document') {
  const result = project(input(ancestors, title)) as { rows: Array<{ body: { document_lines: string[] }; lines: string[]; grammar: string; conflict: boolean; missing?: Array<{missing:string;next_action:string}> }> };
  assert.equal(result.rows.length, 1);
  return result.rows[0];
}

test('case feeding binds the documented coded version and train ancestor layers', () => {
  const result = row(['ORBIT', '060：10.8.1', '004：10.8.1-R1', 'Network']);
  assert.deepEqual(result.lines, ['10.8.1']);
  assert.deepEqual(result.body.document_lines, ['10.8.1']);
  assert.equal(result.grammar, 'famx-directory@1');
  assert.equal(result.conflict, false);
});

test('case feeding retains differing coded version candidates as a conflict', () => {
  const result = row(['ORBIT', '060：10.8.1', '004：10.9.1-R1', 'Network']);
  assert.deepEqual(result.lines, ['10.8.1', '10.9.1']);
  assert.equal(result.conflict, true);
});

test('equivalent line and train versions bind once, including the existing three-component comparison', () => {
  assert.deepEqual(row(['ORBIT', '060：10.8.1', '004：10.8.1.7-R1']).lines, ['10.8.1']);
  assert.deepEqual(row(['ORBIT', '060：10.8.0', '004：10.8-R1']).lines, ['10.8']);
  assert.deepEqual(row(['ORBIT', '060：10.8']).lines, ['10.8']);
  assert.deepEqual(row(['ORBIT', '004：10.8-R1']).lines, ['10.8']);
});

test('case feeding does not invent a binding from a title, prose, or uncoded version', () => {
  for (const ancestors of [['ORBIT', 'test 10.8.1'], ['ORBIT', '10.8.1'], ['ORBIT', '060：test 10.8.1']]) {
    const result = row(ancestors, '10.8.1');
    assert.deepEqual(result.lines, []);
    assert.equal(result.conflict, false);
  }
});

test('case feeding keeps the previously declared complete manual folder form', () => {
  const result = row(['rel_famx_10_8']);
  assert.deepEqual(result.lines, ['10.8']);
  assert.equal(result.conflict, false);
});

test('an incomplete ancestor input cannot establish a version by truncation', () => {
  for (const ancestors of [Array.from({length: 65}, (_, i) => i === 0 ? '060：10.8' : 'folder'), ['060：10.8' + 'x'.repeat(1000)]]) {
    const result = row(ancestors);
    assert.deepEqual(result.lines, []);
    assert.ok(result.missing?.some(gap => gap.missing && gap.next_action));
  }
});

test('the product feeding entry returns the same directory binding through the sandbox', async () => {
  const source = input(['ORBIT', '060：10.8.1', '004：10.8.1-R1', 'Network']);
  const available = await osIsolationAvailable();
  const result = await callPackFunction(
    { packDir: fileURLToPath(new URL('../', import.meta.url)), module: 'functions/feeding.ts' },
    source, { timeoutMs: 20_000 }, { requireOsIsolation: available },
  );
  assert.equal(result.osIsolation, available);
  assert.deepEqual(result.output, JSON.parse(JSON.stringify(project(source))));
});

test('a real Hub feeding pipeline stores a bound version from coded document metadata', async t => {
  const pg = await startPostgres();
  t.after(() => pg.stop());
  const w = await world(pg);
  t.after(() => w.close());
  const meta = await w.kit.artifacts.ingest({
    bytes: Buffer.from(JSON.stringify({ id: 'SYN-DOC', root: { id: 'SYN-ROOT', title: PRODUCT_LINE.names[0] }, ancestors: ['060：10.8.0', '004：10.8-R1', 'Network'] })),
    mediaType: 'application/json', origin: { read: { object: 'agile:mindmap:SYN-DOC' } }, author: { user: null },
    provenanceType: 'observed', visibility: { readers: [w.user.id], admins: true, packs: [], shareable: false }, readTier: 'model_readable',
  });
  const layer = w.knowledge.feeding!;
  const receipt = await layer.observeSource(w.user, w.document.body.sha256, { ...w.scope, metaSource: meta.body.sha256 });
  assert.equal(receipt.objects.length, 40, JSON.stringify(receipt.pending));
  const bindings = await layer.bindingsFor(w.user, receipt.objects[0]);
  assert.ok(bindings);
  const source = bindings.items.find(item => item.body.basis === 'source_structure');
  assert.ok(source);
  assert.equal(source.body.state, 'bound');
  assert.equal(source.body.line, '10.8');
  assert.equal(source.body.grounds.grammar, 'famx-directory@1');
  assert.match(source.body.grounds.quote.reference, /\/json@1\/p\/ancestors$/);
});
