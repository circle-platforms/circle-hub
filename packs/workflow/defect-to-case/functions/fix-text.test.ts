import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectDefects } from './projection.ts';
test('a missing, non-text or blank configured fix field refuses before repair rounds and names the missing fact', () => {
  for (const value of [undefined, '', '  ', null, 3]) {
    const out = projectDefects({ context: { line: '10.7' }, inputs: [{ slot: 'defects', external: 'plm:bug:910001', sha256: 'b'.repeat(64), model: { id: '910001', title: '合成缺陷', fix_field: 'repair_notes', fields: { repair_notes: value, fix: '不能兜底' } } }] });
    assert.ok('error' in out, JSON.stringify(out));
    assert.equal(out.error.code, 'defect-to-case.fix_text_missing');
    assert.match(out.error.message, /910001.*repair_notes/); assert.match(out.error.fix, /settings\.bug_fix_field/);
  }
});
