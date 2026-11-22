import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalOf, collapseJsonText, collapseText, describeExpansions, expandText, expandValue, MAX_LABEL, namesIn, tokensOf } from './length-literals.ts';
import { lengthAdvice } from './plan-advice.ts';

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

// The inverse of the expansion: the long names an expanded text holds come back as the placeholders they were made from.
const name = (placeholder: string) => expandText(placeholder).text;
const holds = (text: string, part: string) => text.split(part).length - 1;

test('a long name that stands alone comes back as its placeholder, and the same name inside a longer token as that placeholder with its extra characters', () => {
  const same = name('{{domain:200|pfx|sfx}}');
  const plan = JSON.stringify({ args: [`show host ${same}`, same, `seat ${same}`, `x1.${same}`] });
  const { text, collapsed } = collapseText(plan);
  assert.equal(text, JSON.stringify({ args: ['show host {{domain:200|pfx|sfx}}', '{{domain:200|pfx|sfx}}', 'seat {{domain:200|pfx|sfx}}', 'x1.{{domain:200|pfx|sfx}}'] }));
  assert.deepEqual(collapsed, [{ placeholder: '{{domain:200|pfx|sfx}}', literal: same, count: 4 }]);
  assert.equal(expandText(text).text, plan, 'and it expands back to the very bytes');
  assert.equal(collapseText(`x1.${same}`).text, '{{domain:203|x1.pfx|sfx}}', 'a name with a label before it that stands alone nowhere is a placeholder of its own');
  assert.equal(collapseText(`k=${same};`).text, '{{domain:203|k=pfx|sfx;}}', 'what stands around a name that stands alone nowhere belongs to the fixed parts');
});

test('a name of another length is another placeholder, so a length that was typed wrong shows beside the right one', () => {
  const right = name('{{domain:200|pfx|sfx}}'), wrong = name('{{domain:204|pfx|sfx}}');
  assert.equal(right.length, 200); assert.equal(wrong.length, 204);
  const { text, collapsed } = collapseText(JSON.stringify([right, right, wrong, `x1.${right}`]));
  assert.equal(text, JSON.stringify(['{{domain:200|pfx|sfx}}', '{{domain:200|pfx|sfx}}', '{{domain:204|pfx|sfx}}', 'x1.{{domain:200|pfx|sfx}}']));
  assert.deepEqual(collapsed.map((row) => [row.placeholder, row.count]), [['{{domain:200|pfx|sfx}}', 3], ['{{domain:204|pfx|sfx}}', 1]]);
  const names = collapseText(JSON.stringify([name('{{name:64|pool_}}'), name('{{name:70|pool_}}'), name('{{name:64|pool_}}')]));
  assert.equal(names.text, JSON.stringify(['{{name:64|pool_}}', '{{name:70|pool_}}', '{{name:64|pool_}}']), 'names that differ in length only are told apart, none of them is built of the other');
});

test('short names and texts without a run of 16 identical characters stay as they are', () => {
  const texts = ['', 'show widget name pool_1 on seat#', 'a.b.c.example.com 192.0.2.10', name('{{name:15}}'), name('{{domain:30|pfx|sfx}}').replace(/a{16,}/, 'abababab'), 'z'.repeat(40), '='.repeat(70), `ab${'a'.repeat(10)}cd`];
  for (const text of texts) assert.deepEqual(collapseText(text), { text, collapsed: [] }, text.slice(0, 40));
  assert.equal(collapseText(name('{{name:16}}')).text, '{{name:16}}', 'sixteen is where a filler starts to count');
  assert.equal(collapseText(name('{{name:20|ab|cd}}')).text, '{{name:20|ab|cd}}');
  assert.equal(collapseText(name('{{name:30|xa|cd}}')).text, '{{name:30|x|cd}}', 'the run of the filler includes an a that came before it; the name is the same');
});

