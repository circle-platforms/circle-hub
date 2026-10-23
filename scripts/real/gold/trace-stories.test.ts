import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { storyGold, parseStoryRecords } from './trace-stories.ts';
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
    const files: Record<string, unknown> = { 'ids.json': ['21', '22', '23', '24'], 'plm.json': { code: 1000, data: [{ id: 21, status: 'synthetic' }] }, 'tree.json': tree, 'docs.json': ['91'], 'maps/91.json': map, 'maps/92.json': { root: node('需求 23', 'root', [node('额外', 'c3', [node('期望', 'e')], ['Functional'])]) } };
    for (const [name, value] of Object.entries(files)) writeFileSync(join(root, name), JSON.stringify(value));
    const run = (docs: string, withPlm = true) => spawnSync(process.execPath, ['scripts/real/gold/trace-stories.ts', '--stories', join(root, 'ids.json'), '--plm', ...(withPlm ? [join(root, 'plm.json')] : []), '--cases-dir', join(root, 'maps'), '--tree', join(root, 'tree.json'), '--docs', join(root, docs), '--product', 'synthetic', '--build', 'Synthetic_10_6', '--out', join(root, 'out.json')], { encoding: 'utf8' });
    const r = run('docs.json'); assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /需求 4/); assert.doesNotMatch(r.stdout + r.stderr, /Synthetic_10_6|合成|00021|synthetic/);
    assert.equal(JSON.parse(readFileSync(join(root, 'out.json'), 'utf8')).stories[2].cases.length, 0);
    assert.equal(run('docs.json', false).status, 1, 'a bare --plm flag is not evidence of a successful response');
    writeFileSync(join(root, 'maps/91.json'), JSON.stringify({ root: node('合成占用 ' + Array.from({ length: 90 }, (_, i) => String(i + 10)).join(' '), 'root', [node('需求 01', 'case', [node('期望', 'e')], ['Functional'])]) }));
    const exhausted = run('docs.json'); assert.equal(exhausted.status, 0, exhausted.stderr);
    assert.doesNotMatch(exhausted.stdout + exhausted.stderr, /合成占用|Synthetic_10_6|需求 01/);
    writeFileSync(join(root, 'empty.json'), '[]');
    assert.notEqual(run('empty.json').status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('raw identifier extraction preserves digit width and document identifiers', () => {
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

test('zero-prefix compatibility ignores structural ids and has room for ordinary date and time labels', () => {
  for (const title of ['合成用例 09:30 检查', '合成用例 2026-01-02 03:04:05 06/07 08 09 00']) {
    const notes = Array.from({ length: 10 }, (_, i) => node('合成说明', `node-${90 + i}`));
    const m = { root: node('合成根', 'root', [...notes, node(title, 'case', [node('期望', 'expected')], ['Functional'])]) };
    const gold = storyGold({ ids: ['21'], plm: [], maps: [{ document: '91', map: m }], tree, product: 'synthetic', build: 'Synthetic_10_6' });
    assert.equal(gold.stories[0].cases.length, 0);
  }
});

test('notes-only documents contribute a count without aborting the scoped answer, malformed maps still fail', () => {
  const notes = { root: node('合成说明', 'notes', [node('仅说明内容', 'leaf')]) };
  const gold = storyGold({ ids: ['21'], plm: [], maps: [{ document: '90', map: notes }, { document: '91', map }], tree, product: 'synthetic', build: 'Synthetic_10_6' });
  assert.equal(gold.documents, 2); assert.equal(gold.documents_without_cases, 1); assert.equal(gold.stories[0].cases.length, 2);
  assert.throws(() => storyGold({ ids: ['21'], plm: [], maps: [{ document: '91', map: null }], tree, product: 'synthetic', build: 'Synthetic_10_6' }));
});


test('story originals require a successful raw PLM envelope, never projected content or bare arrays', () => {
  const rows = [{ id: 21, status: 3, stage: 'synthetic' }];
  assert.deepEqual(parseStoryRecords({ code: 1000, data: rows }), rows);
  for (const raw of [rows, { stories: rows, unread: [] }, { data: rows }, { code: '1000', data: rows }, { code: 1005, data: rows }, { code: 1000, data: { stories: rows } }]) assert.throws(() => parseStoryRecords(raw), /PLM 原件/);
});

test('ordinary step and time numbers cannot exhaust the identifier oracle', () => {
  const steps = Array.from({ length: 90 }, (_, index) => node(`ping 192.0.2.${index + 10}`, `step${index}`));
  const corpus = { root: node('需求 00021', 'root', [
    node('合成用例', 'case-one', steps, ['Functional']),
    node('合成用例 09:30 定时检查', 'case-two', [node('期望', 'expected')], ['Functional']),
  ]) };
  const gold = storyGold({ ids: ['21'], plm: [], maps: [{ document: 'synthetic-doc', map: corpus }], tree: [], product: 'synthetic', build: 'Synthetic_10_6' });
  assert.equal(gold.stories[0].cases.length, 2);
});

test('the independent gold counts non-scalar state separately from explicit null', () => {
  const gold = storyGold({ ids: ['21', '22'], plm: [{ id: 21, status: { raw: 'synthetic' }, stage: ['synthetic'] }, { id: 22, status: null, stage: null }], maps: [], tree: [], product: 'synthetic', build: 'Synthetic_10_6' });
  assert.deepEqual(gold.stories[0].fields_nonscalar, ['status', 'stage']);
  assert.deepEqual([gold.status_nonscalar, gold.stage_nonscalar, gold.status_absent], [1, 1, 0]);
  assert.deepEqual(gold.statuses, [{ status: null, count: 1 }]);
});

test('story gold independently follows the published nonzero leading-zero rule', async () => {
  const {extractAssociatedIds}=await import('./locations.ts');
  assert.deepEqual(extractAssociatedIds('缺陷 0910011 合成',[]).bugs,['0910011']);
  assert.deepEqual(extractAssociatedIds('需求 00021 合成',[]).stories,['00021']);
  assert.deepEqual(extractAssociatedIds('缺陷 00；需求 000',[]).associatedIds,[]);
  const value=storyGold({ids:['21'],plm:[{id:21}],maps:[{document:'91',map}],tree:{id:'root',label:'需求 00021',children:[{id:'91',label:'合成文档',children:[]}]},product:'synthetic',build:'Synthetic_10_6'});
  assert.equal(value.stories[0].cases.length,2);
  const folderOnly=storyGold({ids:['21'],plm:[],maps:[{document:'91',map:{root:node('合成文档','root',[node('合成用例','c1',[node('期望','e1')],['Functional'])])}}],tree:{id:'root',label:'需求 00021',children:[{id:'91',label:'合成文档',children:[]}]},product:'synthetic',build:'Synthetic_10_6'});
  assert.equal(folderOnly.stories[0].cases.length,1, 'folder-only leading-zero story ids use the story rule');
});

test('story gold keeps raw requirement labels on documents with conforming locations',()=>{
  const doc={id:'91',label:'需求 00021 合成文档',children:[]};
  const tree={id:'root',label:'合成根',children:[{id:'line',label:'10.6',children:[{id:'train',label:'10.6-R1',children:[{id:'module',label:'模块甲',children:[doc]}]}]}]};
  const result=storyGold({ids:['21'],plm:[],maps:[{document:'91',map:{root:node('文档','root',[node('用例','c1',[node('期望','e1')],['Functional'])])}}],tree,product:'synthetic',build:'Synthetic_10_6'});
  assert.equal(result.stories[0].cases.length,1);
});
