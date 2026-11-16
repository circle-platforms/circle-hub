// The written report of a replay: the counts and reasons of its parts merged, the normalizations added up, the Chinese text.
// Synthetic outcomes only.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { compareResults } from './submissions-compare.ts';
import { renderDetails, summarize, type ReportMeta } from './submissions-report.ts';
import type { RunReport, ValidationOutcome } from './submissions-run.ts';

const meta: ReportMeta = { mode: 'faithful', created_at: '2026-01-01T00:00:00.000Z', export_dir: 'export', bundle_dir: 'bundle' };

const recorded = { schema: 'validation@1', run: 'run_x', acceptance: 'not_accepted', errors: [{ code: 'a.b', message: '旧', item: 'i', requirement: 'r' }], trace: '0'.repeat(32) };

function outcome(seq: number, status: ValidationOutcome['status'], extra: Partial<ValidationOutcome> = {}): ValidationOutcome {
  return { seq, run: 'run_x', pack: 'demo@1.0.0', at: '2026-01-01T00:00:00Z', ordinal: 1, file: `run_x/${seq}-validation_result.json`, release: 'abc', status, notes: [], misses: { records: [], objects: [] }, ms: 1, ...extra };
}

function part(commit: string, outcomes: ValidationOutcome[], skipped = 0): RunReport {
  return { mode: 'faithful', commit, outcomes, skipped, packs: [{ pack: 'demo@1.0.0', digest: 'd'.repeat(64), status: 'same' }], notes: [] };
}

describe('the report', () => {
  const same = compareResults(recorded, { ...recorded, trace: '1'.repeat(32) });
  const changed = compareResults(recorded, { ...recorded, errors: [{ code: 'a.b', message: '新', item: 'i', requirement: 'r' }] });
  const parts = [
    part('a'.repeat(40), [outcome(1, 'same', { comparison: same }), outcome(2, 'changed', { comparison: changed })], 3),
    part('b'.repeat(40), [outcome(3, 'not_replayable', { reason: { code: 'no_bundle', message: '没有数据包' } })], 1),
  ];
  const summary = summarize(parts, meta);

  test('the parts are merged: counts, reasons, normalizations added up, lines in order of position', () => {
    assert.deepEqual(summary.totals, { validations: 3, same: 1, changed: 1, not_replayable: 1, skipped: 4 });
    assert.deepEqual(summary.not_replayable_by_reason, { no_bundle: 1 });
    assert.deepEqual(summary.commits, ['a'.repeat(40), 'b'.repeat(40)]);
    assert.deepEqual(summary.normalizations.map((n) => [n.id, n.recorded, n.replayed]), [['trace', 2, 2], ['exit.due', 0, 0]]);
    assert.deepEqual(summary.lines.map((l) => [l.seq, l.status, l.fields]), [[1, 'same', []], [2, 'changed', ['errors']], [3, 'not_replayable', []]]);
  });

  test('the Chinese details name the counts, the normalizations, each non-replayable reason and each difference', () => {
    const text = renderDetails(summary, parts);
    assert.match(text, /共 3 条核对结果参与回放：相同 1，不同 1，不能回放 1/);
    assert.match(text, /## 做了哪些归一（只有这些；其余字段逐字比较）/);
    assert.match(text, /\| trace \|/);
    assert.match(text, /- no_bundle（1 条）：没有 Hub 数据包/);
    assert.match(text, /### 位置 2：run_x/);
    assert.match(text, /\/errors\/0\/message〔code=a\.b item=i requirement=r〕：记录 "旧" → 回放 "新"/);
    assert.match(text, /重算相同/);
  });

  test('a report in which nothing could be replayed says so instead of passing', () => {
    const none = summarize([part('c'.repeat(40), [outcome(1, 'not_replayable', { reason: { code: 'no_bundle', message: 'x' } })])], meta);
    assert.match(renderDetails(none, [part('c'.repeat(40), [])]), /没有一条被真正回放/);
  });
});
