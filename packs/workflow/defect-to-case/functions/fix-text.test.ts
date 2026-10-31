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
test('no fix text is an open cause: the refusal cites the record, names the missing fact and lists the causes with 其他 left to the reader', () => {
  const read = (status: string) => projectDefects({ context: { line: '10.7' }, inputs: [{ slot: 'defects', external: 'plm:bug:910002', sha256: 'c'.repeat(64), model: { id: '910002', title: '合成缺陷', fields: { status } } }] });
  const active = read('active');
  assert.ok('error' in active, JSON.stringify(active));
  assert.equal(active.error.code, 'defect-to-case.missing_fix_field');
  assert.deepEqual(active.error.grounds, [`src:${'c'.repeat(64)}`]);
  assert.equal(active.error.missing, '可以引用的修复说明');
  const [notFixed, elsewhere] = active.error.hypotheses ?? [];
  assert.equal(notFixed?.status, 'open');
  assert.match(notFixed?.support?.[0] ?? '', /原始结构状态是 “active”，没有声明 fixed/);
  assert.equal(elsewhere?.status, 'open');
  assert.match(elsewhere?.support?.[0] ?? '', /没有配置 settings\.bug_fix_field/);
  assert.match(active.error.fix, /缺陷修复后再开运行（你的运行能做）/);
  assert.match(active.error.fix, /请集成者配置/);
  // The fixed-status rule predicts no structured fixed for a defect not yet fixed: an observed fixed excludes that cause.
  const fixed = read('fixed');
  assert.ok('error' in fixed, JSON.stringify(fixed));
  assert.equal(fixed.error.hypotheses?.[0]?.status, 'excluded');
  assert.match(fixed.error.hypotheses?.[0]?.refute?.[0] ?? '', /声明 fixed/);
  assert.equal(fixed.error.hypotheses?.[1]?.status, 'open');
});
