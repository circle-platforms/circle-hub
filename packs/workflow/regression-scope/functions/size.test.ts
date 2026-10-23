// The projection and the check outputs stay bounded in the real shape: 2,096 cases with 60-character Chinese titles,
// each attached to 5 changed paths with two tree references per path. The per-item case data is written once, a reason
// is only the index of its path in the run-level details and the change kind, and the tree references live once per
// path in note.details. The checks repeat none of that: one short statement, one ground, the detail indexes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImpact, type CaseSpec, type ChangeSpec } from './test-support.ts';
import { checkOutcomes } from './check.ts';
import { projectItems } from './test-support.ts';

const SOURCE = 'a'.repeat(64);
const PATHS = 30;
const CASES = 2096;
const TITLE = '健康检查间隔较长时页面应当正确显示告警信息并自动摘除故障后端的用例标题';

/** 30 changed paths (10 added, 10 removed, 10 modified) with fat definitions; each of the 2,096 cases on 5 paths. */
function manyChanges(): ChangeSpec[] {
  const fat = (name: string, seed: number): { [key: string]: unknown } => ({
    name,
    summary: `命令 ${name} 的说明文字，比较长一段，用来模拟手册里的行为描述（种子 ${seed}）`,
    signatures: Array.from({ length: 6 }, (_, i) => ({ id: String(i + 1), params: Array.from({ length: 8 }, (_, p) => ({ name: `arg_${name}_${i}_${p}`, type: p % 2 === 0 ? 'string' : 'int', min: p, max: p * 100 })) })),
    words: [name],
  });
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < 10; i++) changes.push({ path: `/commands/gen/add-${i}`, change: 'added', after: [fat(`add-${i}`, i)] });
  for (let i = 0; i < 10; i++) changes.push({ path: `/commands/gen/del-${i}`, change: 'removed', before: [fat(`del-${i}`, i)] });
  for (let i = 0; i < 10; i++) changes.push({ path: `/commands/gen/mod-${i}`, change: 'modified', before: [fat(`mod-${i}`, i)], after: [{ ...fat(`mod-${i}`, i), summary: `命令 mod-${i} 的新说明（种子 ${i}，改了）` }] });
  for (let c = 0; c < CASES; c++) {
    const spec: CaseSpec = { document: `doc-${c % 40}`, node: `n-${c}`, title: `${TITLE}（第 ${c} 号）`, priority: (c % 3) + 1 };
    for (let k = 0; k < 5; k++) {
      const change = changes[(c + k * 6) % PATHS];
      if (change.change === 'removed') (change.from ??= []).push(spec);
      else (change.to ??= []).push(spec);
    }
  }
  return changes;
}

const view = (): { [key: string]: unknown } => ({ ...buildImpact(manyChanges(), { changedKinds: ['definition'] } as Parameters<typeof buildImpact>[1]) });

function projected() {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: Array<{ id: string; label: string; location: unknown; fields: Record<string, unknown> }>; groups?: Array<Record<string, unknown>>; error?: { code: string; message: string } };
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  const items = out.items ?? [];
  const subject = { items: items.map((item) => ({ id: item.id, label: item.label, location: item.location, fields: item.fields })), note: out.groups?.[0] };
  return { out, items, subject };
}

test('the projection of 2,096 real-shaped cases stays under 2 MB with counts and conclusions intact', () => {
  const { out, items } = projected();
  // Cases land on added or modified paths only (a removed path is out of scope): 20 of 30 paths carry them.
  assert.equal(items.length, CASES, 'every case lands at least one in-scope path');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes < 2 * 1024 * 1024, `the projection stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  const note = out.groups?.[0] as { message?: string; details?: Array<Record<string, unknown>> } | undefined;
  assert.match(note?.message ?? '', /比较 Rel_W_1_0_1 与 Rel_W_1_0_2/, 'the conclusion wording is unchanged');
  assert.equal(note?.details?.length, PATHS, 'one detail row per changed path');
});

test('a reason is only the detail index and the change kind; case data and the ground are once per item', () => {
  const { items } = projected();
  const item = items[0];
  assert.ok(item !== undefined);
  assert.deepEqual(Object.keys(item.fields).sort(), ['document', 'negative', 'node', 'priority', 'reasons'], JSON.stringify(Object.keys(item.fields)));
  const reasons = item.fields.reasons as Array<Record<string, unknown>>;
  assert.ok(reasons.length >= 3, 'at least three in-scope changed paths under one case');
  for (const reason of reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ['change', 'detail'], JSON.stringify(reason));
    assert.ok(Number.isInteger(reason.detail), 'the reason names its path by the details index');
  }
  assert.ok(String((item as unknown as { location: { selector: string } }).location.selector).startsWith('p/entries/'), 'the item’s ground is its location, not a repeated reference');
  const reasonsJson = JSON.stringify(reasons);
  assert.ok(!reasonsJson.includes('tree:'), 'no tree reference on a reason');
  assert.ok(!reasonsJson.includes('/commands/'), 'no path string on a reason');
});

test('each check output of the 2,096 items stays under 2 MB with verdicts and counts intact', () => {
  const { subject } = projected();
  const inScope = checkOutcomes('in_scope', subject);
  const uncovered = checkOutcomes('uncovered_changes', subject);
  assert.equal(inScope.filter((o) => o.verdict === 'support').length, CASES);
  for (const [name, outcomes] of [['in_scope', inScope], ['uncovered_changes', uncovered]] as const) {
    const bytes = Buffer.byteLength(JSON.stringify(outcomes), 'utf8');
    assert.ok(bytes < 2 * 1024 * 1024, `${name} stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }
  const outcome = inScope[0];
  assert.ok(outcome.grounds.length <= 1, 'one ground reference per outcome');
  assert.ok(!JSON.stringify(outcome).includes('signatures'), 'no definition body in the outcome');
});
