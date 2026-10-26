// Commands named in case texts, against the hand-written truth table of tests/fixtures/case-index (written before the
// resolver ran: every row says which commands must resolve and which must not), the abbreviation and `no` rules, list
// numbers, one scan for many texts, hostile text and size.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_COMMAND_TABLE, CATALOG_A, CATALOG_B, commandPath, commandTreeXml } from '../../../../tests/fixtures/case-index/index.ts';
import { commandCatalog, resolvePhrase, textCommands, withoutListNumbers } from './cases-commands.ts';
import { extractCommands } from './commands.ts';
import { randomText, seeded, xml } from '../testing/test-support.ts';

const catalogA = commandCatalog(xml(commandTreeXml(CATALOG_A))).catalog;
const catalogB = commandCatalog(xml(commandTreeXml(CATALOG_B))).catalog;
// The strict rule supersedes historical prose/shorthand expectations; keep every original row as a probe.
const completeRows=new Set(['plain-interval','plain-pool-add','plain-endpoint-v4','plain-endpoint-v6','plain-beacon','plain-show','plain-show-detail','plain-reboot','plain-ping','short-off','short-on','short-three-words','no-own','path-show-profile','fold-line-end']);
const expectedCommands=(row:typeof CASE_COMMAND_TABLE[number])=>completeRows.has(row.key)?row.commands:[];
const commandsOf = (text: string, catalog = catalogA): string[] => textCommands(catalog, [text]).results[0].paths;

describe('the catalog of a build', () => {
  it('holds every command of the tree at its path, and only complete heads, without inferred abbreviations', () => {
    assert.equal(catalogA.size, CATALOG_A.length);
    assert.equal(catalogB.size, CATALOG_B.length);
    for (const command of CATALOG_A) {assert.ok(catalogA.heads.includes(command.words));if(command.args.some(arg=>!arg.optional))assert.notEqual(resolvePhrase(catalogA,command.words),commandPath(command.words),'this mandatory-argument command cannot resolve without its argument; another complete signature may consume the word as a parameter');}
    assert.ok(!catalogA.heads.includes('sh') && !catalogA.heads.includes('sys') && !catalogA.heads.includes('wid'));
    assert.ok(!catalogA.heads.includes('s'), 'one letter is never an abbreviation');
    assert.ok(!catalogA.heads.includes('be'), 'an English short word is never an abbreviation');
    assert.ok(!catalogA.heads.includes('n'), 'no is a word of its own');
  });

  it('an empty or broken tree gives an empty catalog, and nothing resolves', () => {
    const empty = commandCatalog(xml('<commands><scope type="global"></scope></commands>')).catalog;
    assert.equal(empty.size, 0);
    assert.deepEqual(textCommands(empty, ['widget health interval pool1 5']).results[0], { paths: [], phrases: 0, unresolved: 0, states:[{status:'not_command',path:null}], identities:[] });
    assert.equal(commandCatalog({ root: null } as never).catalog.size, 0);
  });
});

describe('the truth table', () => {
  it(`has at least 40 rows, commands that must resolve and words that must not`, () => {
    assert.ok(CASE_COMMAND_TABLE.length >= 40);
    assert.ok(CASE_COMMAND_TABLE.filter((r) => r.commands.length > 0).length >= 10);
    assert.ok(CASE_COMMAND_TABLE.filter((r) => r.commands.length === 0).length >= 20);
    assert.equal(new Set(CASE_COMMAND_TABLE.map((r) => r.key)).size, CASE_COMMAND_TABLE.length);
  });

  for (const row of CASE_COMMAND_TABLE) {
    it(`${row.key}: ${row.note}`, () => {
      assert.deepEqual(commandsOf(row.text), expectedCommands(row).map(commandPath).sort(), row.text);
    });
  }

  it('against the later catalog, a removed command no longer resolves and the rest is the same', () => {
    const removed = new Set(CATALOG_A.map((c) => c.words).filter((w) => !CATALOG_B.some((c) => c.words === w)));
    for (const row of CASE_COMMAND_TABLE) {
      assert.deepEqual(commandsOf(row.text, catalogB), expectedCommands(row).filter((w) => !removed.has(w)).map(commandPath).sort(), row.text);
    }
  });
});

