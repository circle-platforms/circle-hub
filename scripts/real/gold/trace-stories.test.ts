import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { storyGold } from './trace-stories.ts';
const node = (text: string, id: string, children: unknown[] = [], resource: string[] = []) => ({ data: { text, id, resource }, children });
const map = { root: node('需求 00021 合成文档', 'root', [node('目录需求 22', 'group', [node('合成用例', 'c1', [node('期望', 'e1')], ['Functional']), node('缺陷 23', 'c2', [node('期望', 'e2')], ['Functional'])])]) };
const tree = { id: 'root', label: '需求 24', children: [{ id: '91', label: '合成标题', children: [] }] };
test('independent join uses case titles, ancestors, and tree folder requirements only', () => {
  const gold = storyGold({ ids: ['00021', '22', '23', '24', '25'], plm: [{ id: 21, status: 'synthetic', stage: 'stage-a' }], maps: [{ document: '91', map }], tree, product: 'synthetic', build: 'Synthetic_10_6' });
  assert.deepEqual(gold.stories.map(s => [s.story, s.cases.length]), [['21', 2], ['22', 2], ['23', 0], ['24', 2], ['25', 0]]);
  assert.deepEqual([gold.traced, gold.untraced, gold.plm_unread], [3, 2, 4]);
  assert.equal(gold.stories[0].status, 'synthetic');
  assert.equal(gold.stories[1].plm_returned, false);
});

test('CLI requires document scope, excludes outside documents and prints counts and digest only', () => {
  const root = mkdtempSync(join(tmpdir(), 'story-gold-'));
  try {
    mkdirSync(join(root, 'maps'));
    const files: Record<string, unknown> = { 'ids.json': ['21', '22', '23', '24'], 'plm.json': { data: [{ id: 21, status: 'synthetic' }] }, 'tree.json': tree, 'docs.json': ['91'], 'maps/91.json': map, 'maps/92.json': { root: node('需求 23', 'root', [node('额外', 'c3', [node('期望', 'e')], ['Functional'])]) } };
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value));
    const run = (docs: string) => spawnSync(process.execPath, ['scripts/real/gold/trace-stories.ts', '--stories', join(root, 'ids.json'), '--plm', join(root, 'plm.json'), '--cases-dir', join(root, 'maps'), '--tree', join(root, 'tree.json'), '--docs', join(root, docs), '--product', 'synthetic', '--build', 'Synthetic_10_6', '--out', join(root, 'out.json')], { encoding: 'utf8' });
    const r = run('docs.json'); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /需求 4/); assert.doesNotMatch(r.stdout + r.stderr, /Synthetic_10_6|合成|00021|synthetic/);
    assert.equal(JSON.parse(readFileSync(join(root, 'out.json'), 'utf8')).stories[2].cases.length, 0);
    writeFileSync(join(root, 'empty.json'), '[]');
    assert.notEqual(run('empty.json').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('zero-prefix compatibility preserves raw digit width and document identifiers', () => {
  const m = { root: node('需求 00001', 'root', [node('需求 000000002', 'c1', [node('期望', 'e1')], ['Functional'])]) };
  const t = { id: 'root', label: '需求 00003', children: [{ id: '00091', label: '合成目录', children: [] }] };
  const gold = storyGold({ ids: ['1', '2', '3'], plm: [], maps: [{ document: '00091', map: m }], tree: t, product: 'synthetic', build: 'Synthetic_10_6' });
  assert.deepEqual(gold.stories.map(s => s.cases.length), [1, 1, 1]);
});

test('independent status accounting preserves scalars and distinguishes absent fields from explicit null', () => {
  const gold = storyGold({ ids: ['21', '22', '23'], plm: [{ id: 21, stage: 0 }, { id: 22, status: 4, stage: false }, { id: 23, status: null }], maps: [], tree: [], product: 'synthetic', build: 'Synthetic_10_6' });
  assert.equal(gold.stories[0].stage, 0); assert.equal(gold.stories[1].stage, false);
  assert.deepEqual(gold.stories[0].fields_absent, ['status']); assert.equal(gold.status_absent, 1);
  assert.deepEqual(gold.statuses, [{ status: 4, count: 1 }, { status: null, count: 1 }]);
});