test('the 64-character domain (62 and 1), the longest ones and the name placeholders come back as they were written', () => {
  for (const placeholder of ['{{domain:64}}', '{{domain:65}}', '{{domain:127}}', '{{domain:128}}', '{{domain:253}}', '{{domain:253|www._sip:5060|example.com}}', '{{domain:100|www|com}}', '{{domain:4096|k}}', '{{name:64}}', '{{name:64|pool_}}', '{{name:100|pool_|_end}}', '{{name:300||tail}}', '{{name:4096}}']) {
    const literal = name(placeholder), found = canonicalOf(literal);
    assert.equal(found?.placeholder, placeholder, placeholder);
    assert.equal(collapseText(`seat ${literal} 5`).text, `seat ${placeholder} 5`, placeholder);
  }
  assert.deepEqual(name('{{domain:64}}').split('.').map((label) => label.length), [62, 1]);
  const two = name('{{domain:200|pfx|sfx}}');
  assert.equal(canonicalOf(two.replace('pfx.', 'fx.'))?.placeholder, '{{domain:199|fx|sfx}}', 'another fixed part is still the same filler');
  assert.equal(canonicalOf(two.replace('pfx.a', 'pfx.')), null, 'a filler with a character cut off is not what the expansion makes');
  assert.equal(canonicalOf(two.replace('bbbbbbbb', 'bbbbbbbc')), null, 'and neither is one with a character changed');
});

test('a text that holds placeholders already keeps them, and a text the expansion refuses is returned as it was', () => {
  const same = name('{{domain:200|pfx|sfx}}');
  const mixed = `one {{domain:200|pfx|sfx}} two ${same} {{name:10}} three`;
  const { text, collapsed } = collapseText(mixed);
  assert.equal(text, 'one {{domain:200|pfx|sfx}} two {{domain:200|pfx|sfx}} {{name:10}} three');
  assert.deepEqual(collapsed.map((row) => row.count), [1], 'only what was put back is counted');
  assert.equal(expandText(text).text, expandText(mixed).text);
  for (const refused of [`${same} {{domain:5000}}`, `${same} {{ name:3 }}`, `${same} {{name:3|a b}}`]) assert.deepEqual(collapseText(refused), { text: refused, collapsed: [] });
  const inside = `{{domain:200|${'a'.repeat(20)}|sfx}} ${'a'.repeat(20)}`;
  assert.equal(collapseText(inside).text, `{{domain:200|${'a'.repeat(20)}|sfx}} {{name:20}}`, 'a placeholder is never looked into');
});

test('a name is only put back where it does not lengthen a run, and a token that holds two long names keeps what it cannot say', () => {
  const run = 'a'.repeat(20), longer = 'a'.repeat(21);
  assert.equal(collapseText(`${run} ${longer},${run} ${longer}`).text, '{{name:20}} {{name:21}},{{name:20}} {{name:21}}', 'two runs that are the same text but not the same name are told apart');
  const joined = name('{{domain:200|pfx|sfx}}'), other = name('{{domain:204|pfx|sfx}}');
  assert.equal(collapseText(`${joined} ${joined},${other}`).text, '{{domain:200|pfx|sfx}} {{domain:200|pfx|sfx}},{{domain:204|pfx|sfx}}', 'a name of the fixed parts of one found elsewhere is found in the token it is glued to, of another length');
  assert.equal(collapseText(`${longer},${run}`).text, `${longer},${run}`, 'two long runs in one token are no placeholder, and nothing else tells what they stand for');
  const glued = `${joined},${other}`;
  assert.deepEqual(collapseText(glued), { text: glued, collapsed: [] }, 'two long names in one token that stand alone nowhere are no placeholder with a long fixed part');
  assert.equal(collapseText(`${run} ${longer},${run}`).text, `{{name:20}} ${longer},{{name:20}}`, 'a name known from elsewhere is found in the token, but never inside a longer run');
  assert.equal(collapseText(`${run} x${run}`).text, '{{name:20}} x{{name:20}}', 'with its own extra characters around it');
  assert.deepEqual(tokensOf('show "name" a=b\\c').map((row) => row.token), ['show', 'name', 'a=b', 'c'], 'quotes, backslash and blanks end a token');
});

