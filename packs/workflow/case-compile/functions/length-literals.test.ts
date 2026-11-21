import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeExpansions, expandText, expandValue, MAX_LABEL } from './length-literals.ts';

const labelsOf = (literal: string) => literal.split('.').map((label) => label.length);

test('a domain of a stated length is exactly that long, with no label over 63 and none empty', () => {
  for (let n = 1; n <= 300; n++) {
    const { text } = expandText(`{{domain:${n}}}`);
    assert.equal(text.length, n, `length ${n}`);
    const labels = labelsOf(text);
    assert.ok(labels.every((size) => size >= 1 && size <= MAX_LABEL), `labels of ${n}: ${labels.join('/')}`);
  }
  assert.deepEqual(labelsOf(expandText('{{domain:253}}').text), [63, 63, 63, 61]);
  assert.deepEqual(labelsOf(expandText('{{domain:64}}').text), [62, 1]);
});

test('fixed parts are kept verbatim and the filler makes up the rest', () => {
  const { text } = expandText('{{domain:253|www._sip:5060|example.com}}');
  assert.equal(text.length, 253);
  assert.ok(text.startsWith('www._sip:5060.'));
  assert.ok(text.endsWith('.example.com'));
  assert.ok(labelsOf(text).every((size) => size >= 1 && size <= MAX_LABEL));
  const dotted = expandText('{{domain:100|www.|.com}}').text;
  assert.ok(dotted.startsWith('www.') && dotted.endsWith('.com') && !dotted.includes('..'));
  assert.equal(dotted.length, 100);
  const name = expandText('{{name:64|pool_}}').text;
  assert.equal(name.length, 64); assert.ok(name.startsWith('pool_')); assert.ok(!name.includes('.'));
});

test('the same placeholder gives the same literal everywhere in a case, and text around it is untouched', () => {
  const plan = { steps: [{ args: ['demo host name "{{domain:253}}" 60'] }, { args: ['probe {{domain:253}} A'] }], expects: [{ text: '{{domain:253}}', quote: { text: '253 字符域名' } }], n: 3, ok: true };
  const { value, expansions } = expandValue(plan) as { value: any; expansions: unknown[] };
  const literal = expandText('{{domain:253}}').text;
  assert.equal(value.steps[0].args[0], `demo host name "${literal}" 60`);
  assert.equal(value.steps[1].args[0], `probe ${literal} A`);
  assert.equal(value.expects[0].text, literal);
  assert.equal(value.expects[0].quote.text, '253 字符域名');
  assert.equal(value.n, 3); assert.equal(value.ok, true);
  assert.equal(expansions.length, 3);
  assert.deepEqual(describeExpansions('00.json', expansions as never), ['00.json：{{domain:253}} → 253 字符，4 段，各段 63/63/63/61']);
});

test('a placeholder that cannot be met, or is written in another form, is refused rather than sent', () => {
  assert.throws(() => expandText('{{domain:10|www.example|com}}'), /补不出 10 字符的域名/);
  assert.throws(() => expandText(`{{domain:200|${'x'.repeat(64)}}}`), /有一段超过 63/);
  assert.throws(() => expandText('{{domain:50|a..b}}'), /空的一段/);
  assert.throws(() => expandText('{{domain:50|a b}}'), /不含空白和引号/);
  assert.throws(() => expandText('{{domain:50|"a"}}'), /不含空白和引号/);
  assert.throws(() => expandText('{{ domain: 253 }}'), /长度占位写法不对/);
  assert.throws(() => expandText('{{domain:253:b}}'), /长度占位写法不对/);
  assert.throws(() => expandText('{{name:5000}}'), /超过 4096/);
  assert.equal(expandText('RESTORE_FROM {} and {0} stay').text, 'RESTORE_FROM {} and {0} stay');
});
