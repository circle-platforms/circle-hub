// The sweep projection stays small when many cases ride few paths: the per-path field differences are written once
// in the run-level note (note.details), and every item carries only its code, path, change kind and tree: references
// — never the diff body. The real pair (30 changed paths, 1,147 earlier cases) ballooned to 60 MB because each item
// repeated its path's fields and both sides' definitions; here 30 paths with 2,000 cases must stay under 2 MB with
// the items, the note and the 字段差异 wording intact.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImpact, SOURCE, type ChangeSpec } from './test-support.ts';
import { projectItems } from './project.ts';

const PATHS = 30;
const CASES_PER_PATH = Math.ceil(2000 / PATHS);

/** 30 changed paths (10 removed, 10 modified with earlier-build cases on them, 10 added without), each with a fat definition. */
function manyChanges(): ChangeSpec[] {
  const fat = (name: string, seed: number): { [key: string]: unknown } => ({
    name,
    help: `命令 ${name} 的帮助文字，比较长一段，用来模拟手册里的说明（种子 ${seed}）`,
    args: Array.from({ length: 8 }, (_, p) => ({ name: `arg_${name}_${p}`, type: p % 2 === 0 ? 'string' : 'int', min: p, max: p * 100 })),
  });
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < 10; i++) {
    const from = Array.from({ length: CASES_PER_PATH }, (_, c) => ({ document: `doc-r${i}`, node: `n-${i}-${c}`, title: `删除命令上的用例 ${i}-${c}`, priority: 1 }));
    changes.push({ path: `/commands/gen/del-${i}`, change: 'removed', before: [fat(`del-${i}`, i)], from });
  }
  for (let i = 0; i < 10; i++) {
    const from = Array.from({ length: CASES_PER_PATH }, (_, c) => ({ document: `doc-m${i}`, node: `n-${i}-${c}`, title: `修改命令上的用例 ${i}-${c}`, priority: 2 }));
    changes.push({ path: `/commands/gen/mod-${i}`, change: 'modified', before: [fat(`mod-${i}`, i)], after: [{ ...fat(`mod-${i}`, i), help: `命令 mod-${i} 的新帮助（种子 ${i}，改了）` }], from });
  }
  for (let i = 0; i < 10; i++) {
    changes.push({ path: `/commands/gen/add-${i}`, change: 'added', after: [fat(`add-${i}`, i)] });
  }
  return changes;
}

const view = (): { [key: string]: unknown } => ({ ...buildImpact(manyChanges()) });

test('30 changed paths with 2000 earlier cases project under 2 MB with the items and the note intact', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: unknown[]; groups?: Array<Record<string, unknown>>; error?: { code: string; message: string } };
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  assert.equal(out.items?.length, CASES_PER_PATH * 20, 'one item per earlier case on a removed or modified path');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes < 2 * 1024 * 1024, `the projection stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  const note = out.groups?.[0] as { message?: string; details?: Array<Record<string, unknown>> } | undefined;
  assert.match(note?.message ?? '', /比较 Rel_W_1_0_1 与 Rel_W_1_0_2。有 1340 条用例需要维护/, 'the conclusion wording and the count are unchanged');
  assert.equal(note?.details?.length, 20, 'one detail row per changed path that carries maintenance cases');
});

test('an item carries only its code, path, change kind and tree: references, never the diff body', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: Array<{ id: string; fields: Record<string, unknown> }> };
  const item = out.items?.[0];
  assert.ok(item !== undefined);
  const reasons = item.fields.reasons as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(reasons) && reasons.length > 0);
  for (const reason of reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ['case', 'change', 'code', 'path', 'references'], JSON.stringify(Object.keys(reason)));
    assert.match(String(reason.path), /^\/commands\//);
    for (const reference of reason.references as string[]) assert.match(reference, /^tree:[0-9a-f]{64}/);
  }
  const reasonsJson = JSON.stringify(reasons);
  assert.ok(!reasonsJson.includes('帮助'), 'no manual text on the reason');
  assert.ok(!reasonsJson.includes('args'), 'no definition body on the reason');
});

test('the field differences of one path are written once at the run level, shared by the cases on it', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { groups?: Array<Record<string, unknown>> };
  const note = (out.groups ?? []).find((g) => Array.isArray(g.details));
  assert.ok(note !== undefined, 'the run-level note carries the per-path details');
  const details = note.details as Array<{ path: string; change: string; fields: Array<{ path: string; before: unknown; after: unknown }> }>;
  const modified = details.filter((d) => d.change === 'modified');
  assert.equal(modified.length, 10);
  for (const row of modified) {
    assert.ok(row.fields.length > 0, `${row.path} keeps its field differences once`);
    assert.ok(JSON.stringify(row.fields).includes('help'), 'the help diff is on the detail row');
  }
  const serialized = JSON.stringify(out.groups ?? []);
  const occurrences = serialized.split('/commands/gen/mod-0').length - 1;
  assert.ok(occurrences <= 3, `the modified path is not repeated per case (${occurrences} occurrences)`);
});
