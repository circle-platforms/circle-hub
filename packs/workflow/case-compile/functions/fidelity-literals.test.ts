import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shortenRepeatedLiterals } from './fidelity-render.ts';

const NAME = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
const OTHER = 'x'.repeat(120);
function restore(segments: readonly string[], legend: string): string[] {
  const table = [...legend.matchAll(/^(«L\d+») = (\S+)（/gmu)].map((m) => [m[1]!, m[2]!] as const);
  return segments.map((segment) => table.reduce((text, [name, literal]) => text.replaceAll(name, literal), segment));
}

test('one name replaces a long literal that repeats verbatim, quoted or not, in any segment', () => {
  const segments = [
    `1. 配置域名 ${NAME} 并查询`,
    `[当前作者步骤 a1]\n查询 ${NAME}`,
    `block[1] (CONFIG, host=dut1)\n  demo host name "${NAME}" 60\nblock[2] (OBSERVE_ASSERT, host=srv)\n  probe @192.0.2.1 ${NAME} A\n  assert: SIGNED`,
  ];
  const out = shortenRepeatedLiterals(segments);
  assert.equal(out.substitutions.length, 1);
  assert.deepEqual(
    { name: out.substitutions[0]!.name, length: out.substitutions[0]!.length, labels: out.substitutions[0]!.labels, occurrences: out.substitutions[0]!.occurrences },
    { name: '«L1»', length: 253, labels: [63, 63, 63, 61], occurrences: 4 },
  );
  assert.deepEqual(out.segments, [
    '1. 配置域名 «L1» 并查询',
    '[当前作者步骤 a1]\n查询 «L1»',
    'block[1] (CONFIG, host=dut1)\n  demo host name "«L1»" 60\nblock[2] (OBSERVE_ASSERT, host=srv)\n  probe @192.0.2.1 «L1» A\n  assert: SIGNED',
  ]);
  assert.equal(out.legend, `[长字面量对照]\n下面每个名字，在上文和命令块里都代表一个逐字相同的长字面量，原文只在这里写一次：\n«L1» = ${NAME}（共 253 个字符；各段 63、63、63、61）`);
  assert.deepEqual(restore(out.segments, out.legend), segments, 'putting the literals back gives the original text, byte for byte');
});

test('a literal that appears once, a short one, and one that differs by a character are left as they are', () => {
  const once = shortenRepeatedLiterals([`cmd ${NAME}`, 'cmd short-value short-value short-value short-value']);
  assert.deepEqual(once.substitutions, []);
  assert.equal(once.legend, '');
  assert.deepEqual(once.segments, [`cmd ${NAME}`, 'cmd short-value short-value short-value short-value']);

  const near = `${NAME.slice(0, -1)}e`;
  const out = shortenRepeatedLiterals([`a ${NAME}`, `b ${NAME}`, `c ${near}`]);
  assert.equal(out.substitutions.length, 1, 'only the literal that repeats is named');
  assert.deepEqual(out.segments, ['a «L1»', 'b «L1»', `c ${near}`], 'the one that differs stays visible, so the difference is not hidden');
});

test('two literals get two names in the order they first appear, and a name already in the text is skipped', () => {
  const out = shortenRepeatedLiterals([`first ${OTHER} then ${NAME}`, `again ${NAME} and ${OTHER} and «L1» is literal text`]);
  assert.deepEqual(out.substitutions.map((s) => [s.name, s.length, s.occurrences]), [['«L2»', 120, 2], ['«L3»', 253, 2]]);
  assert.deepEqual(out.segments, ['first «L2» then «L3»', 'again «L3» and «L2» and «L1» is literal text']);
  assert.deepEqual(out.substitutions.map((s) => s.labels), [undefined, [63, 63, 63, 61]]);
  assert.deepEqual(restore(out.segments, out.legend), [`first ${OTHER} then ${NAME}`, `again ${NAME} and ${OTHER} and «L1» is literal text`]);
});

test('a replacement that would not make the text shorter is not made', () => {
  const small = 'q'.repeat(32);
  const out = shortenRepeatedLiterals([`a ${small}`, `b ${small}`]);
  assert.deepEqual(out.substitutions, []);
  assert.deepEqual(out.segments, [`a ${small}`, `b ${small}`]);
});

test('the result depends only on the input', () => {
  const segments = [`x ${NAME} y`, `z ${NAME}`, `w ${OTHER} ${OTHER}`];
  assert.deepEqual(shortenRepeatedLiterals(segments), shortenRepeatedLiterals([...segments]));
  assert.deepEqual(shortenRepeatedLiterals([]), { segments: [], legend: '', substitutions: [] });
});
