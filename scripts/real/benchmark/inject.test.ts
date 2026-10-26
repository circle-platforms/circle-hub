import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INJECT_KINDS, injectDefects, type MapNode, type MindMap } from './inject.ts';

// Invented mind map: a document root, two groups, cases with tags and one expected result each; some negative.
function sample(): MindMap {
  let n = 0;
  const id = () => `n${++n}`;
  const expected = (text: string): MapNode => ({ data: { id: id(), text } });
  const caseNode = (text: string, tags: string[], result: string): MapNode => ({ data: { id: id(), text, priority: 2, resource: tags }, children: [expected(result)] });
  return {
    root: {
      data: { id: id(), text: '文档标题' },
      children: [
        {
          data: { id: id(), text: '功能', priority: 1 },
          children: Array.from({ length: 8 }, (_, i) => caseNode(`功能用例 ${i + 1}`, ['configuration'], `结果 ${i + 1}`)),
        },
        {
          data: { id: id(), text: '反向', priority: 1 },
          children: Array.from({ length: 4 }, (_, i) => caseNode(`反向用例 ${i + 1}`, ['negative'], `报错 ${i + 1}`)),
        },
      ],
    },
    template: 'default',
    version: '1.4.43',
  };
}

const allCases = (m: MindMap): MapNode[] => {
  const out: MapNode[] = [];
  const walk = (x: MapNode) => {
    if (Array.isArray(x.data.resource) && x.data.resource.length > 0) out.push(x);
    (x.children ?? []).forEach(walk);
  };
  walk(m.root);
  return out;
};

test('injection leaves the input alone and is repeatable by seed', () => {
  const input = sample();
  const frozen = JSON.stringify(input);
  const a = injectDefects(input, { documentId: '7', seed: 5, counts: { duplicate_title: 2, empty_expected: 1 } });
  assert.equal(JSON.stringify(input), frozen);
  const b = injectDefects(input, { documentId: '7', seed: 5, counts: { duplicate_title: 2, empty_expected: 1 } });
  assert.deepEqual(a.truth, b.truth);
  assert.equal(JSON.stringify(a.map), JSON.stringify(b.map));
  const c = injectDefects(input, { documentId: '7', seed: 6, counts: { duplicate_title: 2, empty_expected: 1 } });
  assert.notEqual(JSON.stringify(a.truth), JSON.stringify(c.truth), 'another seed picks other cases');
});

test('each defect kind does what its truth entry says and sits on a distinct case', () => {
  const input = sample();
  const result = injectDefects(input, {
    documentId: '7',
    seed: 1,
    counts: { duplicate_title: 1, empty_title: 1, bad_priority: 1, no_expected: 1, two_expected: 1, empty_expected: 1 },
  });
  assert.equal(result.shortfalls.length, 0);
  assert.equal(result.truth.length, 6);
  assert.deepEqual(new Set(result.truth.map((t) => t.kind)), new Set(['duplicate_title', 'empty_title', 'bad_priority', 'no_expected', 'two_expected', 'empty_expected']));
  assert.equal(new Set(result.truth.map((t) => t.item)).size, 6, 'one defect per case');
  const mutated = allCases(result.map);
  const byItem = new Map(mutated.map((c) => [`7:${c.data.id}`, c]));
  for (const t of result.truth) {
    const node = byItem.get(t.item as string);
    assert.ok(node, `${t.kind}: the item exists in the mutated document`);
    const kids = (node.children ?? []).filter((k) => (k.children ?? []).length === 0);
    if (t.kind === 'empty_title') assert.equal(node.data.text, '');
    if (t.kind === 'bad_priority') assert.equal(node.data.priority, 9);
    if (t.kind === 'no_expected') assert.equal(kids.length, 0);
    if (t.kind === 'two_expected') assert.equal(kids.length, 2);
    if (t.kind === 'empty_expected') assert.equal(kids.some((k) => k.data.text === ''), true);
    if (t.kind === 'duplicate_title') assert.equal(mutated.filter((c) => c.data.text === node.data.text).length, 2);
  }
  assert.equal(mutated.length, allCases(input).length + 1, 'only the duplicate adds a case');
});

test('removing the negative group removes every negative case and reports a document-level defect', () => {
  const result = injectDefects(sample(), { documentId: '7', seed: 3, counts: { remove_negative: 1, empty_title: 2 } });
  const remaining = allCases(result.map);
  assert.ok(remaining.every((c) => !(c.data.resource as string[]).includes('negative')));
  assert.equal(remaining.length, 8);
  const doc = result.truth.find((t) => t.kind === 'remove_negative');
  assert.deepEqual(doc && [doc.item, doc.node], [null, null]);
  assert.ok(result.truth.filter((t) => t.kind === 'empty_title').every((t) => t.item?.startsWith('7:n')));
  assert.ok(result.truth.filter((t) => t.kind === 'empty_title').every((t) => !(allCases(sample()).find((c) => `7:${c.data.id}` === t.item)?.data.resource as string[]).includes('negative')), 'no defect lands on a case that was removed');
});

test('asking for more defects than there are cases reports the shortfall instead of failing', () => {
  const result = injectDefects(sample(), { documentId: '7', seed: 2, counts: { empty_title: 50 } });
  assert.equal(result.truth.length, 12);
  assert.deepEqual(result.shortfalls, [{ kind: 'empty_title', wanted: 50, placed: 12 }]);
  assert.deepEqual(injectDefects(sample(), { documentId: '7', seed: 2, counts: { remove_negative: 1 } }).shortfalls, []);
  const noNegatives = sample();
  noNegatives.root.children = [noNegatives.root.children?.[0] as MapNode];
  assert.deepEqual(injectDefects(noNegatives, { documentId: '7', seed: 2, counts: { remove_negative: 1 } }).shortfalls, [{ kind: 'remove_negative', wanted: 1, placed: 0 }]);
});

test('every kind is exercised by name', () => {
  assert.equal(INJECT_KINDS.length, 7);
});

test('negative removal uses exact declared resource values and preserves undeclared variants',()=>{
 const map:MindMap={root:{data:{id:'root'},children:['negative','Negative','[negative]','负向'].map((tag,i)=>({data:{id:'c'+i,text:'合成用例',resource:[tag]},children:[{data:{id:'e'+i,text:'合成期望'}}]}))}};
 const result=injectDefects(map,{documentId:'7',seed:1,counts:{remove_negative:1}});
 assert.deepEqual(result.map.root.children?.map(node=>node.data.resource),[['Negative'],['[negative]'],['负向']]);
 assert.equal(map.root.children?.length,4);
});
