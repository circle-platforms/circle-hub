import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import commands, { extractCommands } from './commands.ts';
import { assertTotal, hostileInputs, internalWarnings, randomText, seeded } from '../testing/test-support.ts';
import { assertLinearGrowth, describeGrowth } from '../../../../hub/testing/growth.ts';

const HEADS = ['show demo status', 'show demo pool', 'demo pool add', 'demo pool mode', 'demo route static', 'enable', 'ping', 'no demo pool', 'show'];
// R4: these old prose/quote/abbreviation inputs now have a deliberately empty command set.
// Supply a declared no-argument grammar, so a missing grammar cannot make the negatives pass vacuously.
const definitions = HEADS.map(head=>({path:'/commands/'+head.replaceAll(' ','/'),words:head.split(' '),signatures:[{params:[]}]}));
const phrases = (text:string,heads:string[]=HEADS):string[] => extractCommands({text,definitions:definitions.filter(definition=>heads.includes(definition.words.join(' ')))}).phrases.map(phrase=>phrase.text);

describe('command phrases in Chinese text', () => {
  it('rejects commands embedded in Chinese sentences, preserving every historical probe', () => {
    assert.deepEqual(phrases('在 CLI 下执行 demo pool add p1 192.0.2.5 80 后，查看状态'), []);
    assert.deepEqual(phrases('执行show demo status命令，显示正常'), []);
    assert.deepEqual(phrases('配置 demo route static 192.0.2.0 24 192.0.2.1；再执行 show demo pool p1。'), []);
    assert.deepEqual(phrases('依次执行：\n1. demo pool add p1 2001:db8::5 80\n2. demo pool mode p1 lc'), []);
  });

  it('rejects prose quotations rather than using their appearance as command identity', () => {
    assert.deepEqual(phrases('执行 `demo pool add p1 "pool one" 80` 添加成员'), []);
    assert.deepEqual(phrases('输入“demo pool mode p1 rr”'), []);
    assert.deepEqual(phrases('（show demo status）显示所有池'), []);
    assert.deepEqual(phrases('(demo pool add p1 192.0.2.5 80)'), []);
    assert.deepEqual(phrases("run 'enable' first"), []);
    assert.deepEqual(phrases('「ping 192.0.2.1」'), []);
  });

  it('never removes trailing prose punctuation to manufacture a command', () => {
    assert.deepEqual(phrases('执行 ping 192.0.2.1.'), []);
    assert.deepEqual(phrases('执行 demo pool add p1,p2 192.0.2.5 80, 然后'), []);
    assert.deepEqual(phrases('执行 demo route static 192.0.2.0/24 (default) 后'), []);
  });

  it('rejects case variants and prose despite a known head', () => {
    const result = extractCommands({ text: '执行 Show Demo Status  p1 查看', definitions });
    assert.deepEqual(result.phrases, []);
  });
});

describe('never prose', () => {
  it('does not cut at English stop words or placeholders to salvage a head', () => {
    assert.deepEqual(phrases('执行 show demo status to check the pools'), []);
    assert.deepEqual(phrases('执行 demo pool add xxx 添加'), []);
    assert.deepEqual(phrases('执行 show xxx 命令查看'), []);
    assert.deepEqual(phrases('执行 demo pool add ... 即可'), []);
  });

  it('rejects complete English prose rather than keeping a head', () => {
    assert.deepEqual(phrases('Then run show demo status p1 for the result'), []);
    assert.deepEqual(phrases('You can enable the feature here'), []);
    assert.deepEqual(phrases('The output will show nothing'), []);
    assert.deepEqual(phrases('Please ping the gateway'), []);
  });

  it('rejects lone heads inside prose or quotation markers', () => {
    assert.deepEqual(phrases('先执行 enable 进入特权模式'), []);
    assert.deepEqual(phrases('通过 show 命令查看'), []);
    assert.deepEqual(phrases('通过show命令查看'), []);
    assert.deepEqual(phrases('通过 `show` 查看'), []);
  });

  it('never starts inside a word or on an unknown word', () => {
    assert.deepEqual(phrases('reshow demo status, showing, enabled'), []);
    assert.deepEqual(phrases('执行 demonstrate pool add'), []);
    assert.deepEqual(phrases('执行 show/clear demo status'), []);
    assert.deepEqual(phrases('执行 demo pool add', []), []);
  });
});

