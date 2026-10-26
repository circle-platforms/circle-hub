// The catalog view, typed parameters, the tokenizer, overload matching and the catalog interpreter on a synthetic CLI-like
// catalog built here (invented commands; no product content).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { CatalogParam } from '../../../contracts/src/tables.ts';
import { catalogInterpreter } from '../interpreters/catalog.ts';
import { checkParam, isIpv6, isMask, parseIpv4 } from './params.ts';
import { matchSignatures } from './signature.ts';
import { tokenize } from './tokenize.ts';
import { buildCatalog, createCatalogView } from './view.ts';

const ROOT = 'a'.repeat(64);
const p = (name: string, type: CatalogParam['type'], extra: Partial<CatalogParam> = {}): CatalogParam => ({ name, type, ...extra });

/** A small device CLI: menus of words, entries with typed parameters, one entry with two overloads, one without arguments. */
const cli = () =>
  buildCatalog({
    root: ROOT,
    entries: [
      { head: 'gw listener add', signatures: [[p('name', 'string', { maxLength: 16 }), p('address', 'ipv4'), p('port', 'port', { minimum: 1 }), p('backlog', 'int', { minimum: 1, maximum: 4096, optional: true, default: '128' })]] },
      { head: 'gw listener del', signatures: [[p('name', 'string')]] },
      {
        head: 'gw route',
        signatures: [
          [p('network', 'ipv4'), p('mask', 'mask'), p('via', 'ipv4')],
          [p('network6', 'ipv6'), p('length', 'int', { minimum: 0, maximum: 128 }), p('via6', 'ipv6')],
        ],
      },
      { head: 'gw log level', signatures: [[p('level', 'enum', { values: ['debug', 'info', 'error'] })]] },
      { head: 'gw restart', signatures: [[p('now', 'keyword', { optional: true })]] },
      { head: 'gw status' },
    ],
  });

const table = {
  schema: 'catalog@1',
  origin: '测试：命令按目录核对',
  basis: '测试条款：用例里的命令要能按目录解析',
  catalog: 'commands',
  commands: ['$.fields.commands'],
  item: '/id',
  location: '/location',
  negative: { flag: '/fields/negative', expect: ['core.catalog.param_out_of_range'], tier: 'advisory' },
};
const subject = (commands: string[], negative = false) => ({ id: 'map:7', location: `src:${'b'.repeat(64)}/mindmap@1/7`, fields: { negative, commands } });
const run = (commands: string[], negative = false, view = cli(), t: unknown = table) =>
  catalogInterpreter.run({ interpreter: 'catalog@1', table: t, subject: subject(commands, negative), catalog: view, context: {} });

