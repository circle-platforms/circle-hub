import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_ROOT, fixture } from '../testing/blocks.ts';
import { checkCommandsKnown } from './checks.ts';
import { planCommands } from './plan-commands.ts';
import { planSubject } from './subject.ts';
import { opened } from './text.ts';
import { COMMAND_CATALOG, CONTRACT_DOC, MANIFEST_DOC, PROFILE_DOC, QUOTE, AUTOID, goodData } from './test-support.ts';
import type { PlanSlots } from './slots.ts';

const ROW = '该参数指定主机名。取值必须为长度不大于64个字节的字符串。特殊字符仅支持“._-”，通配符“*”只能位于起始位置。不允许为保留字“default”或“all”，这些保留字不区分大小写。取值不能包含空格。';
const REFERENCE = 'tree:' + BLOCK_ROOT + '/manual/cli/hosts@' + 'e'.repeat(64);
const RECORD = 'rec:' + 'd'.repeat(64);
const RULES = [
  { kind: 'max_bytes', limit: 64, quote: '长度不大于64个字节' },
  { kind: 'allowed_specials', characters: ['.', '_', '-'], quote: '特殊字符仅支持“._-”' },
  { kind: 'wildcard', character: '*', quote: '通配符“*”只能位于起始位置' },
  { kind: 'reserved_words', words: ['default', 'all'], case_insensitive: true, quote: '不允许为保留字“default”或“all”，这些保留字不区分大小写' },
  { kind: 'no_whitespace', quote: '取值不能包含空格' },
];
const claim = (extra: Record<string, unknown> = {}) => {
  const rules = (extra.rules ?? RULES) as Array<{ quote: string }>;
  return { commands: ['demo host name'], parameter: 'host_name', reference: REFERENCE, row: extra.rules === undefined ? ROW : rules.map((rule) => rule.quote).join('。'), rules, record: RECORD, ...extra };
};

const f = fixture();
const source = 'src:' + BLOCK_ROOT + '/json@1/p';
const type = (name: string) => ({ name: 'synthetic-' + name, declaration: source + '/types/' + name, grammar: 'synthetic-tree@1' });
const native = (path: string, params: unknown[]) => ({ words: path.split('/').slice(2), reference: 'tree:' + BLOCK_ROOT + path, signatures: [{ id: path, reference: 'src:' + BLOCK_ROOT + '/xml@1/x' + path + '/arguments', params }] });
const text = { name: 'host_name', type: 'string', native_type: type('text') };
const catalogWith = (value_domains?: unknown): any => {
  const catalog: any = structuredClone(f.catalog);
  catalog.entries.push(
    native('/commands/demo/host/name', [text, { name: 'ttl', type: 'int', minimum: 1, maximum: 3600, optional: true, native_type: type('int') }]),
    native('/commands/demo/host/peer', [{ name: 'peer', type: 'ip_or_hostname', native_type: type('address') }]),
    native('/commands/demo/show/host', [text]),
  );
  if (value_domains !== undefined) catalog.value_domains = value_domains;
  return catalog;
};
const flat = (...lines: string[]): PlanSlots => ({ bucket: 'bed-a', blocks: [], steps: lines.map((line) => ({ object: 'ORBIT_0', method: 'command', args: [line], keywords: {} })), expects: [], replacements: [] } as unknown as PlanSlots);
const plan = (line: string, value_domains?: unknown) => planCommands(f.contract, f.profile, flat(line), catalogWith(value_domains));
const refusals = (line: string, value_domains?: unknown) => plan(line, value_domains).problems.filter((problem) => problem.verdict === 'refute');

test('a host name excluded by the manual’s row is refused with its quotation and an unconfirmed model judgment', () => {
  const refused = refusals('demo host name a:b 60', [claim()]);
  assert.equal(refused.length, 1, JSON.stringify(refused));
  assert.equal(refused[0]!.pointer, '/steps/0/args/0');
  assert.equal(refused[0]!.document, 'catalog');
  const message = refused[0]!.message;
  assert.match(message, /^命令“demo host name”的参数 host_name 的取值“a:b”不符合手册对这个参数的说明。状态未确认，判断错误。原因还没查清，/);
  assert.match(message, /含手册没有允许的字符“:”（手册只允许字母、数字和“\.”、“_”、“-”）/);
  assert.ok(message.includes('（手册写：「特殊字符仅支持“._-”」）'), message);
  assert.match(message, /下一步由编写模型改成符合手册说明的取值/);
  assert.match(message, /证据是上述手册原句，决定者是模型$/);
  assert.equal(plan('demo host name a:b 60', [claim()]).identities.length, 1);
});

