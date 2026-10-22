import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import commands, { extractCommands } from './commands.ts';
import { assertTotal, hostileInputs, internalWarnings, randomText, seeded } from '../testing/test-support.ts';

const HEADS = ['show demo status', 'show demo pool', 'demo pool add', 'demo pool mode', 'demo route static', 'enable', 'ping', 'no demo pool', 'show'];
const phrases = (text: string, heads: string[] = HEADS): string[] => extractCommands({ text, heads }).phrases.map((phrase) => phrase.text);

describe('command phrases in Chinese text', () => {
  it('finds commands written inside sentences, up to Chinese text and punctuation', () => {
    assert.deepEqual(phrases('在 CLI 下执行 demo pool add p1 192.0.2.5 80 后，查看状态'), ['demo pool add p1 192.0.2.5 80']);
    assert.deepEqual(phrases('执行show demo status命令，显示正常'), ['show demo status']);
    assert.deepEqual(phrases('配置 demo route static 192.0.2.0 24 192.0.2.1；再执行 show demo pool p1。'), ['demo route static 192.0.2.0 24 192.0.2.1', 'show demo pool p1']);
    assert.deepEqual(phrases('依次执行：\n1. demo pool add p1 2001:db8::5 80\n2. demo pool mode p1 lc'), ['demo pool add p1 2001:db8::5 80', 'demo pool mode p1 lc']);
  });

  it('reads commands in backticks, quotes and brackets to the closing mark', () => {
    assert.deepEqual(phrases('执行 `demo pool add p1 "pool one" 80` 添加成员'), ['demo pool add p1 "pool one" 80']);
    assert.deepEqual(phrases('输入“demo pool mode p1 rr”'), ['demo pool mode p1 rr']);
    assert.deepEqual(phrases('（show demo status）显示所有池'), ['show demo status']);
    assert.deepEqual(phrases('(demo pool add p1 192.0.2.5 80)'), ['demo pool add p1 192.0.2.5 80']);
    assert.deepEqual(phrases("run 'enable' first"), ['enable']);
    assert.deepEqual(phrases('「ping 192.0.2.1」'), ['ping 192.0.2.1']);
  });

  it('strips trailing punctuation but keeps argument punctuation', () => {
    assert.deepEqual(phrases('执行 ping 192.0.2.1.'), ['ping 192.0.2.1']);
    assert.deepEqual(phrases('执行 demo pool add p1,p2 192.0.2.5 80, 然后'), ['demo pool add p1,p2 192.0.2.5 80']);
    assert.deepEqual(phrases('执行 demo route static 192.0.2.0/24 (default) 后'), ['demo route static 192.0.2.0/24 (default)']);
  });

  it('matches heads without case and returns the text exactly as written', () => {
    const result = extractCommands({ text: '执行 Show Demo Status  p1 查看', heads: HEADS });
    assert.deepEqual(result.phrases, [{ text: 'Show Demo Status  p1', start: 3, end: 23 }]);
  });
});

describe('never prose', () => {
  it('cuts a phrase at an English stop word or a placeholder', () => {
    assert.deepEqual(phrases('执行 show demo status to check the pools'), ['show demo status']);
    assert.deepEqual(phrases('执行 demo pool add xxx 添加'), ['demo pool add']);
    assert.deepEqual(phrases('执行 show xxx 命令查看'), []);
    assert.deepEqual(phrases('执行 demo pool add ... 即可'), ['demo pool add']);
  });

  it('keeps only the head after an English word, and drops lone words in prose', () => {
    assert.deepEqual(phrases('Then run show demo status p1 for the result'), ['show demo status']);
    assert.deepEqual(phrases('You can enable the feature here'), []);
    assert.deepEqual(phrases('The output will show nothing'), []);
    assert.deepEqual(phrases('Please ping the gateway'), []);
  });

  it('takes a lone complete head in Chinese text, but not when it is named as a command', () => {
    assert.deepEqual(phrases('先执行 enable 进入特权模式'), ['enable']);
    assert.deepEqual(phrases('通过 show 命令查看'), []);
    assert.deepEqual(phrases('通过show命令查看'), []);
    assert.deepEqual(phrases('通过 `show` 查看'), ['show']);
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
      const result = assertTotal(commands, { text, heads: HEADS }, text) as ReturnType<typeof extractCommands>;
      assert.deepEqual(internalWarnings(result), []);
      let previous = 0;
      for (const phrase of result.phrases) {
        assert.equal(text.slice(phrase.start, phrase.end), phrase.text, text);
        assert.ok(phrase.start >= previous && phrase.end > phrase.start, text);
        assert.ok(!/[A-Za-z0-9_\-.]/.test(text[phrase.start - 1] ?? ' '), `starts inside a word: ${text}`);
        assert.ok(HEADS.some((head) => phrase.text.toLowerCase().startsWith(head.split(' ')[0])), text);
        assert.ok(!/[\u4e00-\u9fff]/.test(phrase.text) || /[`"“「]/.test(text[phrase.start - 1] ?? ''), `Chinese outside quotes: ${text}`);
        previous = phrase.end;
      }
    }
  });

  it('scans long hostile text in linear time', () => {
    for (const text of ['show '.repeat(100_000), '(show '.repeat(100_000), '"show '.repeat(100_000), `${'show x '.repeat(100_000)}`, 'a'.repeat(1_000_000)]) {
      const start = performance.now();
      const result = extractCommands({ text, heads: HEADS });
      assert.ok(performance.now() - start < 3000, `${text.slice(0, 10)} took too long`);
      assert.ok(Array.isArray(result.phrases));
    }
  });
});