test('collapseJsonText hands back the text itself unless the collapsed one is JSON and expands back to exactly these bytes', () => {
  const same = name('{{domain:200|pfx|sfx}}');
  const plan = JSON.stringify({ args: [same, same] }, null, 1) + '\n';
  const collapsed = collapseJsonText(plan);
  assert.equal(collapsed, JSON.stringify({ args: ['{{domain:200|pfx|sfx}}', '{{domain:200|pfx|sfx}}'] }, null, 1) + '\n');
  assert.equal(expandText(collapsed).text, plan);
  const unproved = `${plan.trimEnd().slice(0, -1)},"{{name:10}}"]}\n`.replace('[', '["x",');
  assert.equal(collapseJsonText(unproved), unproved, 'a text that holds a placeholder of its own does not expand back to the same bytes');
  const notJson = `show host ${same}`;
  assert.equal(collapseJsonText(notJson), notJson, 'what is not JSON stays what it was');
  assert.equal(collapseJsonText('{"a":1}\n'), '{"a":1}\n');
  const asKey = JSON.stringify({ [same]: 1, args: [same, same] });
  assert.equal(collapseText(asKey).text.includes('{{domain:200|pfx|sfx}}":1'), true, 'the text alone would put the placeholder into a key');
  assert.equal(collapseJsonText(asKey), asKey, 'a key is never expanded when the plan is read, so what would change a key is not handed over');
});

// The shape of a real run: the name with the length that was meant stands alone and inside longer tokens, and a name of another
// length that has the same fixed parts stands only inside a longer token, so that nothing else says what its fixed parts are.
const NEXT_STEP = '本意是同一个名字就用同一个定长占位；本意不同就保留';
const placeholderFor = (kind: string, length: number, prefix: string, suffix: string) => `{{${kind}:${length}${suffix ? `|${prefix}|${suffix}` : prefix ? `|${prefix}` : ''}}}`;

test('a name of another length that stands only inside longer tokens is written with the fixed parts of the name found elsewhere', () => {
  const right = name('{{domain:200|pfx|sfx}}'), wrong = name('{{domain:204|pfx|sfx}}');
  const plan = JSON.stringify({ args: [right, `x1.${right}`, `x1.${wrong}`, right] });
  const { text, collapsed } = collapseText(plan);
  assert.equal(text, JSON.stringify({ args: ['{{domain:200|pfx|sfx}}', 'x1.{{domain:200|pfx|sfx}}', 'x1.{{domain:204|pfx|sfx}}', '{{domain:200|pfx|sfx}}'] }));
  assert.deepEqual(collapsed, [{ placeholder: '{{domain:200|pfx|sfx}}', literal: right, count: 3 }, { placeholder: '{{domain:204|pfx|sfx}}', literal: wrong, count: 1 }]);
  assert.equal(expandText(text).text, plan, 'and it expands back to the very bytes');
  assert.deepEqual(namesIn([`show ${right}`, `show x1.${right}`, `show x1.${wrong}`].join('\n')).map((row) => [row.name.length, row.name.prefix, row.name.suffix]), [[200, 'pfx', 'sfx'], [200, 'pfx', 'sfx'], [204, 'pfx', 'sfx']], 'the fixed parts are those of the name that stands alone');

  assert.deepEqual(collapseText(JSON.stringify([`x1.${right}`, `x1.${wrong}`])).collapsed.map((row) => row.placeholder), ['{{domain:203|x1.pfx|sfx}}', '{{domain:207|x1.pfx|sfx}}'], 'with nothing that stands alone, tokens with the same extra characters have the same fixed parts');
  assert.equal(collapseText(`x1.${wrong}`).text, '{{domain:207|x1.pfx|sfx}}', 'and a single one has fixed parts of its own');

  const around = collapseText(JSON.stringify([right, `http://${wrong}/path`, `k=${wrong};`, `${wrong}.org`, `@${right},${wrong}`])).text;
  assert.equal(around, JSON.stringify(['{{domain:200|pfx|sfx}}', 'http://{{domain:204|pfx|sfx}}/path', 'k={{domain:204|pfx|sfx}};', '{{domain:204|pfx|sfx}}.org', '@{{domain:200|pfx|sfx}},{{domain:204|pfx|sfx}}']), 'whatever stands around it, but not a word it is glued to');
  assert.equal(collapseText(JSON.stringify([right, `z${wrong}`])).text, JSON.stringify(['{{domain:200|pfx|sfx}}', '{{domain:205|zpfx|sfx}}']), 'a name glued to a word before it is another name');
  assert.equal(collapseText(JSON.stringify([right, `${wrong}z`])).text, JSON.stringify(['{{domain:200|pfx|sfx}}', '{{domain:205|pfx|sfxz}}']), 'and so is one glued to a word after it');

  const pool = (length: number) => name(`{{name:${length}|pool_}}`);
  assert.equal(collapseText(JSON.stringify([pool(64), `k=${pool(70)}`, `xpool_${'a'.repeat(70)}`])).text, JSON.stringify(['{{name:64|pool_}}', 'k={{name:70|pool_}}', '{{name:76|xpool_}}']), 'names of plain fixed parts the same way');
  assert.equal(collapseText(JSON.stringify([name('{{name:64}}'), `k=${'a'.repeat(70)}`])).text, JSON.stringify(['{{name:64}}', '{{name:72|k=}}']), 'a name without fixed parts says nothing about the fixed parts of another');
  assert.equal(collapseText(JSON.stringify([right, `${wrong},${wrong}`])).text, JSON.stringify(['{{domain:200|pfx|sfx}}', '{{domain:204|pfx|sfx}},{{domain:204|pfx|sfx}}']), 'every name of a token that holds several');
});

