// Naming the long literal arguments of commands for a model that cannot count them: what is replaced, what is left alone, and
// that nothing but the literals changes. Synthetic text only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { disclose, nameLongLiterals } from './command-literals.ts';
import { literalLengths } from './fidelity.ts';

const HOST = [`${'h'.repeat(63)}`, `${'j'.repeat(63)}`, `${'k'.repeat(63)}`, `${'m'.repeat(8)}`].join('.');
const sha12 = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 12);

test('a literal of 32 characters or more becomes a name that carries the count, and only the literal changes', () => {
  const texts = [`widget host set "${HOST}" 192.0.2.35`, `show widget key ${HOST}`, 'widget on'];
  const out = nameLongLiterals(texts);
  assert.deepEqual(out.texts, [
    'widget host set "«L1（200个字符；各段63、63、63、8）»" 192.0.2.35',
    'show widget key «L1（200个字符；各段63、63、63、8）»',
    'widget on',
  ]);
  assert.deepEqual(out.literals, [{ name: '«L1»', length: 200, labels: [63, 63, 63, 8], sha256_12: sha12(HOST) }]);
});

test('31 characters stay, 32 are named; quotes are not part of the literal; white space around it is kept as it was', () => {
  const edge31 = 'q'.repeat(31);
  const edge32 = 'r'.repeat(32);
  assert.deepEqual(nameLongLiterals([`cmd ${edge31}`]).texts, [`cmd ${edge31}`]);
  assert.deepEqual(nameLongLiterals([`cmd  '${edge32}' \t tail`]).texts, ["cmd  '«L1（32个字符）»' \t tail"]);
  assert.deepEqual(nameLongLiterals([`cmd "${edge32}"`, `cmd ${edge32}`]).texts, ['cmd "«L1（32个字符）»"', 'cmd «L1（32个字符）»'], 'quoted or not, it is the same literal');
  assert.deepEqual(nameLongLiterals([`  ${edge32}  `]).texts, ['  «L1（32个字符）»  ']);
});

test('the same literal has one name wherever it stands, the names follow first appearance, and a literal that differs by a character has its own', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const near = `${a.slice(0, -1)}c`;
  const out = nameLongLiterals([`x ${b}`, `y ${a} ${b}`, `z ${near} ${a}`]);
  assert.deepEqual(out.texts, ['x «L1（40个字符）»', 'y «L2（40个字符）» «L1（40个字符）»', 'z «L3（40个字符）» «L2（40个字符）»']);
  assert.deepEqual(out.literals.map((l) => [l.name, l.sha256_12]), [['«L1»', sha12(b)], ['«L2»', sha12(a)], ['«L3»', sha12(near)]]);
});

test('bytes are stated only when they differ from the characters, and the segments of a dotted literal are listed', () => {
  const wide = '键'.repeat(40);
  const dotted = `${'x'.repeat(20)}.${'y'.repeat(20)}.`;
  const many = Array.from({ length: 12 }, (_, i) => 'p'.repeat(i + 3)).join('.');
  const out = nameLongLiterals([`a ${wide}`, `b ${dotted}`, `c ${many}`]);
  assert.deepEqual(out.texts, [
    'a «L1（40个字符，120字节）»',
    'b «L2（42个字符；各段20、20、0）»',
    `c «L3（${many.length}个字符；12段，最长14）»`,
  ]);
  assert.deepEqual(out.literals.map((l) => [l.length, l.bytes, l.labels]), [[40, 120, undefined], [42, undefined, [20, 20, 0]], [many.length, undefined, undefined]].map(([length, bytes, labels], i) => [length, bytes, i === 2 ? [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] : labels]));
});

test('the figures are those of literalLengths, which the fidelity brief states for the same literals', () => {
  const text = `cfg "${HOST}" ${'z'.repeat(33)} ${'键'.repeat(33)}`;
  const facts = literalLengths([text]);
  const named = nameLongLiterals([text]).literals;
  assert.equal(named.length, facts.length);
  for (const f of facts) {
    const mine = named.find((n) => n.sha256_12 === sha12(f.literal))!;
    assert.equal(mine.length, f.length);
    assert.deepEqual(mine.labels, f.labels);
  }
});

test('a name already written in the text is not reused, and nothing is named twice', () => {
  const lit = 'n'.repeat(35);
  const out = nameLongLiterals([`first «L1（5个字符）» ${lit}`, `again ${lit}`]);
  assert.deepEqual(out.texts, ['first «L1（5个字符）» «L2（35个字符）»', 'again «L2（35个字符）»']);
  assert.deepEqual(out.literals.map((l) => l.name), ['«L2»']);
  assert.deepEqual(nameLongLiterals(out.texts).texts, out.texts, 'a second pass finds nothing left to name');

  // A name whose figures make it 32 characters or longer is still a name, not a literal to name again.
  const many = Array.from({ length: 8 }, () => 'w'.repeat(40)).join('.');
  const long = nameLongLiterals([`x ${many}`]);
  assert.ok([...long.texts[0]!.split(' ')[1]!].length >= 32, 'the written name is itself long');
  assert.deepEqual(nameLongLiterals(long.texts).texts, long.texts);
});

test('the text between the literals is the same before and after, byte for byte, and the literals are what the names stand for', () => {
  const lits = [HOST, 'u'.repeat(50), '键'.repeat(33)];
  const original = [`a ${lits[0]} b  "${lits[1]}"\tc`, `${lits[2]} d ${lits[0]}`, 'e'];
  const out = nameLongLiterals(original);
  const hole = /«L\d+（[^»]*）»/gu;
  const keep = /[^\s"']{32,}/gu; // the three literals are quote-free and white-space-free by construction
  assert.deepEqual(out.texts.map((t) => t.split(hole)), original.map((t) => t.split(keep)));
  assert.deepEqual(out.texts.map((t) => (t.match(hole) ?? []).length), original.map((t) => (t.match(keep) ?? []).length));
});

test('the result depends only on the input and the input is not changed', () => {
  const texts = Object.freeze([`x ${HOST} y`, `z ${HOST}`]);
  assert.deepEqual(nameLongLiterals(texts), nameLongLiterals([...texts]));
  assert.deepEqual(nameLongLiterals([]), { texts: [], literals: [] });
  assert.deepEqual(nameLongLiterals(['', '   ']), { texts: ['', '   '], literals: [] });
});

test('disclose lists the literals that stand in the text actually sent, with how many times', () => {
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  const out = nameLongLiterals([`1 ${a}`, `2 ${b}`, `3 ${a}`]);
  const sent = `${out.texts[1]}\n${out.texts[2]}\n${out.texts[2]}`;
  assert.deepEqual(disclose(out.literals, sent).map((l) => [l.name, l.occurrences]), [['«L1»', 2], ['«L2»', 1]]);
  assert.deepEqual(disclose(out.literals, out.texts[0]!).map((l) => [l.name, l.occurrences]), [['«L1»', 1]], 'a literal that is not in the text is not listed');
  assert.deepEqual(disclose(out.literals, 'nothing named here'), []);
});