describe('resolution rules', () => {
  it('abbreviations never become command identities', () => {
    assert.equal(resolvePhrase(catalogA, 'sh health'), null);
    assert.equal(resolvePhrase(catalogA, 'SHO HEA DET pool1'), null);
    assert.equal(resolvePhrase(catalogA, 'sh'), null, 'an abbreviation alone is no command');
    assert.equal(resolvePhrase(catalogA, 'pin 192.0.2.1'), null, 'a one-word command reached through an abbreviation needs a second word');
    assert.equal(resolvePhrase(catalogA, 'relay en 192.0.2.1'), null, 'en names endpoint and encrypt');
    assert.equal(resolvePhrase(catalogA, 'widget h interval'), null, 'one letter is no abbreviation');
    assert.equal(resolvePhrase(catalogA, 'widget health interva pool1'), null);
  });

  it('complete typed signatures distinguish a declared longer command from a quoted argument', () => {
    assert.equal(resolvePhrase(catalogA, 'show health detail pool1'), '/commands/show/health/detail');
    assert.equal(resolvePhrase(catalogA, 'show health pool1'), '/commands/show/health');
    assert.equal(resolvePhrase(catalogA, 'show health "detail"'), '/commands/show/health', 'a quoted word is an argument');
  });

  it('no forms require their own complete declared path', () => {
    assert.equal(resolvePhrase(catalogA, 'no widget health probe pool1'), '/commands/no/widget/health/probe');
    assert.equal(resolvePhrase(catalogA, 'no widget pool mode pool1'), null);
    assert.equal(resolvePhrase(catalogA, 'no'), null);
    assert.equal(resolvePhrase(catalogA, 'no such thing'), null);
  });

  it('source spelling and numbers are preserved without list-prefix erasure', () => {
    for (const [text, expected] of [
      ['1.widget pool delete pool1', '  widget pool delete pool1'],
      ['（2）show pools', '   show pools'],
      ['步骤 3、show pools', '步骤   show pools'],
      ['10.6.1 版本', '10.6.1 版本'],
      ['ping 192.0.2.1', 'ping 192.0.2.1'],
      ['执行 1.5 秒后', '执行 1.5 秒后'],
    ] as const) {
      const out = withoutListNumbers(text);
      assert.equal(out, text, text);
      assert.equal(out.length, text.length);
    }
  });
});

describe('one scan for many texts', () => {
  it('gives every text exactly what scanning it alone gives', () => {
    const random = seeded(73);
    const pieces = ['widget', 'health', 'interval', 'pool1', 'show', 'sh', 'no', 'relay', 'endpoint', 'en', '192.0.2.1', '执行', '命令', '，', '`', '“', '”', ' ', ' ', '\n', '1.', 'the', 'xxx'];
    const texts = Array.from({ length: 400 }, () => Array.from({ length: random.int(14) }, () => (random.chance(0.1) ? randomText(random, 8) : random.pick(pieces))).join(random.pick(['', ' '])));
    const together = textCommands(catalogA, texts).results;
    texts.forEach((text, k) => assert.deepEqual(together[k], textCommands(catalogA, [text]).results[0], JSON.stringify(text)));
  });

  it('counts phrases that resolve to nothing', () => {
    const result=textCommands(catalogA,['widget health 配置','widget health interval pool1 5，widget health timeout 3','基本功能']).results;
    assert.deepEqual(result.map(({states,...measurement})=>measurement),Array.from({length:3},()=>({paths:[],phrases:0,unresolved:0,identities:[]})));
    assert.ok(result.every(r=>r.states?.every(s=>s.status==='not_command')));

  });

  it('stays linear on long and hostile text', () => {
    const long = ['widget '.repeat(200_000), 'sh '.repeat(200_000), `"${'show health '.repeat(50_000)}`, '1.'.repeat(300_000), 'a'.repeat(1_200_000), '\u0000\ud800widget health interval\u0000'];
    const start = performance.now();
    const out = textCommands(catalogA, long);
    assert.ok(performance.now() - start < 10_000, 'took too long');
    assert.equal(out.results.length, long.length);
    assert.deepEqual(out.results[5].paths, []);
  });

  it('extractCommands is the phrase finder: a phrase the resolver gets is one commands.ts finds', () => {
    const text = '在 CLI 下执行 widget health interval pool1 5 后，show health 显示间隔';
    assert.deepEqual(extractCommands({ text, heads: catalogA.heads }).phrases.map((p) => p.text), []);
  });
});