describe('catalog interpreter on a synthetic CLI', () => {
  it('a command that matches its signature is supported, grounded in the entry and the item', () => {
    const [o] = run(['gw listener add api 192.0.2.7 8443']);
    assert.equal(o.verdict, 'support');
    assert.equal(o.item, 'map:7');
    assert.equal(o.tier, 'blocking');
    assert.deepEqual(o.grounds, [`tree:${ROOT}/gw/listener/add`, `src:${'b'.repeat(64)}/mindmap@1/7`]);
    assert.deepEqual(o.data?.arguments, [
      { param: 'name', value: 'api' },
      { param: 'address', value: '192.0.2.7' },
      { param: 'port', value: '8443' },
      { param: 'backlog', omitted: true, default: '128' },
    ]);
  });

  it('an out-of-range port is refuted with core.catalog.param_out_of_range', () => {
    const [o] = run(['gw listener add api 192.0.2.7 70000']);
    assert.equal(o.verdict, 'refute');
    assert.equal(o.code, 'core.catalog.param_out_of_range');
    assert.equal(o.tier, 'blocking');
    assert.match(o.statement, /参数取值超出目录声明的范围/);
    assert.match(o.statement, /端口号 1–65535/);
  });

  it('a negative case with an out-of-range port: still refuted, at advisory tier, marked as the expected outcome', () => {
    const [o] = run(['gw listener add api 192.0.2.7 70000'], true);
    assert.equal(o.verdict, 'refute');
    assert.equal(o.code, 'core.catalog.param_out_of_range');
    assert.equal(o.tier, 'advisory');
    assert.equal(o.data?.negative_case, true);
    assert.equal(o.data?.expected, true);
  });

  it('a negative case whose command is valid is marked as not producing the expected refutation', () => {
    const [o] = run(['gw listener add api 192.0.2.7 80'], true);
    assert.equal(o.verdict, 'support');
    assert.equal(o.tier, 'advisory');
    assert.equal(o.data?.expected, false);
  });

  it('overloads, types, arity and the other parameter kinds', () => {
    const outcomes = run([
      'gw route 192.0.2.0 255.255.255.0 192.0.2.1',
      'gw route 2001:db8:1:: 48 2001:db8::1',
      'gw route 2001:db8:1:: 129 2001:db8::1',
      'gw route 192.0.2.0 255.255.0.255 192.0.2.1',
      'gw log level ERROR',
      'gw log level verbose',
      'gw restart now',
      'gw restart later',
      'gw status',
      'gw status all',
      'gw listener add',
      'gw listener add a-name-that-is-too-long 192.0.2.7 80',
      'gw listener add api 192.0.2.300 80',
      'gw listener add api 192.0.2.7 80 0',
    ]);
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.code ?? null, o.data?.overload ?? null]),
      [
        ['support', null, 1],
        ['support', null, 2],
        ['refute', 'core.catalog.param_out_of_range', 2],
        ['refute', 'core.catalog.param_type_mismatch', 1],
        ['support', null, 1],
        ['refute', 'core.catalog.param_type_mismatch', 1],
        ['support', null, 1],
        ['refute', 'core.catalog.param_type_mismatch', 1],
        ['support', null, 1],
        ['refute', 'core.catalog.arity_mismatch', null],
        ['refute', 'core.catalog.arity_mismatch', null],
        ['refute', 'core.catalog.param_out_of_range', 1],
        ['refute', 'core.catalog.param_type_mismatch', 1],
        ['refute', 'core.catalog.param_out_of_range', 1],
      ],
    );
  });

  it('a phrase whose head does not resolve is outside the default scope; first_word and all report non-members', () => {
    assert.deepEqual(run(['gw lisener add api 192.0.2.7 80', '重启网关']).map((o) => o.data?.skipped), [2]);
    const firstWord = run(['gw lisener add api 192.0.2.7 80', '重启网关'], false, cli(), { ...table, scope: 'first_word' });
    assert.deepEqual(firstWord.map((o) => o.code), ['core.catalog.not_member']);
    assert.deepEqual(firstWord[0].grounds[0], `tree:${ROOT}/`);
    const all = run(['重启网关'], false, cli(), { ...table, scope: 'all' });
    assert.deepEqual(all.map((o) => o.code), ['core.catalog.not_member']);
  });

  it('absence is unknown, not refuted, when the catalog is not declared complete', () => {
    const incomplete = createCatalogView(cli().entries(), { complete: false, reference: `tree:${ROOT}/` });
    const [o] = run(['gw lisener add x'], false, incomplete, { ...table, scope: 'all' });
    assert.equal(o.verdict, 'unknown');
    assert.equal(o.reason, 'integrity_unproven');
    const claims = catalogInterpreter.run({
      interpreter: 'catalog@1',
      table: { ...table, commands: undefined, claims: { select: '$.claims[*]', command: '/c', present: '/p' } },
      subject: { claims: [{ c: 'gw purge', p: false }, { c: 'gw status', p: false }, { c: 'gw listener', p: true }] },
      catalog: incomplete,
      context: {},
    });
    assert.deepEqual(
      claims.map((c) => [c.verdict, c.code ?? c.reason ?? null]),
      [
        ['unknown', 'integrity_unproven'],
        ['refute', 'core.catalog.membership_contradicted'],
        ['support', null],
      ],
    );
  });

  it('no catalog bound is unknown (missing input); a case-sensitive catalog keeps case', () => {
    const [missing] = catalogInterpreter.run({ interpreter: 'catalog@1', table, subject: subject(['gw status']), context: {} });
    assert.equal(missing.reason, 'missing_input');
    const sensitive = createCatalogView(cli().entries(), { complete: true, caseSensitive: true });
    assert.equal(run(['GW STATUS'], false, sensitive, { ...table, scope: 'all' })[0].code, 'core.catalog.not_member');
    assert.equal(run(['gw status'], false, sensitive)[0].verdict, 'support');
  });

  it('hostile phrases stay bounded: very many words, an unterminated quote, non-strings', () => {
    const many = `gw listener add ${'x '.repeat(100_000)}`;
    const outcomes = run([many, 'gw listener add "open', 'gw status']);
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.code ?? o.reason]),
      [
        ['refute', 'core.catalog.arity_mismatch'],
        ['unknown', 'check_error'],
        ['support', undefined],
      ],
    );
    const odd = catalogInterpreter.run({ interpreter: 'catalog@1', table, subject: { fields: { commands: [1, null, 'gw status'] } }, catalog: cli(), context: {} });
    assert.deepEqual(odd.map((o) => o.verdict), ['unknown', 'unknown', 'support']);
  });

  it('a phrase that cannot be split stays outside the scope unless its head resolves', () => {
    const outcomes = run(['gw status', "check the gateway's state", '重启网关', 'gw listener add "open']);
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.code ?? o.reason ?? null]),
      [
        ['support', null],
        ['unknown', 'check_error'],
      ],
    );
    assert.equal(outcomes[1].pointer, '/fields/commands/3');
    const firstWord = { ...table, scope: 'first_word' };
    assert.deepEqual(run(["check the gateway's state"], false, cli(), firstWord).map((o) => o.data?.skipped), [1]);
    assert.deepEqual(run(["gw lisener 'x"], false, cli(), firstWord).map((o) => o.reason), ['check_error']);
    assert.deepEqual(run(["check the gateway's state"], false, cli(), { ...table, scope: 'all' }).map((o) => o.reason), ['check_error']);
  });

  it('a missing command location is unknown when the table requires it, and reported as missing otherwise', () => {
    const at = { ...table, commands: ['$.commands'] };
    const go = (t: unknown, s: unknown) => catalogInterpreter.run({ interpreter: 'catalog@1', table: t, subject: s, catalog: cli(), context: {} });
    const [optional] = go(at, {});
    assert.equal(optional.verdict, 'support');
    assert.deepEqual(optional.data?.missing, ['$.commands']);
    const [required] = go({ ...at, required: true }, {});
    assert.equal(required.verdict, 'unknown');
    assert.equal(required.reason, 'missing_input');
    const [empty] = go({ ...at, required: true }, { commands: [] });
    assert.equal(empty.verdict, 'support');
    assert.equal(empty.data?.checked, 0);
    assert.equal(empty.data?.missing, undefined);
  });

  it('a case-sensitive view compares words after Unicode normalization', () => {
    const decomposed = 'café';
    const view = createCatalogView([{ words: [decomposed, 'show'], signatures: [], reference: `tree:${ROOT}/cafe/show` }], { complete: true, caseSensitive: true });
    const all = { ...table, scope: 'all' };
    assert.equal(run([`${decomposed} show`], false, view, all)[0].verdict, 'support');
    assert.equal(run(['café show'], false, view, all)[0].verdict, 'support');
    assert.equal(run(['CAFÉ show'], false, view, all)[0].code, 'core.catalog.not_member');
    assert.equal(view.get(['café', 'show'])?.reference, `tree:${ROOT}/cafe/show`);
  });
});

