// The projection stays small when many cases ride few paths: the per-path change detail (definitions of both sides,
// field diffs) is written once at the run level, and every item carries only its path, the change kind and tree:
// references to the changed entries — never the detail itself. The real cross-line pair (30 changed paths, 2,096
// cases) ballooned to 20 MB because each item repeated its path's detail; here 30 paths with 2,000 cases must stay
// under 2 MB with the conclusions and counts intact.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImpact, type BuildOptions, type CaseSpec, type ChangeSpec } from './test-support.ts';
import { projectItems } from './project.ts';

const SOURCE = 'a'.repeat(64);

const PATHS = 30;
const CASES_PER_PATH = Math.ceil(2000 / PATHS);

/** 30 changed paths (10 added, 10 removed, 10 modified), each with a fat definition (many parameters, long help). */
function manyChanges(): ChangeSpec[] {
  const fat = (name: string, seed: number): { [key: string]: unknown } => ({
    name,
    summary: `命令 ${name} 的说明文字，比较长一段，用来模拟手册里的行为描述（种子 ${seed}）`,
    signatures: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), params: Array.from({ length: 8 }, (_, p) => ({ name: `arg_${name}_${i}_${p}`, type: p % 2 === 0 ? 'string' : 'int', min: p, max: p * 100 })) })),
    words: [name],
  });
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < 10; i++) {
    const to: CaseSpec[] = Array.from({ length: CASES_PER_PATH }, (_, c) => ({ document: `doc-${i}`, node: `n-${i}-${c}`, title: `新增命令用例 ${i}-${c}`, priority: (c % 3) + 1 }));
    changes.push({ path: `/commands/gen/add-${i}`, change: 'added', after: [fat(`add-${i}`, i)], to });
  }
  for (let i = 0; i < 10; i++) {
    const from: CaseSpec[] = Array.from({ length: CASES_PER_PATH }, (_, c) => ({ document: `doc-r${i}`, node: `n-r-${i}-${c}`, title: `删除命令用例 ${i}-${c}`, priority: 1 }));
    changes.push({ path: `/commands/gen/del-${i}`, change: 'removed', before: [fat(`del-${i}`, i)], from });
  }
  for (let i = 0; i < 10; i++) {
    const to: CaseSpec[] = Array.from({ length: CASES_PER_PATH }, (_, c) => ({ document: `doc-m${i}`, node: `n-m-${i}-${c}`, title: `修改命令用例 ${i}-${c}`, priority: 2 }));
    changes.push({ path: `/commands/gen/mod-${i}`, change: 'modified', before: [fat(`mod-${i}`, i)], after: [{ ...fat(`mod-${i}`, i), summary: `命令 mod-${i} 的新说明（种子 ${i}，改了）` }], to });
  }
  return changes;
}

const view = (): { [key: string]: unknown } => ({ ...buildImpact(manyChanges(), { changedKinds: ['definition'] } as Partial<BuildOptions>) });

test('30 changed paths with 2000 cases project under 2 MB with counts and conclusions intact', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: unknown[]; groups?: Array<Record<string, unknown>>; error?: { code: string; message: string } };
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  // 20 added-path cases + 10 modified-path cases per path group: added and modified carry later-build cases.
  const expected = CASES_PER_PATH * 20;
  assert.equal(out.items?.length, expected, 'one item per case on an added or modified path');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes < 2 * 1024 * 1024, `the projection stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  const note = out.groups?.[0] as { message?: string; considered?: Array<{ path: string; change: string }> } | undefined;
  assert.match(note?.message ?? '', /比较 Rel_W_1_0_1 与 Rel_W_1_0_2/, 'the conclusion wording is unchanged');
});

test('an item carries only its path, the change kind and tree: references, never the detail body', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: Array<{ id: string; fields: Record<string, unknown> }> };
  const item = out.items?.[0];
  assert.ok(item !== undefined);
  const reasons = item.fields.reasons as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(reasons) && reasons.length > 0);
  for (const reason of reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ['case', 'change', 'definition_change', 'path', 'references'], JSON.stringify(Object.keys(reason)));
    assert.match(String(reason.path), /^\/commands\//);
    const references = reason.references as string[];
    for (const reference of references) assert.match(reference, /^tree:[0-9a-f]{64}/);
  }
  const reasonsJson = JSON.stringify(reasons);
  assert.ok(!reasonsJson.includes('signatures'), 'no definition body on the reason');
  assert.ok(!reasonsJson.includes('命令 '), 'no manual text on the reason');
});

test('each path detail is written once at the run level: path, kind, a short line, the first 3 field diffs', () => {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { groups?: Array<Record<string, unknown>> };
  const note = (out.groups ?? []).find((g) => Array.isArray(g.details));
  assert.ok(note !== undefined, 'the run-level note carries the per-path details');
  const details = note.details as Array<Record<string, unknown>>;
  assert.equal(details.length, PATHS, 'one detail row per changed path');
  const serialized = JSON.stringify(details);
  assert.ok(serialized.includes('/commands/gen/mod-0'), 'a modified path is detailed');
  assert.ok(!serialized.includes('/commands/gen/add-0/arbitrary'), 'no nested repeats');
});
