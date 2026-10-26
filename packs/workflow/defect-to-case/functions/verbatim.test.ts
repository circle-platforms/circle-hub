import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkGroundedReading } from './checks.ts';
import { makeGoodDraft } from '../testing/fixtures.ts';

function check(text: string, quote = '合成说明：保存设置成功，保留原值。') {
  const draft = makeGoodDraft();
  const source=createHash('sha256').update(quote).digest('hex');
  draft.expected = [{text,after:1,identity:{source_sha256:source,parser:'text@1',path:'l/1',span:{unit:'byte',offset:0,length:Buffer.byteLength(quote)}},quote:{reference:`src:${source}/text@1/l/1`,text:quote}}];
  return checkGroundedReading({sources:{['src:'+source]:quote}, subject: { item: 'synthetic-defect', slots: { cases: [{ data: draft }] } } });
}
test('a paraphrase with no new entity is blocking and gives a correction and pointer', () => {
  const out = check('设置保存成功');
  assert.equal(out[0].verdict, 'refute');
  assert.equal(out[0].code, 'defect-to-case.expect_not_in_quote');
  assert.equal(out[0].tier, 'blocking');
  assert.equal(out[0].pointer, '/slots/cases/0/data/expected/0/text');
  assert.match(out[0].statement, /修正/);
});
test('verbatim fragments preserve whitespace, never case or punctuation changes or empty text', () => {
  assert.equal(check('保存设置成功')[0].verdict, 'support');
  assert.equal(check('  save\n  OK ', ' save\t OK ')[0].verdict, 'refute');
  for (const [expected, quote] of [['save ok', 'save OK'], ['保存设置成功。', '保存设置成功，'], ['   ', '原文'], ['其他成功', '保存成功']]) assert.equal(check(expected, quote)[0].verdict, 'refute');
});
test('grounded declarations make verbatim checks blocking and repairable', () => {
  const read = (file: string) => JSON.parse(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
  const check = read('checks.json').checks.find((c: { id: string }) => c.id === 'grounded_reading');
  assert.equal(check.tier, 'blocking');
  const rule = read('requirements.json').requirements.find((r: { key: string }) => r.key === 'grounded');
  assert.ok(rule.error_handling.some((e: { code: string; action: string; max_rounds: number }) => e.code === 'defect-to-case.expect_not_in_quote' && e.action === 'repair' && e.max_rounds === 2));
});