describe('phrases on bad input', () => {
  it('is total on hostile inputs', () => {
    for (const [k, input] of hostileInputs().entries()) assertTotal(commands, input, `hostile ${k}`);
    assert.deepEqual(extractCommands({ text: 5 as unknown as string, heads: HEADS }).warnings, ['text 不是字符串']);
  });

  it('keeps its invariants on random text', () => {
    const random = seeded(37);
    const words = ['show', 'demo', 'status', 'pool', 'add', 'enable', 'ping', 'the', 'xxx', '执行', '命令', '，', '。', '`', '"', '“', '”', '(', ')', ' ', ' ', '\n', '192.0.2.1', 'p1', 'to'];
    for (let i = 0; i < 1000; i++) {
      const text = Array.from({ length: random.int(20) }, () => (random.chance(0.1) ? randomText(random, 6) : random.pick(words))).join(random.pick(['', ' ']));
      const result = assertTotal(commands, { text, definitions }, text) as ReturnType<typeof extractCommands>;
      assert.deepEqual(internalWarnings(result), []);
      let previous = 0;
      for (const phrase of result.phrases) {
        assert.equal(text.slice(phrase.start, phrase.end), phrase.text, text);
        assert.ok(phrase.start >= previous && phrase.end > phrase.start, text);
        assert.ok(!/[A-Za-z0-9_\-.]/.test(text[phrase.start - 1] ?? ' '), `starts inside a word: ${text}`);
        assert.ok(HEADS.some((head) => phrase.text.trimStart().startsWith(head.split(' ')[0])), text);
        assert.ok(!/[\u4e00-\u9fff]/.test(phrase.text) || /[`"“「]/.test(text[phrase.start - 1] ?? ''), `Chinese outside quotes: ${text}`);
        previous = phrase.end;
      }
    }
  });

  it('scans long hostile text in linear time', { timeout: 120_000 }, (t) => {
    // Each hostile shape at a length in characters: the full-size text is read once for the result, then the shape is
    // timed on its own at two lengths, so a quadratic scan of one shape is not hidden behind the others. The large
    // length is the 1,000,000-character input limit; one scan of it is a few milliseconds, so every timed run scans its
    // text 20 times, which lifts it above timer noise and leaves the ratio unchanged.
    const shapes: Array<[string, string]> = [['words', 'show '], ['parentheses', '(show '], ['quotes', '"show '], ['arguments', 'show x '], ['letters', 'a']];
    for (const [name, unit] of shapes) {
      const make = (chars: number) => unit.repeat(Math.floor(chars / unit.length));
      const result = extractCommands({ text: make(name === 'letters' ? 1_000_000 : unit.length * 100_000), definitions });
      assert.ok(Array.isArray(result.phrases));
      // The timed large text is read in full, not refused at the input limit.
      assert.deepEqual(extractCommands({ text: make(1_000_000), definitions }).warnings, [], name);
      const scan = (text: string) => {
        for (let k = 0; k < 20; k++) extractCommands({ text, definitions });
      };
      t.diagnostic(describeGrowth(name, assertLinearGrowth(name, make, scan, { small: 125_000 })));
    }
  });
});

 it('R4 a complete declared line is returned with exact source offsets',()=>{const text='demo status\r\ndemo status';const result=extractCommands({text,definitions:[{words:['demo','status'],path:'/commands/demo/status',signatures:[{params:[]}]}]});assert.deepEqual(result.phrases,[{text:'demo status',start:0,end:11},{text:'demo status',start:13,end:24}]);});