describe('membership statements', () => {
  const claimsTable = { ...table, commands: undefined, claims: { select: '$.claims[*]', command: '/c', present: '/p' } };
  const claims = (list: { c: string; p: boolean }[], view = cli()) =>
    catalogInterpreter.run({ interpreter: 'catalog@1', table: claimsTable, subject: { claims: list }, catalog: view, context: {} });

  it('words after a head make the command present only when they fit one of its signatures', () => {
    const outcomes = claims([
      { c: 'gw status bogus', p: false },
      { c: 'gw status bogus', p: true },
      { c: 'gw listener add api 192.0.2.7 80', p: true },
      { c: 'gw listener add api 192.0.2.7 80', p: false },
      { c: 'gw listener add api 192.0.2.7 70000', p: false },
      { c: 'gw listener add api', p: true },
      { c: 'gw listener', p: true },
      { c: 'gw status', p: true },
    ]);
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.code ?? null, o.data?.in_catalog]),
      [
        ['support', null, false],
        ['refute', 'core.catalog.membership_contradicted', false],
        ['support', null, true],
        ['refute', 'core.catalog.membership_contradicted', true],
        ['support', null, false],
        ['refute', 'core.catalog.membership_contradicted', false],
        ['support', null, true],
        ['support', null, true],
      ],
    );
    assert.equal(outcomes[0].data?.head, 'gw status');
    assert.deepEqual(outcomes[0].grounds, [`tree:${ROOT}/gw/status`, `tree:${ROOT}/`]);
    assert.match(outcomes[1].statement, /gw status bogus/);
  });

  it('a statement without its command or its yes/no, or with a command that cannot be split, is unknown', () => {
    const outcomes = catalogInterpreter.run({
      interpreter: 'catalog@1',
      table: claimsTable,
      subject: { claims: [{ c: 'gw status' }, { p: true }, { c: 7, p: true }, { c: 'gw "status', p: true }, { c: '   ', p: false }] },
      catalog: cli(),
      context: {},
    });
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.reason ?? null]),
      [
        ['unknown', 'missing_input'],
        ['unknown', 'missing_input'],
        ['unknown', 'missing_input'],
        ['unknown', 'check_error'],
        ['unknown', 'check_error'],
      ],
    );
    const none = catalogInterpreter.run({ interpreter: 'catalog@1', table: claimsTable, subject: {}, catalog: cli(), context: {} });
    assert.deepEqual(none.map((o) => [o.verdict, o.data?.checked]), [['support', 0]]);
  });

  it('on an incomplete catalog, words that do not fit leave the statement unknown either way', () => {
    const incomplete = createCatalogView(cli().entries(), { complete: false, reference: `tree:${ROOT}/` });
    const outcomes = claims(
      [
        { c: 'gw status bogus', p: false },
        { c: 'gw status bogus', p: true },
        { c: 'gw listener add api 192.0.2.7 80', p: true },
      ],
      incomplete,
    );
    assert.deepEqual(
      outcomes.map((o) => [o.verdict, o.code ?? o.reason ?? null]),
      [
        ['unknown', 'integrity_unproven'],
        ['unknown', 'integrity_unproven'],
        ['support', null],
      ],
    );
  });
});