test('a value the manual’s row allows is not refused, at the limit and with the wildcard at the start', () => {
  for (const line of ['demo host name www.example.com', 'demo host name host-01_a.b 60', 'demo host name *.example', `demo host name ${'a'.repeat(64)}`, 'demo host name Defaults']) {
    assert.deepEqual(plan(line, [claim()]).problems, [], line);
  }
  assert.equal(refusals(`demo host name ${'a'.repeat(65)}`, [claim()]).length, 1);
});

test('the length, the wildcard, the reserved words and white space of the row are refused as well, a quoted value by what it holds', () => {
  const told = (line: string): string => refusals(line, [claim()]).map((one) => one.message).join('\n');
  assert.match(told(`demo host name ${'a'.repeat(65)}`), /长度 65 个字节，手册写的上限是 64 个字节（手册写：「长度不大于64个字节」）/);
  assert.match(told('demo host name a*'), /通配符“\*”只能放在取值的最前面/);
  assert.match(told('demo host name Default'), /取值“default”是手册写明的保留字（不分大小写）/);
  assert.match(told('demo host name "a b"'), /含空白字符，手册写明取值不能包含空格/);
  assert.match(told('demo host name "a b"'), /取值“a b”/, 'the value is shown without its quotes');
  assert.equal(refusals('demo host name a:b$c', [claim()]).length, 1, 'one refusal per literal, with every broken rule in it');
  assert.match(told('demo host name 中文'), /含手册没有允许的字符“中”、“文”/);
});

test('a plan is changed by nothing when no claim covers its parameter', () => {
  const without = plan('demo host name a:b 60');
  assert.deepEqual(without.problems, []);
  const same = (value_domains: unknown) => assert.deepEqual(plan('demo host name a:b 60', value_domains), without, String(JSON.stringify(value_domains)).slice(0, 80));
  same(undefined);
  same([]);
  same('not a list');
  same([claim({ commands: ['demo host other'] })]);
  same([claim({ commands: ['demo host'] })]);
  same([claim({ parameter: 'hostname' })]);
  same([claim({ rules: [{ kind: 'max_bytes', limit: 0, quote: '0' }] })]);
  same([claim({ extra: 1 })]);
  same([claim({ row: '另一行手册原文' })]);
  same([claim({ rules: [{ kind: 'allowed_specials', characters: ['.', '_', '-', ':'], quote: '特殊字符仅支持“._-”' }] })]);
  assert.equal(refusals('demo host name a:b 60', [claim({ extra: 1 }), claim()]).length, 1);
});

test('only text is judged by a claim: a number, or an address the grammar read, keeps its own type', () => {
  const ttl = claim({ parameter: 'ttl', rules: [{ kind: 'max_characters', limit: 1, quote: '最长1个字符' }] });
  assert.deepEqual(plan('demo host name a.b 60', [ttl]).problems, []);
  const peer = claim({ commands: ['demo host peer'], parameter: 'peer', rules: [{ kind: 'max_characters', limit: 5, quote: '最长5个字符' }] });
  assert.equal(refusals('demo host peer host-1.example', [peer]).length, 1);
  assert.deepEqual(refusals('demo host peer abc', [peer]), []);
  for (const address of ['2001:db8::1', '192.0.2.7']) {
    assert.equal(plan(`demo host peer ${address}`, [peer]).identities[0]!.parameters[0]!.parsed.kind, 'address');
    assert.deepEqual(plan(`demo host peer ${address}`, [peer]).problems, [], address);
  }
});

test('claims that disagree on a rule do not judge by it; the rules they agree on still do', () => {
  const stricter = claim({ rules: [{ kind: 'max_bytes', limit: 8, quote: '长度不大于8个字节' }] });
  const line = `demo host name ${'a'.repeat(20)}`;
  assert.deepEqual(refusals(line, [claim(), stricter]), [], 'the lengths are read two ways: neither is used');
  assert.equal(refusals('demo host name a:b', [claim(), stricter]).length, 1, 'the characters are read one way');
  assert.equal(refusals(`demo host name ${'a'.repeat(65)}`, [claim(), claim({ record: 'rec:' + 'c'.repeat(64) })]).length, 1);
});

