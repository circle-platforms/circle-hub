// Reading a bound input as an index-view@1 of the expected kind and key: the model is authoritative (the external id is
// not re-parsed), every entry listed under a key must carry its content in the view, and a view that is not the expected
// one is a refusal the caller can fix.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { boundView, caseEntry, defectEntry, indexViewOf } from './test-support.ts';
import { readIndexView } from './views.ts';

const defectsBound = (entries: Parameters<typeof indexViewOf>[2], overrides?: Parameters<typeof indexViewOf>[3]) => boundView('defects', indexViewOf('defect', 'bug', entries, overrides));

describe('readIndexView', () => {
  it('reads a well-formed view: keys, entries, totals, skipped, source reference', () => {
    const defect = defectEntry({ bug: '7001' });
    const bound = defectsBound([defect], { skipped: 2, notes: ['有来源没读'] });
    const read = readIndexView(bound, 'defects', { kind: 'defect', key: 'bug' });
    assert.ok(read.ok);
    assert.equal(read.view.product, 'famx');
    assert.deepEqual(read.view.keys, { '7001': [defect.digest] });
    assert.equal(read.view.entries[defect.digest].statement, defect.statement);
    assert.deepEqual([read.view.total_keys, read.view.total_entries, read.view.skipped, read.view.truncated], [1, 1, 2, false]);
    assert.deepEqual(read.view.notes, ['有来源没读']);
    assert.equal(read.view.source, `src:${bound.sha256}`);
    assert.equal(read.view.missing, 0);
    assert.deepEqual(read.warnings, []);
  });

  it('refuses a view of another schema, kind or key as the wrong view for the slot', () => {
    const defect = defectEntry({ bug: '7001' });
    for (const tamper of [
      (v: Record<string, unknown>) => ({ ...v, schema: 'facet-view@1' }),
      (v: Record<string, unknown>) => ({ ...v, kind: 'case' }),
      (v: Record<string, unknown>) => ({ ...v, key: 'defects' }),
    ]) {
      const read = readIndexView(boundView('defects', tamper(indexViewOf('defect', 'bug', [defect]))), 'defects', { kind: 'defect', key: 'bug' });
      assert.ok(!read.ok, 'refused');
      assert.equal(read.ok, false);
      if (!read.ok) assert.equal(read.code, 'wrong_view');
    }
  });

  it('refuses a malformed view: entries not records, a key listing a non-digest, an entry under another digest', () => {
    const defect = defectEntry({ bug: '7001' });
    const base = indexViewOf('defect', 'bug', [defect]);
    const wrong = [
      { ...base, entries: { [defect.digest]: 'not an entry' } },
      { ...base, keys: { '7001': 'not a list' } },
      { ...base, entries: { [defect.digest]: { ...((base.entries as Record<string, Record<string, unknown>>)[defect.digest]), entry: 'f'.repeat(64) } } },
      { ...base, build: { build: 7, root: 'a'.repeat(64) } },
    ];
    for (const view of wrong) {
      const read = readIndexView(boundView('defects', view), 'defects', { kind: 'defect', key: 'bug' });
      assert.ok(!read.ok);
      if (!read.ok) assert.equal(read.code, 'wrong_view');
    }
  });

  it('a digest listed under a key without entry content is counted and warned about, not read as absent', () => {
    const defect = defectEntry({ bug: '7001' });
    const view = indexViewOf('defect', 'bug', [defect]);
    const missing = 'e'.repeat(64);
    (view.keys as Record<string, string[]>)['7001'].push(missing);
    const read = readIndexView(boundView('defects', view), 'defects', { kind: 'defect', key: 'bug' });
    assert.ok(read.ok);
    assert.equal(read.view.missing, 1);
    assert.equal(read.warnings.length, 1);
    assert.equal(read.warnings[0].code, 'traceability.entry_missing');
    // The entry with content is still there.
    assert.ok(read.view.keys['7001'].includes(defect.digest));
  });

  it('a case view reads with its own kind and key', () => {
    const kase = caseEntry({ defects: ['7001', '7002'], case: 'C-1' });
    const read = readIndexView(boundView('cases', indexViewOf('case', 'defects', [kase])), 'cases', { kind: 'case', key: 'defects' });
    assert.ok(read.ok);
    assert.deepEqual(read.view.keys, { '7001': [kase.digest], '7002': [kase.digest] });
  });
});
