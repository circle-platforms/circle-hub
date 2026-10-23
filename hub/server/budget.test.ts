// The text budget: fits whole lines by priority, never cuts a line, never exceeds the budget, ends with the tail, and says in
// one note what was left out or shortened and how to read it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TEXT_BUDGET, fit, oneLine, softCap, type Block, type Entry } from './budget.ts';

const NOTE = /^部分：/;

/** A small seeded generator, so that a failing property run can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const linesOfEntry = (entry: Entry): readonly string[] => (typeof entry === 'string' ? [entry] : Array.isArray(entry) ? (entry as readonly string[]) : (entry as { lines: readonly string[] }).lines);

test('the budget is 30,000 characters, below what the real client was measured to deliver (about 49,000)', () => {
  assert.equal(TEXT_BUDGET, 30_000);
});

test('everything that fits is shown in display order without a note, the tail last', () => {
  const blocks: Block[] = [
    { priority: 2, head: ['第二块：'], entries: ['- a', ['- b', '  b 的细节']] },
    { priority: 0, head: ['第一行'] },
    { priority: 1, entries: ['尾行'] },
  ];
  const fitted = fit(blocks, { tail: ['追踪 t'] });
  assert.equal(fitted.cut, false);
  assert.equal(fitted.text, ['第二块：', '- a', '- b', '  b 的细节', '第一行', '尾行', '追踪 t'].join('\n'));
  assert.deepEqual(fitted.shown, [2, 1, 1]);
});

test('over the budget: lower priorities keep their entries, the rest goes whole, and one note before the tail names it', () => {
  const items = Array.from({ length: 100 }, (_, i) => `- 条目 ${i} ${'x'.repeat(40)}`);
  const blocks: Block[] = [
    { priority: 0, head: ['运行 甲'] },
    { priority: 3, head: ['条目：'], entries: items, unit: '条目', measure: '个', more: (from) => `条目：从第 ${from + 1} 个起，用 get_nodes 读` },
    { priority: 1, head: ['示例：'], entries: ['{"run":"甲"}'] },
  ];
  const fitted = fit(blocks, { budget: 1200, tail: ['追踪 t'] });
  const lines = fitted.text.split('\n');
  assert.ok(fitted.text.length <= 1200);
  assert.equal(fitted.cut, true);
  assert.equal(lines.filter((l) => NOTE.test(l)).length, 1, 'one note');
  assert.equal(lines.at(-1), '追踪 t', 'the tail ends the text');
  assert.match(lines.at(-2)!, NOTE, 'the note comes just before it');
  assert.equal(lines[0], '运行 甲');
  assert.ok(lines.includes('示例：') && lines.includes('{"run":"甲"}'), 'a higher priority block is kept whole');
  const shown = fitted.shown[1];
  assert.ok(shown > 0 && shown < 100);
  assert.deepEqual(lines.filter((l) => l.startsWith('- 条目')), items.slice(0, shown), 'a prefix of the entries, whole lines');
  assert.ok(lines.at(-2)!.includes(`条目 ${100 - shown} 个（第 ${shown + 1} 到第 100 个）`), 'the note counts what was left out');
  assert.ok(lines.at(-2)!.includes(`条目：从第 ${shown + 1} 个起，用 get_nodes 读`), 'and says how to read it from the first entry left out');
});

test('an entry of several lines is shown whole or not at all, and a head only with its first entry', () => {
  const blocks: Block[] = [
    { priority: 0, head: ['头'] },
    { priority: 1, head: ['分组：'], entries: [['- 甲', '  甲 1', '  甲 2'], ['- 乙', `  ${'y'.repeat(300)}`]], unit: '条目', measure: '个' },
  ];
  const fitted = fit(blocks, { budget: 200 });
  assert.equal(fitted.text.split('\n').slice(0, 5).join('\n'), ['头', '分组：', '- 甲', '  甲 1', '  甲 2'].join('\n'));
  assert.ok(!fitted.text.includes('- 乙'));
  const none = fit([{ priority: 0, head: ['头'] }, { priority: 1, head: ['分组：'], entries: [['- 丙', 'z'.repeat(500)]], unit: '条目', measure: '个' }], { budget: 200 });
  assert.ok(!none.text.includes('分组：'), 'no head without an entry');
  assert.match(none.text.split('\n').at(-1)!, /条目 1 个（第 1 个）/);
});

test('a line longer than the budget is never shown, and the note says so', () => {
  const fitted = fit([{ priority: 0, head: ['头'] }, { priority: 1, entries: ['a'.repeat(5000)], unit: '原文', measure: '行', more: () => '原文：按字节范围读' }], { budget: 1000 });
  assert.ok(fitted.text.length <= 1000);
  assert.ok(!fitted.text.includes('aaaa'));
  assert.match(fitted.text, /略去了原文 1 行（第 1 行）。读其余部分：原文：按字节范围读。$/);
});

test('what a renderer shortened in a shown entry is named in the note even when everything fits; in an entry left out it is not', () => {
  const blocks: Block[] = [
    { priority: 0, head: ['头'], omitted: [{ what: '运行目标名称的超出部分', more: '在控制台查看' }] },
    {
      priority: 1,
      entries: [
        { lines: ['- 甲 长…（共 9000 个字符）'], omitted: [{ what: '条目名称的超出部分', more: '读全文：用 get_nodes 读' }] },
        '- 乙',
        { lines: ['- 丙 长…（共 9000 个字符）'], omitted: [{ what: '条目名称的超出部分', more: '读全文：用 get_nodes 读' }] },
      ],
      unit: '条目',
      measure: '个',
    },
  ];
  const fitted = fit(blocks, { tail: ['追踪 t'] });
  assert.equal(fitted.cut, true);
  const lines = fitted.text.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['头', '- 甲 长…（共 9000 个字符）', '- 乙', '- 丙 长…（共 9000 个字符）'], 'everything is shown');
  assert.equal(lines.at(-2), '部分：有字段超过长度上限被截短：运行目标名称的超出部分、条目名称的超出部分（2 处）。读其余部分：在控制台查看；读全文：用 get_nodes 读。', 'the answer was within the budget: the note blames the field caps, not the budget');
  const both = fit([{ priority: 0, head: ['头'], entries: [{ lines: ['- 甲 长…（共 9000 个字符）'], omitted: [{ what: '条目名称的超出部分', more: '读全文：用 get_nodes 读' }] }, 'x'.repeat(400)], unit: '条目', measure: '个' }], { budget: 300 });
  assert.match(both.text, /部分：这段回答以 300 个字符为限，略去了条目 1 个（第 2 个）；有字段超过长度上限被截短：条目名称的超出部分。读其余部分：读全文：用 get_nodes 读。/, 'what the budget dropped and what a cap shortened are told apart');
  const tight = fit([{ priority: 0, head: ['头'] }, { priority: 1, entries: ['x'.repeat(100), { lines: [`- 丙${'y'.repeat(100)}`], omitted: [{ what: '条目名称的超出部分', more: null }] }], unit: '条目', measure: '个' }], { budget: 200 });
  assert.ok(!tight.text.includes('条目名称的超出部分'), 'the shortened entry was not shown, so only its absence is named');
  assert.match(tight.text, /条目 1 个（第 2 个）/);
});

test('a block without its own way to read the rest uses the fallback; identical ways are said once', () => {
  const fitted = fit(
    [
      { priority: 1, entries: Array.from({ length: 50 }, (_, i) => `甲 ${i}`), unit: '甲', more: () => '在控制台查看' },
      { priority: 1, entries: Array.from({ length: 50 }, (_, i) => `乙 ${i}`), unit: '乙', more: () => '在控制台查看' },
      { priority: 1, entries: Array.from({ length: 50 }, (_, i) => `丙 ${i}`), unit: '丙' },
    ],
    { budget: 400, fallback: '问管理员' },
  );
  const note = fitted.text.split('\n').at(-1)!;
  assert.equal(note.split('在控制台查看').length - 1, 1, 'said once');
  assert.ok(note.includes('问管理员'));
});

test('softCap: the first part keeps its priority, the rest yields to other blocks, counts on, and needs the first part whole', () => {
  const steps = Array.from({ length: 100 }, (_, i) => `规程第 ${i + 1} 行 ${'x'.repeat(30)}`);
  const items = Array.from({ length: 10 }, (_, i) => `- 条目 ${i}`);
  const blocksOf = (): Block[] => [
    ...softCap({ priority: 1, head: ['规程：'], entries: steps, unit: '规程', more: (from) => `规程：从第 ${from + 1} 行起读` }, 500, 5, 0),
    { priority: 2, head: ['条目：'], entries: items, unit: '条目', measure: '个' },
  ];
  const fitted = fit(blocksOf(), { budget: 1200 });
  assert.ok(fitted.text.length <= 1200);
  const [firstPart, rest, shownItems] = fitted.shown;
  const lines = fitted.text.split('\n');
  assert.ok(firstPart > 0 && firstPart < 100);
  assert.equal(shownItems, 10, 'the items fill before the rest of the procedure');
  assert.ok(rest > 0, 'the rest takes what is left');
  const shownSteps = lines.filter((l) => l.startsWith('规程第 '));
  assert.deepEqual(shownSteps, steps.slice(0, firstPart + rest), 'one contiguous procedure, in order');
  assert.ok(lines.indexOf('条目：') > lines.indexOf(shownSteps.at(-1)!), 'display order is kept');
  const from = firstPart + rest;
  assert.ok(lines.at(-1)!.includes(`规程 ${100 - from} 行（第 ${from + 1} 到第 100 行）`), 'the rest counts on from the first part');
  assert.ok(lines.at(-1)!.includes(`规程：从第 ${from + 1} 行起读`), 'and its way on starts at the first line left out');
  const tight = fit(blocksOf(), { budget: 300 });
  assert.equal(tight.shown[1], 0, 'nothing of the rest while the first part is not whole');
  assert.ok(tight.text.length <= 300);
});

test('softCap with a rest priority below the list’s own: the rest still follows the first part and is never dropped silently', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`);
  const blocks = softCap({ priority: 3, entries: lines, unit: '行' }, 20, 1, 0);
  assert.equal(blocks[1].priority, 3, 'the rest is not put before the first part');
  const fitted = fit(blocks);
  assert.equal(fitted.text, lines.join('\n'), 'everything fits, so everything is shown');
  assert.equal(fitted.cut, false);
  // A block whose prerequisite has a later priority waits for it instead of being skipped for good.
  const manual: Block[] = [
    { priority: 3, entries: ['甲 1', '甲 2'] },
    { priority: 1, entries: ['乙 1'], after: 0 },
  ];
  assert.equal(fit(manual).text, ['甲 1', '甲 2', '乙 1'].join('\n'));
  // A prerequisite that is never shown whole: the waiting block shows nothing, and the note names it.
  const cyclic: Block[] = [
    { priority: 1, entries: ['丙 1'], after: 1, unit: '丙' },
    { priority: 1, entries: ['丁 1'], after: 0, unit: '丁' },
  ];
  const stuck = fit(cyclic);
  assert.equal(stuck.cut, true);
  assert.match(stuck.text, /^部分：.*丙 1 行（第 1 行）.*丁 1 行（第 1 行）/);
});

test('oneLine turns every line break into a space', () => {
  assert.equal(oneLine(`a\r\nb\nc\rd\u000be\u000cf${String.fromCharCode(0x85)}g${String.fromCharCode(0x2028)}h${String.fromCharCode(0x2029)}i`), 'a b c d e f g h i');
  assert.equal(oneLine('无换行'), '无换行');
});

test('property: whatever the blocks, the text is within the budget, lines are never cut, the tail ends it, and the note appears exactly when something was left out', () => {
  for (let run = 0; run < 300; run++) {
    const seed = 1000 + run;
    const next = random(seed);
    const budget = [TEXT_BUDGET, 2000, 500, 160][Math.floor(next() * 4)];
    const tail = next() < 0.5 ? ['追踪 4bf92f3577b34da6a3ce929d0e0e4736'] : [];
    const blocks: Block[] = [];
    for (let b = 0, count = 1 + Math.floor(next() * 8); b < count; b++) {
      const length = (): number => (next() < 0.05 ? 40_000 : next() < 0.2 ? 5000 : Math.floor(next() * 200));
      const line = (tag: string): string => `${tag}${'字'.repeat(length())}`;
      const entries = Array.from({ length: Math.floor(next() * (next() < 0.1 ? 3000 : 40)) }, (_, e) => (next() < 0.3 ? [line(`b${b}e${e}a`), line(`b${b}e${e}b`)] : line(`b${b}e${e}`)));
      const block = {
        priority: Math.floor(next() * 4),
        ...(next() < 0.6 ? { head: [line(`b${b}h`)] } : {}),
        entries,
        unit: `块${b}`,
        more: next() < 0.8 ? (from: number) => `块${b}：从第 ${from + 1} 个起读` : undefined,
      } satisfies Block;
      // Some lists are split by softCap, with any rest priority, lower ones included.
      if (next() < 0.3 && entries.length > 1) blocks.push(...softCap(block, Math.floor(next() * 3000), Math.floor(next() * 5), blocks.length));
      else blocks.push(block);
    }
    const fitted = fit(blocks, { budget, tail });
    assert.ok(fitted.text.length <= budget, `seed ${seed}: ${fitted.text.length} > ${budget}`);
    const lines = fitted.text === '' ? [] : fitted.text.split('\n');
    const notes = lines.filter((l) => NOTE.test(l));
    const everything = blocks.flatMap((b) => [...(b.head ?? []), ...(b.entries ?? []).flatMap(linesOfEntry)]);
    const all = fit(blocks, { budget: Number.MAX_SAFE_INTEGER, tail });
    assert.equal(all.text, [...everything, ...tail].join('\n'), `seed ${seed}: with room for everything, everything is shown in display order`);
    const leftOut = all.text.length > budget;
    assert.equal(fitted.cut, leftOut, `seed ${seed}: cut exactly when everything does not fit`);
    if (!leftOut) {
      assert.equal(fitted.text, all.text, `seed ${seed}`);
      continue;
    }
    assert.equal(notes.length, 1, `seed ${seed}: one note`);
    if (tail.length > 0 && budget >= 500) {
      assert.equal(lines.at(-1), tail[0], `seed ${seed}: the tail ends the text`);
      assert.match(lines.at(-2)!, NOTE, `seed ${seed}: the note comes just before the tail`);
    } else if (tail.length === 0) assert.match(lines.at(-1)!, NOTE, `seed ${seed}: the note is last without a tail`);
    // Every other line is an input line, whole, and they keep their display order.
    const shown = lines.filter((l) => !NOTE.test(l) && !tail.includes(l));
    let at = 0;
    for (const l of shown) {
      while (at < everything.length && everything[at] !== l) at++;
      assert.ok(at < everything.length, `seed ${seed}: a line that is not an input line in order: ${l.slice(0, 40)}`);
      at++;
    }
  }
});

test('the pathological budget fallback retains a concrete way to read what was omitted',()=>{
 const blocks=Array.from({length:20},(_,i)=>({priority:i,head:['header'+i+'字'.repeat(30)],entries:['字'.repeat(200)],unit:'条目'+i,measure:'个' as const}));
 const result=fit(blocks,{budget:160,fallback:'按原结果引用调用 get_nodes 逐页读取'});
 assert.ok(result.text.length<=160);assert.match(result.text,/有些内容没有显示/);assert.match(result.text,/读其余部分：按原结果引用调用 get_nodes 逐页读取/);
});