test('the refusal reaches the plan check of the pack as a refusal of the command, and the claims reach it through the check’s input', () => {
  const data = (line: string): any => ({ bucket: 'bed-a', blocks: [], steps: [{ object: 'ORBIT_0', method: 'command', args: [line], keywords: {} }], expects: [], replacements: [] });
  const check = (line: string, value_domains?: unknown) => { const input: any = f.subject(data(line)); input.subject.command_catalog = catalogWith(value_domains); return checkCommandsKnown(input); };
  assert.deepEqual(check('demo show host a:b').map((one) => one.verdict), ['support']);
  const refused = check('demo show host a:b', [claim({ commands: ['demo show host'] })]);
  assert.deepEqual(refused.map((one) => one.verdict), ['refute']);
  assert.match(refused[0]!.statement, /命令“demo show host”的参数 host_name 的取值“a:b”不符合手册对这个参数的说明/);
  assert.deepEqual(check('demo show host a.b', [claim({ commands: ['demo show host'] })]).map((one) => one.verdict), ['support']);

  const raw = (extra: Record<string, unknown>): any => {
    const slots = goodData();
    return { item: { id: 'doc-1:c-1', location: QUOTE.reference, fields: { autoid: AUTOID, title: '健康检查间隔配置测试', path: ['合成文档', '健康检查间隔配置测试'], priority: '2', steps: [{ text: '开启' }], expected: [QUOTE.text] } }, slots: { plan: [{ data: slots }] }, catalog: COMMAND_CATALOG.entries, catalog_complete: true, ...extra,
      context: { command_policy: COMMAND_CATALOG.policy, root: COMMAND_CATALOG.root, groups: [{ kind: 'case-compile', contract: CONTRACT_DOC, profile: PROFILE_DOC, manifest: MANIFEST_DOC }] } };
  };
  const carried = opened(planSubject(raw({ value_domains: [claim()] })).command_catalog) as Record<string, unknown>;
  assert.deepEqual(carried.value_domains, [claim()]);
  assert.equal(carried.root, COMMAND_CATALOG.root);
  assert.equal('value_domains' in (opened(planSubject(raw({})).command_catalog) as object), false, 'a check that is given none carries none');
  assert.equal('value_domains' in (opened(planSubject(raw({ value_domains: 'x' })).command_catalog) as object), false);
  const lines = planCommands(f.contract, f.profile, flat('demo host name a.b'), catalogWith([claim()]));
  assert.equal('value_domains' in (lines.catalog as object), false);
});

test('a long value and a long list of broken rules are told short enough to read', () => {
  const read = refusals('demo host name ' + 'a'.repeat(200) + ':', [claim()])[0]!.message;
  assert.ok(read.includes('取值“' + 'a'.repeat(79) + '…”'), read.slice(0, 200));
  assert.ok(read.length < 1500, String(read.length));
  const many = claim({ rules: [
    { kind: 'max_bytes', limit: 253, quote: '长度不大于253个字节' }, { kind: 'part_max_characters', limit: 63, separator: '.', quote: '由“.”分隔的各部分不超过63个字符' }, { kind: 'allowed_specials', characters: ['.', '_', '-'], quote: '特殊字符仅支持“._-”' },
    { kind: 'wildcard', character: '*', quote: '通配符“*”只能位于起始位置' }, { kind: 'not_at_start', characters: ['.'], quote: '“.”不能置于起始位置' }, { kind: 'not_at_end', characters: ['.'], quote: '“.”不能置于结尾位置' },
    { kind: 'reserved_words', words: ['all'], case_insensitive: true, quote: '不允许为保留字“all”' }, { kind: 'no_whitespace', quote: '取值不能包含空格' },
  ] });
  const told = refusals('demo host name ".' + 'a'.repeat(300) + ' *"', [many]);
  assert.equal(told.length, 1);
  assert.match(told[0]!.message, /；另有 1 条。下一步/);
  assert.equal(told[0]!.message.split('（手册写：').length - 1, 5);
});
