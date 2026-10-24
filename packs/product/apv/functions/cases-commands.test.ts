// Commands named in case texts, against the hand-written truth table of tests/fixtures/case-index (every row says which
// whole statements must resolve and which must not), one scan for many texts, hostile text and size.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CASE_COMMAND_TABLE, CATALOG_A, CATALOG_B, commandPath, commandTreeXml, type Arg, type Command } from '../../../../tests/fixtures/case-index/index.ts';
import { commandCatalog, resolvePhrase, textCommands, withoutListNumbers } from './cases-commands.ts';
import { randomText, seeded, xml } from '../testing/test-support.ts';

const catalogA = commandCatalog(xml(commandTreeXml(CATALOG_A))).catalog;
const catalogB = commandCatalog(xml(commandTreeXml(CATALOG_B))).catalog;
const commandsOf = (text: string, catalog = catalogA): string[] => textCommands(catalog, [text]).results[0].paths;

/** A whole statement of one catalog command: its exact words and one value per required argument. */
function statementOf(command: Command): string {
  const valueOf = (arg: Arg): string => {
    const alternatives = arg.limit === undefined ? null : /^\{(.+)\}$/.exec(arg.limit);
    if (alternatives !== null) return alternatives[1].split('|')[0];
    if (arg.type === 'IPADDR') return '192.0.2.1';
    if (arg.type === 'U16' || arg.type === 'U32') return '1';
    return 'pool1';
  };
  return [command.words, ...command.args.filter((arg) => arg.optional !== true).map(valueOf)].join(' ');
}

describe('the catalog of a build', () => {
  it('holds every command of the tree, and a whole statement of it resolves to that path', () => {
    assert.equal(catalogA.size, CATALOG_A.length);
    assert.equal(catalogB.size, CATALOG_B.length);
    for (const command of CATALOG_A) assert.equal(resolvePhrase(catalogA, statementOf(command)), commandPath(command.words), command.words);
    assert.equal(resolvePhrase(catalogA, 'sh health'), null);
    assert.equal(resolvePhrase(catalogA, 'widget health interval'), null, 'required arguments are part of the statement');
  });

  it('an empty or broken tree gives an empty catalog, and nothing resolves', () => {
    const empty = commandCatalog(xml('<commands><scope type="global"></scope></commands>')).catalog;
    assert.equal(empty.size, 0);
    assert.deepEqual(textCommands(empty, ['widget health interval pool1 5']).results[0], { paths: [], phrases: 0, unresolved: 0 });
    assert.equal(commandCatalog({ root: null } as never).catalog.size, 0);
  });
});

describe('the truth table', () => {
  it('has at least 40 rows, commands that must resolve and words that must not', () => {
    assert.ok(CASE_COMMAND_TABLE.length >= 40);
    assert.ok(CASE_COMMAND_TABLE.filter((r) => r.commands.length > 0).length >= 10);
    assert.ok(CASE_COMMAND_TABLE.filter((r) => r.commands.length === 0).length >= 20);
    assert.equal(new Set(CASE_COMMAND_TABLE.map((r) => r.key)).size, CASE_COMMAND_TABLE.length);
  });

  for (const row of CASE_COMMAND_TABLE) {
    it(`${row.key}: ${row.note}`, () => {
      assert.deepEqual(commandsOf(row.text), row.commands.map(commandPath).sort(), row.text);
    });
  }

  it('against the later catalog, a removed command no longer resolves and the rest is the same', () => {
    const removed = new Set(CATALOG_A.map((c) => c.words).filter((w) => !CATALOG_B.some((c) => c.words === w)));
    for (const row of CASE_COMMAND_TABLE) {
      assert.deepEqual(commandsOf(row.text, catalogB), row.commands.filter((w) => !removed.has(w)).map(commandPath).sort(), row.text);
    }
  });
});

describe('resolution rules', () => {
  it('a statement is the exact tree words; a prefix, another case, or a second command is not', () => {
    assert.equal(resolvePhrase(catalogA, 'show health detail pool1'), '/commands/show/health/detail');
    assert.equal(resolvePhrase(catalogA, 'show health pool1'), '/commands/show/health');
    assert.equal(resolvePhrase(catalogA, 'show health "detail"'), '/commands/show/health');
    assert.equal(resolvePhrase(catalogA, 'show health detail'), '/commands/show/health', 'detail is the optional pool, and the longer command still needs its pool');
    assert.equal(resolvePhrase(catalogA, 'sh health'), null);
    assert.equal(resolvePhrase(catalogA, 'SHO HEA DET pool1'), null);
    assert.equal(resolvePhrase(catalogA, 'widget pool add pool1 50 show pools'), null);
  });

  it('a declared no command resolves; no does not undo a command the tree did not declare', () => {
    assert.equal(resolvePhrase(catalogA, 'no widget health probe pool1'), '/commands/no/widget/health/probe');
    assert.equal(resolvePhrase(catalogA, 'no widget pool mode pool1'), null);
    assert.equal(resolvePhrase(catalogA, 'no'), null);
    assert.equal(resolvePhrase(catalogA, 'no such thing'), null);
  });

  it('list numbers before a letter can be blanked, offsets kept; recognition leaves the line as written', () => {
    for (const [text, expected] of [
      ['1.widget pool delete pool1', '  widget pool delete pool1'],
      ['（2）show pools', '   show pools'],
      ['步骤 3、show pools', '步骤   show pools'],
      ['10.6.1 版本', '10.6.1 版本'],
      ['ping 192.0.2.1', 'ping 192.0.2.1'],
      ['执行 1.5 秒后', '执行 1.5 秒后'],
    ] as const) {
      const out = withoutListNumbers(text);
      assert.equal(out, expected, text);
      assert.equal(out.length, text.length);
    }
    assert.deepEqual(commandsOf('1.widget pool delete pool1'), []);
    assert.deepEqual(commandsOf('widget pool delete pool1'), ['/commands/widget/pool/delete']);
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

  it('counts statements that resolve to nothing', () => {
    assert.deepEqual(textCommands(catalogA, ['widget health 配置', 'widget health interval pool1 5，widget health timeout 3', '基本功能']).results, [
      { paths: [], phrases: 1, unresolved: 1 },
      { paths: [], phrases: 1, unresolved: 1 },
      { paths: [], phrases: 1, unresolved: 1 },
    ]);
  });

  it('stays linear on long and hostile text', () => {
    const long = ['widget '.repeat(200_000), 'sh '.repeat(200_000), `"${'show health '.repeat(50_000)}`, '1.'.repeat(300_000), 'a'.repeat(1_200_000), '\u0000\ud800widget health interval\u0000'];
    const start = performance.now();
    const out = textCommands(catalogA, long);
    assert.ok(performance.now() - start < 10_000, 'took too long');
    assert.equal(out.results.length, long.length);
    assert.deepEqual(out.results[5].paths, []);
  });
});