// A small generator that always gives the same texts: names of both kinds in the lengths that matter, mistyped ones, names glued
// to other characters, quotes, escapes, JSON around it all, placeholders the text holds already and ones the expansion refuses,
// and the shape of a real run.
function generator(seed: number) {
  let state = seed >>> 0;
  const next = () => { state = (state + 0x6d2b79f5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const lengths = [16, 17, 20, 24, 33, 40, 63, 64, 65, 100, 126, 127, 128, 129, 190, 192, 200, 203, 204, 253, 255, 300, 500, 1000, 4096];
  const domainPrefix = ['', 'pfx', 'www', 'x1.pfx', '_sip:5060', 'a.b'], domainSuffix = ['', 'sfx', 'example.com', 'z9'];
  const namePrefix = ['', 'pool_', 'k=', 'xa', 'a_', 'id:'], nameSuffix = ['', '_end', 'a', ',z', ')'];
  const separators = [' ', ' ', '"', ',', '=', ':', ';', '/', '(', ')', '\n', '\t', '@', '\\"', ' -x ', '{', '}', '|', '{{', '}}'];
  const words = ['show', 'config', 'host', 'ip', 'address', 'a', 'b.c', 'name', '12', '--force', 'k=v'];
  const literal = (): string => {
    for (;;) {
      const domain = next() < 0.5, bare = pick([0, 1, 2]) === 0;
      const placeholder = domain ? `{{domain:${pick(lengths)}${bare ? '' : `|${pick(domainPrefix)}|${pick(domainSuffix)}`}}}` : `{{name:${pick(lengths)}${bare ? '' : `|${pick(namePrefix)}|${pick(nameSuffix)}`}}}`;
      try { return expandText(placeholder).text; } catch { /* a length the fixed parts do not leave room for */ }
    }
  };
  // A name alone, the same name behind characters that are no word, and a name of another length behind such characters only.
  const shape = () => {
    for (;;) {
      const domain = next() < 0.6, kind = domain ? 'domain' : 'name';
      const prefix = pick(domain ? domainPrefix : namePrefix), suffix = pick(domain ? domainSuffix : nameSuffix), first = pick(lengths), second = pick(lengths);
      if (first === second || (prefix === '' && suffix === '')) continue;
      const make = (length: number): string | null => { try { return expandText(placeholderFor(kind, length, prefix, suffix)).text; } catch { return null; } };
      const base = make(first), other = make(second);
      if (base === null || other === null) continue;
      if ([base, other].some((one) => { const found = canonicalOf(one); return found === null || found.prefix !== prefix || found.suffix !== suffix; })) continue;
      const before = (): string => pick(domain ? ['x1.', 'k=', '@', ',', 'z.'] : ['k=', '@', ',', '(', '/']);
      return { kind, prefix, suffix, first, second, base, other, before: [before(), before()] as const };
    }
  };
  const piece = (): string => {
    const roll = next();
    if (roll < 0.34) return literal();
    if (roll < 0.40) { const long = literal(), at = Math.floor(next() * long.length); return long.slice(0, at) + (long[at] === 'q' ? 'r' : 'q') + long.slice(at + 1); }
    if (roll < 0.46) return pick(['z', '-', '=', 'b', 'a']).repeat(pick([10, 15, 16, 17, 20, 40, 70]));
    if (roll < 0.52) return pick(['{{domain:200|pfx|sfx}}', '{{name:64}}', '{{domain:64}}', '{{name:20|k=}}']);
    if (roll < 0.58) return pick(['x1.', 'k=', '@', ',', 'zz', 'a']) + literal();
    if (roll < 0.62) return literal() + pick(['.org', ',', ':80', 'a', 'z', '/x']);
    if (roll < 0.66) return `${literal()},${literal()}`;
    if (roll < 0.70) return pick(['{{domain:5000}}', '{{ name:3 }}', '{{domain:x}}', '{{name:3|a b}}', '{{name:5000}}']);
    if (roll < 0.78) { const one = shape(); return [one.base, one.before[0] + one.base, one.before[1] + one.other].join(pick(separators)); }
    return pick(words);
  };
  const text = (): string => {
    const parts = Array.from({ length: 1 + Math.floor(next() * 8) }, piece);
    const joined = parts.map((part, at) => (at ? pick(separators) + part : part)).join('');
    return next() < 0.35 ? JSON.stringify({ args: parts, text: joined }, null, pick([0, 1, 2])) : joined;
  };
  return { text, shape };
}

test('for any text, what collapseText returns expands back to what the text expands to, byte for byte', () => {
  const { text: texts } = generator(20261122);
  let changed = 0, plain = 0, refused = 0;
  for (let round = 0; round < 6000; round++) {
    const text = texts();
    let expected: string;
    try { expected = expandText(text).text; } catch { assert.deepEqual(collapseText(text), { text, collapsed: [] }, 'a text the expansion refuses is returned as it was'); refused++; continue; }
    const result = collapseText(text);
    assert.equal(expandText(result.text).text, expected, text.slice(0, 120));
    if (expected === text) { plain++; assert.equal(expandText(result.text).text, text, 'a text without placeholders comes back byte for byte'); }
    if (!/(.)\1{15}/.test(text)) assert.deepEqual(result, { text, collapsed: [] }, 'nothing that holds no run of 16 identical characters changes');
    if (result.collapsed.length) changed++; else assert.equal(result.text, text);
    for (const row of result.collapsed) {
      assert.equal(expandText(row.placeholder).text, row.literal, 'every row is a placeholder and what it expands to');
      assert.equal(holds(result.text, row.placeholder), holds(text, row.placeholder) + row.count, 'and counts what was put back');
    }
    for (const { at, name: found } of namesIn(text)) assert.equal(text.startsWith(found.literal, at), true, 'a name is where it is said to be');
    assert.equal(collapseText(result.text).text, result.text, 'collapsing twice changes nothing more');
  }
  assert.ok(changed > 2000 && plain > 1000 && refused > 500, `the generator reaches what it is meant to: ${changed} changed, ${plain} plain, ${refused} refused`);
});

test('for the shape of a real run, generated, the name of another length is written with the fixed parts of the name found elsewhere and the advice names both lengths', () => {
  const { shape } = generator(1122);
  for (let round = 0; round < 400; round++) {
    const { kind, prefix, suffix, first, second, base, other, before } = shape();
    const [one, two] = [placeholderFor(kind, first, prefix, suffix), placeholderFor(kind, second, prefix, suffix)];
    const text = [base, before[0] + base, before[1] + other].join(' ');
    const done = collapseText(text);
    assert.equal(done.text, [one, before[0] + one, before[1] + two].join(' '), text.slice(0, 120));
    assert.deepEqual(done.collapsed.map((row) => [row.placeholder, row.count]), [[one, 2], [two, 1]]);
    assert.equal(expandText(done.text).text, text);
    const places = [['/p/0', '/p/1'], ['/p/2']], rows = first < second ? [[first, one, places[0]], [second, two, places[1]]] : [[second, two, places[1]], [first, one, places[0]]];
    assert.deepEqual(lengthAdvice([{ pointer: '/p/0', text: `show ${base}` }, { pointer: '/p/1', text: `show ${before[0]}${base}` }, { pointer: '/p/2', text: `show ${before[1]}${other}` }]),
      [`固定部分相同的定长名字有 2 种长度：${rows.map(([length, placeholder, where]) => `${length} 字符（${placeholder}）用在 ${(where as string[]).join('、')}`).join('；')}；${NEXT_STEP}`]);
  }
});