describe('catalog view', () => {
  it('longest match, exact get, prefixes and heads', () => {
    const view = cli();
    assert.equal(view.size, 6);
    assert.equal(view.lookup(['gw', 'listener', 'add', 'x'])?.length, 3);
    assert.equal(view.lookup(['gw', 'listener']), undefined);
    assert.equal(view.get(['gw', 'status'])?.words.join(' '), 'gw status');
    assert.equal(view.get(['gw']), undefined);
    assert.equal(view.hasPrefix(['gw', 'listener']), true);
    assert.equal(view.hasPrefix(['gw', 'nothing']), false);
    assert.deepEqual(view.heads(['gw', 'listener']), [
      ['gw', 'listener', 'add'],
      ['gw', 'listener', 'del'],
    ]);
    assert.equal(view.heads([], { limit: 2 }).length, 2);
    assert.equal(view.lookup(['GW', 'Status'])?.entry.words.join(' '), 'gw status');
    assert.deepEqual(
      view.entries().map((e) => e.words.join(' ')),
      ['gw listener add', 'gw listener del', 'gw log level', 'gw restart', 'gw route', 'gw status'],
    );
  });

  it('overloads given as separate entries of one head become one entry', () => {
    const view = createCatalogView([
      { words: ['x', 'set'], signatures: [{ params: [p('a', 'int')] }], reference: `tree:${ROOT}/x/set` },
      { words: ['X', 'SET'], signatures: [{ params: [p('a', 'ipv4')] }], reference: `tree:${ROOT}/x/set` },
    ]);
    assert.equal(view.size, 1);
    assert.equal(view.get(['x', 'set'])?.signatures.length, 2);
  });

  it('rejects entries that are not catalog-entry@1', () => {
    assert.throws(() => createCatalogView([{ words: [], signatures: [], reference: 'nope' }]), TypeError);
    assert.throws(() => createCatalogView([{ words: ['a'], signatures: [{ params: [{ name: 'p', type: 'float' }] }], reference: `tree:${ROOT}/a` }]), TypeError);
  });
});

