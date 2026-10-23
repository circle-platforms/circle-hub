// The sweep projection and the two check outputs stay bounded in the real shape: 2,096 earlier-build cases with
// 60-character Chinese titles, each on 5 changed paths with two tree references per path. Case data is written once
// per item, a reason is only the detail index and the change kind, and tree references plus field differences live
// once per path in note.details. The checks repeat none of that: one short statement, one ground, the detail indexes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildImpact, SOURCE, type CaseSpec, type ChangeSpec } from './test-support.ts';
import { checkOutcomes } from './check.ts';
import { projectItems } from './test-support.ts';

const PATHS = 30;
const CASES = 2096;
const TITLE = '健康检查间隔较长时页面应当正确显示告警信息并自动摘除故障后端的用例标题';

/** 30 changed paths (15 removed, 15 modified) with fat definitions; each of the 2,096 earlier cases on 5 paths. */
function manyChanges(): ChangeSpec[] {
  const fat = (name: string, seed: number): { [key: string]: unknown } => ({
    name,
    help: `命令 ${name} 的帮助文字，比较长一段，用来模拟手册里的说明（种子 ${seed}）`,
    args: Array.from({ length: 8 }, (_, p) => ({ name: `arg_${name}_${p}`, type: p % 2 === 0 ? 'string' : 'int', min: p, max: p * 100 })),
  });
  const changes: ChangeSpec[] = [];
  for (let i = 0; i < 15; i++) changes.push({ path: `/commands/gen/del-${i}`, change: 'removed', before: [fat(`del-${i}`, i)] });
  for (let i = 0; i < 15; i++) changes.push({ path: `/commands/gen/mod-${i}`, change: 'modified', before: [fat(`mod-${i}`, i)], after: [{ ...fat(`mod-${i}`, i), help: `命令 mod-${i} 的新帮助（种子 ${i}，改了）` }] });
  for (let c = 0; c < CASES; c++) {
    const spec: CaseSpec = { document: `doc-${c % 40}`, node: `n-${c}`, title: `${TITLE}（第 ${c} 号）`, priority: (c % 3) + 1 };
    for (let k = 0; k < 5; k++) (changes[(c + k * 6) % PATHS].from ??= []).push(spec);
  }
  return changes;
}

const view = (): { [key: string]: unknown } => ({ ...buildImpact(manyChanges()) });

function projected() {
  const out = projectItems({ inputs: [{ slot: 'impact', sha256: SOURCE, model: view() }], parameters: {}, context: {} }) as { items?: Array<{ id: string; label: string; location: unknown; fields: Record<string, unknown> }>; groups?: Array<Record<string, unknown>>; error?: { code: string; message: string } };
  assert.equal(out.error, undefined, JSON.stringify(out.error));
  const items = out.items ?? [];
  const subject = { items: items.map((item) => ({ id: item.id, label: item.label, location: item.location, fields: item.fields })), note: out.groups?.[0] };
  return { out, items, subject };
}

test('the sweep of 2,096 real-shaped earlier cases stays under 2 MB with the items and the note intact', () => {
  const { out, items } = projected();
  assert.equal(items.length, CASES, 'one item per earlier case');
  const bytes = Buffer.byteLength(JSON.stringify(out), 'utf8');
  assert.ok(bytes < 2 * 1024 * 1024, `the projection stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  const note = out.groups?.[0] as { message?: string; details?: Array<Record<string, unknown>> } | undefined;
  assert.match(note?.message ?? '', /条用例需要维护/, 'the conclusion wording is unchanged');
  assert.equal(note?.details?.length, PATHS, 'one detail row per changed path');
});

test('a reason is only the detail index and the change kind; case data and the ground are once per item', () => {
  const { items } = projected();
  const item = items[0];
  assert.ok(item !== undefined);
  assert.deepEqual(Object.keys(item.fields).sort(), ['document', 'negative', 'node', 'priority', 'reasons'], JSON.stringify(Object.keys(item.fields)));
  const reasons = item.fields.reasons as Array<Record<string, unknown>>;
  assert.equal(reasons.length, 5, 'five changed paths under one case');
  for (const reason of reasons) {
    assert.deepEqual(Object.keys(reason).sort(), ['change', 'detail'], JSON.stringify(reason));
    assert.ok(Number.isInteger(reason.detail), 'the reason names its path by the details index');
  }
  assert.ok(String((item as unknown as { location: { selector: string } }).location.selector).startsWith('p/entries/'), 'the item’s ground is its location, not a repeated reference');
  const reasonsJson = JSON.stringify(reasons);
  assert.ok(!reasonsJson.includes('tree:'), 'no tree reference on a reason');
  assert.ok(!reasonsJson.includes('/commands/'), 'no path string on a reason');
});

test('both check outputs of the 2,096 items stay under 2 MB with verdicts and counts intact', () => {
  const { subject } = projected();
  const exists = checkOutcomes('command_exists', subject);
  const unchanged = checkOutcomes('command_unchanged', subject);
  // Every case rides at least one removed path and one modified path (step-6 attachment), so every item refutes once per check.
  assert.equal(exists.filter((o) => o.verdict === 'refute').length, CASES);
  assert.equal(unchanged.filter((o) => o.verdict === 'refute').length, CASES);
  for (const [name, outcomes] of [['command_exists', exists], ['command_unchanged', unchanged]] as const) {
    const bytes = Buffer.byteLength(JSON.stringify(outcomes), 'utf8');
    assert.ok(bytes < 2 * 1024 * 1024, `${name} stays small: ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  }
  const outcome = unchanged.find((o) => o.verdict === 'refute');
  assert.ok(outcome !== undefined && outcome.grounds.length <= 1, 'one ground reference per outcome');
  assert.ok(!JSON.stringify(outcome).includes('args'), 'no definition body in the outcome');
});
