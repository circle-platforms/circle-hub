// Item locations pick their source by FragmentRef.source (W01): with several sources bound to one slot (many: true), a
// fragment that names its source (the SHA-256 of the bound bytes) is resolved in that source only; without it the engine
// tries every source of the slot and still refuses ambiguity. A fragment naming a source that is not bound in the slot is
// an error.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { startPostgres, type TemporaryPostgres } from '../../testing/postgres.ts';
import { openHarness, sandboxSkip, type Harness } from './testing/harness.ts';
import { toyMap, type ToyDocument } from './testing/mindmap.ts';
import { writePack, type PackSpec } from './testing/packs.ts';

const skip = await sandboxSkip();
let postgres: TemporaryPostgres;
let h: Harness;
let packRoot: string;

/** Two documents whose node ids repeat (n1 appears in both) — the ambiguity the task is about. */
const DOC_A: ToyDocument = { id: 'docA', title: '文档甲', groups: [{ id: 'g1', text: '组', cases: [{ id: 'n1', title: '用例甲一', tags: ['function'], expected: ['结果'] }] }] };
const DOC_B: ToyDocument = { id: 'docB', title: '文档乙', groups: [{ id: 'g2', text: '组', cases: [{ id: 'n1', title: '用例乙一', tags: ['function'], expected: ['结果'] }] }] };

/** The multi-source pack: one item per case node of every bound map; the item location names the source when mode says so. */
const MULTI_PROJECT = `// Synthetic projection of the multi-source pack: one item per case node of every bound map; the location carries
// FragmentRef.source when the mode parameter says so ('source'), a foreign digest on 'foreign', and none otherwise.
export default function project(input) {
  const mode = (input.parameters && input.parameters.mode) || 'source';
  const items = [];
  let k = 0;
  for (const bound of input.inputs) {
    if (bound.slot !== 'maps') continue;
    k += 1;
    const nodes = (bound.model && bound.model.nodes) || [];
    for (const node of nodes) {
      if (!node.data || !Array.isArray(node.data.resource) || node.data.resource.length === 0) continue;
      const location = { parser: 'kityminder@1', selector: node.selector };
      if (mode === 'source') location.source = bound.sha256;
      if (mode === 'foreign') location.source = 'f'.repeat(64);
      items.push({ id: 'd' + k + ':' + (node.id || 'n' + k), label: node.text, location, fields: { title: node.text } });
    }
  }
  return { items, groups: [], warnings: [] };
}
`;

function multiPack(): PackSpec {
  return {
    id: 'toy-multi',
    version: '1.0.0',
    kind: 'workflow',
    title: '合成多源定位',
    description: '测试 FragmentRef.source 选源的合成包',
    files: {
      'workflow.json': {
        json: {
          schema: 'workflow@1',
          inputs: [{ slot: 'maps', role: 'subject', description: '多份脑图', accepts: ['application/json', 'toy:mindmap'], required: true, many: true }],
          parameters: [{ name: 'mode', description: 'source / none / foreign（合成参数）', required: false, schema: { type: 'string', enum: ['source', 'none', 'foreign'] } }],
          product: { catalogs: [] },
          subject: 'maps',
          projection: { module: 'functions/project.ts' },
        },
      },
      'requirements.json': {
        json: {
          schema: 'requirements@1',
          requirements: [{ key: 'overview', name: '整份概况', description: '整个运行的概况（合成）', target: 'run', required: true, done_rule: 'bookkeeping', layers: ['static'], accepted_producer: 'fact', checks: ['overview'], error_handling: [] }],
        },
      },
      'checks.json': { json: { schema: 'checks@1', checks: [{ id: 'overview', function: { module: 'functions/overview.ts' }, applies: 'run', judges: 'subject', tier: 'advisory' }] } },
      'slots.schema.json': { json: { schema: 'slots@1', item: {}, run: {} } },
      'SKILL.md': '# 合成多源定位\n\n测试用。\n',
      'functions/project.ts': MULTI_PROJECT,
      'functions/overview.ts': { function: 'locate/overview.ts' },
    },
  };
}

before(async () => {
  postgres = await startPostgres();
  if (skip) return;
  h = await openHarness(postgres);
  packRoot = await mkdtemp(join(tmpdir(), 'circle-hub-multi-'));
  const loaded = await h.workflows.add(await writePack(packRoot, multiPack()));
  h.workflows.assign(h.alice.id, loaded.pack.id);
});
after(async () => {
  await h?.close();
  if (packRoot !== undefined) await rm(packRoot, { recursive: true, force: true });
  await postgres?.stop();
});

describe('item locations pick their source by FragmentRef.source', { skip }, () => {
  it('two sources with the same node ids: with source, each item resolves in its own source', async () => {
    const a = await h.upload(h.alice, toyMap(DOC_A));
    const b = await h.upload(h.alice, toyMap(DOC_B));
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-multi', inputs: { maps: [{ reference: a }, { reference: b }] }, parameters: { mode: 'source' } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const items = detail.answer.run!.items;
    assert.equal(items.length, 2);
    const shaA = a.slice(4);
    const shaB = b.slice(4);
    assert.deepEqual(
      items.map((i) => i.location),
      [`src:${shaA}/kityminder@1/n/n1`, `src:${shaB}/kityminder@1/n/n1`],
      'each item located in the source its fragment names',
    );
    assert.deepEqual(detail.production!.counts, { delivered: 2, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
  });

  it('without source the same two documents are still refused as ambiguous (unchanged behavior)', async () => {
    const a = await h.upload(h.alice, toyMap(DOC_A));
    const b = await h.upload(h.alice, toyMap(DOC_B));
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-multi', inputs: { maps: [{ reference: a }, { reference: b }] }, parameters: { mode: 'none' } }, h.call());
    assert.equal(detail.answer.call_result, 'error');
    assert.ok(detail.answer.errors.some((e) => e.message.includes('份源文件里都能找到')), JSON.stringify(detail.answer.errors));
  });

  it('a fragment naming a source not bound in the slot is an error', async () => {
    const a = await h.upload(h.alice, toyMap(DOC_A));
    const b = await h.upload(h.alice, toyMap(DOC_B));
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-multi', inputs: { maps: [{ reference: a }, { reference: b }] }, parameters: { mode: 'foreign' } }, h.call());
    assert.equal(detail.answer.call_result, 'error');
    assert.ok(detail.answer.errors.some((e) => e.message.includes('没有绑定在输入槽')), JSON.stringify(detail.answer.errors));
  });

  it('without source and a single bound source the item resolves as before', async () => {
    const a = await h.upload(h.alice, toyMap(DOC_A));
    const detail = await h.service.startRunDetailed(h.alice, { pack: 'toy-multi', inputs: { maps: [{ reference: a }] }, parameters: { mode: 'none' } }, h.call());
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    assert.deepEqual(detail.answer.run!.items.map((i) => i.location), [`src:${a.slice(4)}/kityminder@1/n/n1`]);
  });
});