describe('parameter types', () => {
  it('IPv4, IPv6 and masks', () => {
    for (const ok of ['0.0.0.0', '192.0.2.255', '255.255.255.255']) assert.ok(parseIpv4(ok), ok);
    for (const bad of ['256.1.1.1', '01.1.1.1', '1.1.1', '1.1.1.1.1', '1..1.1', ' 1.1.1.1', 'a.b.c.d', '']) assert.equal(parseIpv4(bad), undefined, bad);
    for (const ok of ['::', '::1', '1::', '2001:db8::1', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::ffff:192.0.2.1', '1:2:3:4:5:6:192.0.2.1', '1:2:3:4:5:6:7::']) {
      assert.ok(isIpv6(ok), ok);
    }
    for (const bad of ['', ':', ':::', '1:::2', ':1:2:3:4:5:6:7', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', '12345::', 'g::1', '1.2.3.4::', '192.0.2.1', 'fe80::1%en0']) {
      assert.equal(isIpv6(bad), false, bad);
    }
    for (const ok of ['255.255.255.0', '255.255.255.255', '0.0.0.0', '255.128.0.0']) assert.ok(isMask(ok), ok);
    for (const bad of ['255.0.255.0', '255.255.255.1', '0.255.0.0', '255.255.255']) assert.equal(isMask(bad), false, bad);
  });

  it('ports, integers, enums, keywords and string lengths in code points', () => {
    assert.deepEqual(checkParam(p('port', 'port'), '0', false), { ok: true });
    assert.equal(checkParam(p('port', 'port'), '65536', false).ok, false);
    assert.equal((checkParam(p('port', 'port'), '-1', false) as { code: string }).code, 'core.catalog.param_type_mismatch');
    assert.equal((checkParam(p('port', 'port', { minimum: 1024 }), '80', false) as { code: string }).code, 'core.catalog.param_out_of_range');
    assert.equal(checkParam(p('n', 'int', { minimum: -5, maximum: 5 }), '-5', false).ok, true);
    assert.equal((checkParam(p('n', 'int'), '1.5', false) as { code: string }).code, 'core.catalog.param_type_mismatch');
    assert.equal((checkParam(p('n', 'int'), '99999999999999999999', false) as { code: string }).code, 'core.catalog.param_out_of_range');
    assert.equal(checkParam(p('m', 'enum', { values: ['On'] }), 'on', true).ok, true);
    assert.equal(checkParam(p('m', 'enum', { values: ['On'] }), 'on', false).ok, false);
    assert.equal(checkParam(p('force', 'keyword'), 'FORCE', true).ok, true);
    assert.equal(checkParam(p('k', 'keyword', { keyword: 'all' }), 'al', true).ok, false);
    assert.equal(checkParam(p('s', 'string', { maxLength: 2 }), '网关', false).ok, true);
    assert.equal(checkParam(p('s', 'string', { maxLength: 2 }), '网关组', false).ok, false);
  });
});

describe('tokenizer and overload matching', () => {
  it('splits at Unicode white space, honours quotes and escapes, refuses unterminated quotes', () => {
    assert.deepEqual(tokenize('a  b　c\td'), ['a', 'b', 'c', 'd']);
    assert.deepEqual(tokenize(`set name "two words" 'it''s' \\"x`), ['set', 'name', 'two words', 'its', '"x']);
    assert.deepEqual(tokenize('say "a \\"b\\" \\n"'), ['say', 'a "b" \\n']);
    assert.deepEqual(tokenize('""'), ['']);
    assert.equal(tokenize('say "open'), null);
    assert.equal(tokenize('ends with \\'), null);
    assert.deepEqual(tokenize('keep "quotes"', false), ['keep', '"quotes"']);
  });

  it('optional parameters in the middle and the cheapest overload', () => {
    const entry = {
      words: ['t'],
      reference: `tree:${ROOT}/t`,
      signatures: [{ params: [p('a', 'int'), p('flag', 'keyword', { optional: true }), p('b', 'ipv4')] }, { params: [p('c', 'string'), p('d', 'port')] }],
    };
    const take = matchSignatures(entry, ['1', 'flag', '192.0.2.1'], false);
    assert.equal(take.kind, 'match');
    const skip = matchSignatures(entry, ['1', '192.0.2.1'], false);
    assert.equal(skip.kind, 'match');
    if (skip.kind === 'match') assert.deepEqual(skip.best.bindings[1], { param: 'flag', omitted: true });
    const second = matchSignatures(entry, ['name', '99999'], false);
    assert.equal(second.kind, 'violations');
    if (second.kind === 'violations') {
      assert.equal(second.best.overload, 2);
      assert.equal(second.best.violations[0].code, 'core.catalog.param_out_of_range');
    }
    const arity = matchSignatures(entry, ['1', '2', '3', '4'], false);
    assert.deepEqual(arity, { kind: 'arity', arities: [{ min: 2, max: 3 }, { min: 2, max: 2 }] });
  });
});
