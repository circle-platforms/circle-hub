// Edge cases of the traceability matrix written after a mutation check: the defect ids of a listed case are
// deduplicated and sorted, the rows come out in code-unit order of the bug id, an empty case title falls back to
// the statement, and a view whose entries record holds a non-digest key is refused.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMatrix } from './matrix.ts';
import { boundPair, caseEntry, defectEntry } from './test-support.ts';
import { readIndexView } from './views.ts';

function matrixOf(defects: Parameters<typeof boundPair>[0], cases: Parameters<typeof boundPair>[1], slimCases = true) {
  const pair = boundPair(defects, cases, { slimCases });
  const dv = readIndexView(pair.inputs[0], 'defects', { kind: 'defect', key: 'bug' });
  const cv = readIndexView(pair.inputs[1], 'cases', { kind: 'case', key: 'defects' });
  assert.ok(dv.ok && cv.ok);
  return { rows: buildMatrix(dv.view, cv.view, ['fixed', 'known']), pair };
}

describe('buildMatrix edge cases', () => {
  it('lists a case\'s defect ids deduplicated and in code-unit order', () => {
    // The view keys '7300' and '007300' normalise to one bucket, so the case is reached through both spellings.
    const kase = caseEntry({ defects: ['7400', '7300'], case: 'C-1' });
    const { rows } = matrixOf([defectEntry({ bug: '7300' })], [kase], false);
    assert.equal(rows.length, 1);
    // data.defects as written: ['7400', '7300']; deduplicated and sorted in code-unit order. The slim cases view does not
    // carry them (fields=document,node,title), so this pins the full view.
    assert.deepEqual(rows[0].cases[0].defects, ['7300', '7400']);
    const twin = caseEntry({ defects: ['7300', '7300'], case: 'C-2' });
    const again = matrixOf([defectEntry({ bug: '7300' })], [twin], false);
    assert.deepEqual(again.rows[0].cases[0].defects, ['7300'], 'a repeated id is listed once');
  });

  it('returns the rows in code-unit order of the bug id', () => {
    // Code-unit order differs from numeric order: '10' < '9'.
    const { rows } = matrixOf(
      [defectEntry({ bug: '9' }), defectEntry({ bug: '10' }), defectEntry({ bug: 'ALM-2' }), defectEntry({ bug: 'ALM-10' })],
      [],
    );
    assert.deepEqual(rows.map((r) => r.bug), ['10', '9', 'ALM-10', 'ALM-2']);
  });

  it('falls back to the statement when the case entry carries an empty title', () => {
    // Built so the statement differs from the empty data.title (the builder would make them equal).
    const kase = caseEntry({ defects: ['7500'], case: 'C-1', digest: 'c'.repeat(64) });
    kase.statement = '通过语句给出的标题';
    kase.data.title = '';
    const { rows } = matrixOf([defectEntry({ bug: '7500' })], [kase], false);
    assert.equal(rows[0].cases[0].title, '通过语句给出的标题');
  });
});

describe('readIndexView edge case', () => {
  it('refuses an entries record keyed by a non-digest', () => {
    const defect = defectEntry({ bug: '7600' });
    const pair = boundPair([defect], []);
    const model = pair.defects as {
      entries: Record<string, { entry: string; kind: string; statement: string; data: Record<string, unknown>; reference: string }>;
    };
    const alien = 'not-a-digest';
    model.entries[alien] = { entry: alien, kind: 'defect', statement: '混进来的键', data: { bug: '7601', status: 'fixed' }, reference: `tree:${'a'.repeat(64)}/release-notes/x@${'b'.repeat(64)}` };
    const read = readIndexView(pair.inputs[0], 'defects', { kind: 'defect', key: 'bug' });
    assert.ok(!read.ok, 'a view with a non-digest entry key is refused');
    if (!read.ok) {
      assert.equal(read.code, 'wrong_view');
      assert.match(read.message, /entries/);
    }
  });

  it('refuses an entry whose kind is not the view kind, even under a digest key', () => {
    const defect = defectEntry({ bug: '7601' });
    const pair = boundPair([defect], []);
    const model = pair.defects as {
      entries: Record<string, { entry: string; kind: string; statement: string; data: Record<string, unknown>; reference: string }>;
    };
    const digest = 'd'.repeat(64);
    model.entries[digest] = { entry: digest, kind: 'case', statement: '种类不符的条目', data: { case: 'C-1', defects: ['7601'] }, reference: `tree:${'a'.repeat(64)}/cases/x@${'b'.repeat(64)}` };
    const read = readIndexView(pair.inputs[0], 'defects', { kind: 'defect', key: 'bug' });
    assert.ok(!read.ok, 'an entry of another kind is refused');
    if (!read.ok) {
      assert.equal(read.code, 'wrong_view');
      assert.match(read.message, /种类/);
    }
  });
});
