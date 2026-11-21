import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bindingProblems, checkValue, claimProblems, effectiveRules, readValueDomainClaim, readValueDomainClaims, readValueRules, rowProblems, valueDomainRefusals, type TreeCommand, type ValueDomainClaim, type ValueRule } from './value-domain.ts';

const ROW = '该参数指定标签名。取值必须为长度不大于120个字节的字符串，由“/”分隔的各段长度不能超过30个字符。特殊字符仅支持“/_-”，通配符“?”只能位于起始位置。“/”不能置于起始和结尾位置，“_”不能置于起始位置。不允许为保留字“none”、“any”或“every”，这些保留字不区分大小写。取值不能包含空格。';
const RULES: ValueRule[] = [
  { kind: 'max_bytes', limit: 120, quote: '长度不大于120个字节' },
  { kind: 'part_max_characters', limit: 30, separator: '/', quote: '由“/”分隔的各段长度不能超过30个字符' },
  { kind: 'allowed_specials', characters: ['/', '_', '-'], quote: '特殊字符仅支持“/_-”' },
  { kind: 'wildcard', character: '?', quote: '通配符“?”只能位于起始位置' },
  { kind: 'not_at_start', characters: ['/', '_'], quote: '“/”不能置于起始和结尾位置，“_”不能置于起始位置' },
  { kind: 'not_at_end', characters: ['/'], quote: '“/”不能置于起始和结尾位置' },
  { kind: 'reserved_words', words: ['none', 'any', 'every'], case_insensitive: true, quote: '不允许为保留字“none”、“any”或“every”，这些保留字不区分大小写' },
  { kind: 'no_whitespace', quote: '取值不能包含空格' },
];
const REFERENCE = 'tree:' + 'f'.repeat(64) + '/manual/cli/tags@' + 'e'.repeat(64);
const claim = (rules: ValueRule[] = RULES, extra: Partial<ValueDomainClaim> = {}): ValueDomainClaim => ({ commands: ['widget tag set'], parameter: 'tag_name', reference: REFERENCE, row: ROW, rules, record: 'rec:' + 'd'.repeat(64), ...extra });
const messages = (value: string, rules: ValueRule[] = RULES): string[] => checkValue(rules, value).map((one) => one.message);

test('a claim in the closed shape reads, and every quote and literal it states lies in the row', () => {
  const read = readValueRules(structuredClone(RULES));
  assert.ok('rules' in read, JSON.stringify(read));
  assert.deepEqual(read.rules, RULES);
  assert.deepEqual(claimProblems(RULES, ROW), []);
  const whole = readValueDomainClaim(claim());
  assert.ok('claim' in whole, JSON.stringify(whole));
  assert.deepEqual('claim' in whole ? whole.claim : null, claim());
});

test('a program checks only that the claim’s quotes and literals are in the row: a number is a whole run of digits, a character and a word are in the quote of their own rule', () => {
  const rule = (extra: Record<string, unknown>) => [{ quote: ROW, ...extra }] as unknown as ValueRule[];
  assert.match(claimProblems([{ kind: 'no_whitespace', quote: '取值可以包含空格' }], ROW)[0]!, /第 1 条规则（no_whitespace）的引文不是手册这一行里的原句/);
  assert.match(claimProblems([{ kind: 'max_bytes', limit: 12, quote: '长度不大于120个字节' }], ROW)[0]!, /数字 12 没有作为完整的一串数字/);
  assert.match(claimProblems([{ kind: 'part_max_characters', limit: 3, separator: '/', quote: '由“/”分隔的各段长度不能超过30个字符' }], ROW)[0]!, /数字 3 没有作为完整的一串数字/);
  assert.deepEqual(claimProblems([{ kind: 'max_bytes', limit: 120, quote: '长度不大于120个字节' }], ROW), []);
  assert.match(claimProblems([{ kind: 'max_characters', limit: 30, quote: '长度不大于120个字节' }], ROW)[0]!, /数字 30 没有作为完整的一串数字/);
  assert.match(claimProblems([{ kind: 'allowed_specials', characters: ['/', '_', '-', ':'], quote: '特殊字符仅支持“/_-”' }], ROW)[0]!, /字符“:”没有出现在它的引文里/);
  assert.match(claimProblems([{ kind: 'part_max_characters', limit: 30, separator: '.', quote: '由“/”分隔的各段长度不能超过30个字符' }], ROW)[0]!, /分隔字符“\.”没有出现在它的引文里/);
  assert.match(claimProblems([{ kind: 'wildcard', character: '*', quote: '通配符“?”只能位于起始位置' }], ROW)[0]!, /通配符“\*”没有出现在它的引文里/);
  assert.match(claimProblems([{ kind: 'reserved_words', words: ['none', 'admin'], case_insensitive: false, quote: '不允许为保留字“none”、“any”或“every”' }], ROW)[0]!, /词“admin”没有出现在它的引文里/);
  assert.match(claimProblems([{ kind: 'reserved_words', words: ['None'], case_insensitive: true, quote: '不允许为保留字“none”、“any”或“every”' }], ROW)[0]!, /词“None”没有出现在它的引文里/);
  assert.equal(claimProblems(rule({ kind: 'max_bytes', limit: 9, quote: '不在行里' }) .concat(rule({ kind: 'no_whitespace', quote: '也不在行里' })), ROW).length, 2);
  assert.deepEqual(claimProblems([{ kind: 'reserved_words', words: ['none'], case_insensitive: false, quote: '不允许为保留字“none”、“any”或“every”，这些保留字不区分大小写' }], ROW), []);
});

test('what is not in the closed shape is no claim, and each way it fails says what is wrong', () => {
  const bad = (rules: unknown): string => {
    const read = readValueRules(rules);
    assert.ok('problems' in read, 'expected a refusal for ' + JSON.stringify(rules));
    return read.problems.join('；');
  };
  const ok = { kind: 'no_whitespace', quote: '不能包含空格' };
  assert.match(bad('x'), /要写 1 到 10 条规则/);
  assert.match(bad([]), /要写 1 到 10 条规则/);
  assert.match(bad([{ ...ok, kind: 'min_bytes' }]), /不在规则种类里/);
  assert.match(bad([{ ...ok, extra: 1 }]), /不属于这种规则的字段：extra/);
  assert.match(bad([{ kind: 'no_whitespace' }]), /quote 要写手册这一行里的原句/);
  assert.match(bad([{ kind: 'no_whitespace', quote: '' }]), /quote 要写手册这一行里的原句/);
  for (const limit of [0, -1, 1.5, '120', null, 1_000_001, Number.NaN]) assert.match(bad([{ kind: 'max_bytes', limit, quote: '120' }]), /limit 要写 1 到 1000000 的整数/);
  assert.match(bad([{ kind: 'part_max_characters', limit: 30, separator: '//', quote: '30' }]), /separator 要写一个字符/);
  assert.match(bad([{ kind: 'part_max_characters', limit: 30, quote: '30' }]), /separator 要写一个字符/);
  assert.match(bad([{ kind: 'allowed_specials', characters: [], quote: '.' }]), /1 到 64 个互不相同的单个字符/);
  assert.match(bad([{ kind: 'allowed_specials', characters: ['.', '.'], quote: '.' }]), /互不相同/);
  assert.match(bad([{ kind: 'allowed_specials', characters: ['ab'], quote: 'ab' }]), /单个字符/);
  assert.match(bad([{ kind: 'allowed_specials', characters: ['a'], quote: 'a' }]), /不能有字母和数字/);
  assert.match(bad([{ kind: 'allowed_specials', characters: ['7'], quote: '7' }]), /不能有字母和数字/);
  assert.match(bad([{ kind: 'forbidden_characters', characters: [1], quote: '1' }]), /单个字符/);
  assert.match(bad([{ kind: 'wildcard', character: ' ', quote: ' ' }]), /非空白字符/);
  assert.match(bad([{ kind: 'wildcard', character: '*', extra: 1, quote: '*' }]), /不属于这种规则的字段/);
  assert.match(bad([{ kind: 'reserved_words', words: ['a b'], case_insensitive: true, quote: 'a b' }]), /不含空白的词/);
  assert.match(bad([{ kind: 'reserved_words', words: ['any'], quote: 'any' }]), /case_insensitive 要写 true 或 false/);
  assert.match(bad([{ kind: 'reserved_words', words: ['any'], case_insensitive: 'yes', quote: 'any' }]), /case_insensitive 要写 true 或 false/);
  assert.match(bad([ok, ok]), /同一种规则（no_whitespace）写了不止一条/);
  assert.match(bad([{ kind: 'allowed_specials', characters: ['.', '-'], quote: '.-' }, { kind: 'forbidden_characters', characters: ['-'], quote: '-' }]), /互相矛盾：“-”/);
  assert.match(bad([{ kind: 'wildcard', character: '*', quote: '*' }, { kind: 'forbidden_characters', characters: ['*'], quote: '*' }]), /同时写在禁用的字符里/);
  assert.match(bad(Array.from({ length: 11 }, () => ok)), /要写 1 到 10 条规则/);
  const wrap = (extra: Record<string, unknown>) => ({ commands: ['widget tag set'], parameter: 'tag_name', reference: REFERENCE, row: ROW, rules: RULES, ...extra });
  assert.ok('claim' in readValueDomainClaim(wrap({})));
  for (const [name, value] of [['commands', []], ['commands', ['widget  tag']], ['commands', ['widget tag set', 'widget tag set']], ['commands', 'widget tag set'], ['parameter', 'tag name'], ['parameter', ''], ['reference', 'src:' + 'a'.repeat(64)], ['row', ''], ['record', 5], ['extra', 1]] as const) {
    assert.ok('problems' in readValueDomainClaim(wrap({ [name]: value })), `${name} = ${JSON.stringify(value)}`);
  }
});

test('the entry a claim quotes must be a manual row that states that parameter of those commands', () => {
  const row = (parameter: unknown) => ({ form: 'table_row', ...(parameter === undefined ? {} : { parameter }) });
  const states = row({ commands: ['widget tag enable', 'widget tag disable'], name: 'tag_name' });
  assert.deepEqual(rowProblems(states, ['widget tag enable'], 'tag_name'), []);
  assert.deepEqual(rowProblems(states, ['widget tag disable', 'widget tag enable'], 'tag_name'), []);
  assert.match(rowProblems(states, ['widget tag enable'], 'level')[0]!, /这一行说明的参数是 tag_name，不是 level/);
  assert.match(rowProblems(states, ['widget tag set'], 'tag_name')[0]!, /没有“widget tag set”/);
  assert.equal(rowProblems(states, ['widget tag set'], 'level').length, 2, 'both mistakes are told');
  for (const data of [row(undefined), row({ commands: ['widget tag set'] }), row({ name: 'tag_name' }), row({ commands: [1], name: 'tag_name' }), row('tag_name'), null, 'x', []]) {
    assert.deepEqual(rowProblems(data, ['widget tag set'], 'tag_name'), ['这一行没有记着它说明哪条命令的哪个参数，不是说明某个参数的手册行'], JSON.stringify(data));
  }
  assert.equal(rowProblems(row({ commands: ['widget tag set'], name: 'Tag_Name' }), ['widget tag set'], 'tag_name').length, 1);
  assert.equal(rowProblems(row({ commands: ['widget tag set'], name: 'tag_name' }), ['widget tag'], 'tag_name').length, 1);
});

test('the locked command tree must have each command with exactly one text parameter of that name, or the claim could never apply', () => {
  const tree: TreeCommand[] = [
    { words: ['widget', 'tag', 'set'], signatures: [{ params: [{ name: 'tag_name', type: 'string' }, { name: 'level', type: 'int' }] }] },
    { words: ['widget', 'tag', 'peer'], signatures: [{ params: [{ name: 'peer', type: 'ip_or_hostname' }] }] },
    { words: ['widget', 'tag', 'twice'], signatures: [{ params: [{ name: 'tag_name', type: 'string' }, { name: 'tag_name', type: 'string' }] }] },
    { words: ['widget', 'tag', 'either'], signatures: [{ params: [{ name: 'tag_name', type: 'int' }] }, { params: [{ name: 'tag_name', type: 'hostname' }] }] },
    { words: ['widget', 'tag', 'kinds'], signatures: [{ params: [{ name: 'mode', type: 'enum' }, { name: 'tag', type: 'keyword' }, { name: 'untyped' }] }] },
  ];
  assert.deepEqual(bindingProblems(tree, ['widget tag set'], 'tag_name'), []);
  assert.deepEqual(bindingProblems(tree, ['widget tag peer'], 'peer'), []);
  assert.deepEqual(bindingProblems(tree, ['widget tag either'], 'tag_name'), [], 'one signature that places it is enough');
  assert.match(bindingProblems(tree, ['widget tag missing'], 'tag_name')[0]!, /锁定命令树里没有命令“widget tag missing”/);
  assert.match(bindingProblems(tree, ['widget tag set'], 'tagname')[0]!, /没有名叫 tagname 的文本类参数/);
  assert.match(bindingProblems(tree, ['widget tag set'], 'level')[0]!, /没有名叫 level 的文本类参数/, 'a number is judged by its own type');
  assert.match(bindingProblems(tree, ['widget tag twice'], 'tag_name')[0]!, /恰好一个/);
  for (const name of ['mode', 'tag', 'untyped']) assert.equal(bindingProblems(tree, ['widget tag kinds'], name).length, 1, name);
  assert.equal(bindingProblems(tree, ['widget tag set', 'widget tag missing', 'widget tag peer'], 'tag_name').length, 2, 'each command form is told');
  assert.equal(bindingProblems(tree, ['widget tag'], 'tag_name').length, 1, 'a command is its words in full');
});

test('the length rules count bytes, characters and the characters of each part, and stop only above the limit', () => {
  const max = (kind: 'max_bytes' | 'max_characters', limit: number): ValueRule[] => [{ kind, limit, quote: String(limit) }];
  assert.deepEqual(messages('a'.repeat(253), max('max_bytes', 253)), []);
  assert.deepEqual(messages('a'.repeat(254), max('max_bytes', 253)), ['长度 254 个字节，手册写的上限是 253 个字节']);
  assert.equal(messages('中'.repeat(85), max('max_bytes', 253)).length, 1);
  assert.deepEqual(messages('中'.repeat(85), max('max_characters', 253)), []);
  assert.deepEqual(messages('中'.repeat(84), max('max_bytes', 253)), []);
  assert.deepEqual(messages('😀'.repeat(3), max('max_characters', 3)), []);
  assert.deepEqual(messages('😀'.repeat(4), max('max_characters', 3)), ['长度 4 个字符，手册写的上限是 3 个字符']);
  assert.deepEqual(messages('😀'.repeat(64), max('max_bytes', 253)), ['长度 256 个字节，手册写的上限是 253 个字节']);
  const part: ValueRule[] = [{ kind: 'part_max_characters', limit: 63, separator: '.', quote: '63' }];
  assert.deepEqual(messages(`a.${'b'.repeat(63)}.c`, part), []);
  assert.deepEqual(messages(`a.${'b'.repeat(64)}.c`, part), ['按“.”分开后第 2 段有 64 个字符，手册写的每段上限是 63 个字符']);
  assert.deepEqual(messages('', part), []);
  assert.deepEqual(messages('a'.repeat(200), [{ kind: 'part_max_characters', limit: 63, separator: '/', quote: '63' }]).length, 1);
});

test('the character rules: only the listed special characters, forbidden characters, the ends of the value, the wildcard and white space', () => {
  const only: ValueRule[] = [{ kind: 'allowed_specials', characters: ['.', '_', '-'], quote: '._-' }];
  assert.deepEqual(messages('Host-01_a.b', only), []);
  assert.deepEqual(messages('a:b', only), ['含手册没有允许的字符“:”（手册只允许字母、数字和“.”、“_”、“-”）']);
  assert.equal(messages('a:b:c@d', only).length, 1, 'one message, with the distinct characters');
  assert.match(messages('a:b:c@d', only)[0]!, /“:”、“@”/);
  assert.equal(messages('é', only).length, 1);
  assert.equal(messages('主机', only).length, 1);
  assert.match(messages('a b', only)[0]!, /字符空格/);
  assert.deepEqual(messages('', only), []);
  const forbidden: ValueRule[] = [{ kind: 'forbidden_characters', characters: ['$', '#', '|'], quote: '$#|' }];
  assert.deepEqual(messages('a:b', forbidden), [], 'a character the row does not forbid is not refused');
  assert.deepEqual(messages('a$b#c', forbidden), ['含手册写明禁用的字符“$”、“#”']);
  const ends: ValueRule[] = [{ kind: 'not_at_start', characters: ['.', '_'], quote: '._' }, { kind: 'not_at_end', characters: ['.'], quote: '.' }];
  assert.deepEqual(messages('a.b_c', ends), []);
  assert.deepEqual(messages('.ab', ends), ['不能以“.”开头（手册写明）']);
  assert.deepEqual(messages('_ab', ends), ['不能以“_”开头（手册写明）']);
  assert.deepEqual(messages('ab.', ends), ['不能以“.”结尾（手册写明）']);
  assert.deepEqual(messages('ab_', ends), []);
  assert.deepEqual(messages('.', ends).length, 2);
  assert.deepEqual(messages('', ends), []);
  const wildcard: ValueRule[] = [{ kind: 'wildcard', character: '*', quote: '*' }];
  for (const value of ['*', '*.example', '*a', 'a.b']) assert.deepEqual(messages(value, wildcard), [], value);
  for (const value of ['a*', 'a*.b', '**', '*.*']) assert.deepEqual(messages(value, wildcard), ['通配符“*”只能放在取值的最前面'], value);
  const both: ValueRule[] = [...only, ...wildcard];
  assert.deepEqual(messages('*.a', both), []);
  assert.deepEqual(messages('a*', both), ['通配符“*”只能放在取值的最前面']);
  assert.match(messages('*.a?', both)[0]!, /“\?”/);
  const white: ValueRule[] = [{ kind: 'no_whitespace', quote: '空格' }];
  assert.deepEqual(messages('ab', white), []);
  for (const value of ['a b', ' ab', 'a\tb', 'a　b', 'a b']) assert.deepEqual(messages(value, white), ['含空白字符，手册写明取值不能包含空格'], JSON.stringify(value));
});

test('a reserved word is the whole value, compared in any case only when the claim says so', () => {
  const words = (case_insensitive: boolean): ValueRule[] => [{ kind: 'reserved_words', words: ['default', 'All'], case_insensitive, quote: 'default All' }];
  assert.deepEqual(messages('default', words(false)), ['取值“default”是手册写明的保留字']);
  assert.deepEqual(messages('Default', words(false)), []);
  assert.deepEqual(messages('Default', words(true)), ['取值“default”是手册写明的保留字（不分大小写）']);
  assert.deepEqual(messages('ALL', words(true)), ['取值“All”是手册写明的保留字（不分大小写）']);
  assert.deepEqual(messages('all', words(false)), [], 'All is not all when the case counts');
  assert.deepEqual(messages('default1', words(true)), []);
  assert.deepEqual(messages('my-default', words(true)), []);
  assert.deepEqual(messages('', words(true)), []);
});

test('every rule is applied, in the order of the rules, and a value the row allows is told nothing', () => {
  for (const value of ['red/green/blue', '?/green/blue', 'a-b_c/d', 'x']) assert.deepEqual(messages(value), [], value);
  const found = checkValue(RULES, 'A:b/');
  assert.deepEqual(found.map((one) => one.kind), ['allowed_specials', 'not_at_end']);
  assert.deepEqual(found.map((one) => one.rule), [2, 5]);
  assert.deepEqual(checkValue(RULES, 'none').map((one) => one.kind), ['reserved_words']);
  assert.deepEqual(checkValue(RULES, 'a'.repeat(300)).map((one) => one.kind), ['max_bytes', 'part_max_characters']);
});

test('claims that state a kind of rule differently are not used for that kind; the kinds they agree on are', () => {
  const same = effectiveRules([claim(), claim([{ ...RULES[0]!, quote: '另一处写的长度不大于120个字节' }] as ValueRule[])]);
  assert.deepEqual(same.disagreed, []);
  assert.equal(same.rules.filter((one) => one.rule.kind === 'max_bytes').length, 1, 'the same rule twice is one rule');
  const other = claim([{ kind: 'max_bytes', limit: 64, quote: '长度不大于64个字节' }, { kind: 'allowed_specials', characters: ['_', '-', '/'], quote: '特殊字符仅支持“/_-”' }]);
  const split = effectiveRules([claim(), other]);
  assert.deepEqual(split.disagreed, ['max_bytes']);
  assert.ok(!split.rules.some((one) => one.rule.kind === 'max_bytes'));
  assert.ok(split.rules.some((one) => one.rule.kind === 'allowed_specials'), 'the same list in another order is the same list');
  assert.ok(split.rules.some((one) => one.rule.kind === 'no_whitespace'), 'a kind only one claim states is used');
  assert.deepEqual(effectiveRules([]).rules, []);
  const read = (insensitive: boolean) => claim([{ kind: 'reserved_words', words: ['any'], case_insensitive: insensitive, quote: 'any' }]);
  assert.deepEqual(effectiveRules([read(true), read(false)]).disagreed, ['reserved_words']);
});

test('rules of different claims that contradict each other are both left out, as one claim may not state them together', () => {
  const allowed = claim([{ kind: 'allowed_specials', characters: ['/', '_'], quote: '特殊字符仅支持“/_”' }, { kind: 'no_whitespace', quote: '取值不能包含空格' }]);
  const forbidden = claim([{ kind: 'forbidden_characters', characters: ['_'], quote: '“_”不能用' }]);
  const merged = effectiveRules([allowed, forbidden]);
  assert.deepEqual(merged.rules.map((one) => one.rule.kind), ['no_whitespace']);
  assert.deepEqual([...merged.disagreed].sort(), ['allowed_specials', 'forbidden_characters']);
  const wildcard = claim([{ kind: 'wildcard', character: '_', quote: '“_”是通配符' }]);
  assert.deepEqual(effectiveRules([forbidden, wildcard]).rules, []);
  const named = (text: string) => [{ name: 'tag_name', text }];
  assert.deepEqual(valueDomainRefusals('widget tag set', named('a_b'), [allowed, forbidden]), []);
  assert.equal(valueDomainRefusals('widget tag set', named('a b'), [allowed, forbidden]).length, 1);
  assert.deepEqual(effectiveRules([allowed, claim([{ kind: 'forbidden_characters', characters: ['$'], quote: '“$”不能用' }])]).disagreed, []);
});

test('a claim binds to the parameter of its row by name and applies to the text of the command it is about', () => {
  const claims = [claim()];
  const named = (text: string | null) => [{ name: 'tag_name', text }, { name: 'level', text: '60' }];
  const refused = valueDomainRefusals('widget tag set', named('a:b'), claims);
  assert.equal(refused.length, 1);
  assert.equal(refused[0]!.parameter, 'tag_name');
  assert.equal(refused[0]!.value, 'a:b');
  assert.equal(refused[0]!.violations[0]!.kind, 'allowed_specials');
  assert.equal(refused[0]!.violations[0]!.rule_quote, '特殊字符仅支持“/_-”');
  assert.equal(refused[0]!.violations[0]!.claim, claims[0]);
  assert.deepEqual(valueDomainRefusals('widget tag set', named('a/b'), claims), []);
  assert.deepEqual(valueDomainRefusals('widget tag set', named('a:b'), []), []);
  assert.deepEqual(valueDomainRefusals('widget tag other', named('a:b'), claims), []);
  assert.deepEqual(valueDomainRefusals('widget tag', named('a:b'), claims), [], 'a command is its words in full, not a prefix');
  assert.deepEqual(valueDomainRefusals('widget tag set', [{ name: 'tagname', text: 'a:b' }, { name: 'level', text: '60' }], claims), [], 'the name is exact');
  assert.deepEqual(valueDomainRefusals('widget tag set', named(null), claims), [], 'a value the grammar read as a number, an address or a keyword is judged by that type');
  assert.deepEqual(valueDomainRefusals('widget tag set', [{ name: 'tag_name', text: 'a:b' }, { name: 'tag_name', text: 'c:d' }], claims), []);
  const both = [claim(RULES, { commands: ['widget tag enable', 'widget tag disable'] })];
  assert.equal(valueDomainRefusals('widget tag disable', named('a:b'), both).length, 1);
  assert.equal(valueDomainRefusals('widget tag enable', named('a:b'), both).length, 1);
  const split = [claim(), claim([{ kind: 'max_bytes', limit: 8, quote: '长度不大于8个字节' }])];
  assert.deepEqual(valueDomainRefusals('widget tag set', named('a'.repeat(100)), split).flatMap((one) => one.violations.map((violation) => violation.kind)), ['part_max_characters']);
});

test('a check is given claims, and one that is not in the closed shape is left out like an unreadable rule of the product', () => {
  const good = claim();
  const bad = { ...claim(), rules: [{ kind: 'max_bytes', limit: 0, quote: '0' }] };
  assert.deepEqual(readValueDomainClaims([bad, good, 'x', null, { ...good, extra: 1 }]), [good]);
  const outside = claim([{ kind: 'no_whitespace', quote: '取值可以包含空格' }]);
  const invented = claim([{ kind: 'allowed_specials', characters: ['/', '_', '-', ':'], quote: '特殊字符仅支持“/_-”' }]);
  assert.ok('claim' in readValueDomainClaim(outside) && 'claim' in readValueDomainClaim(invented), 'the shape alone is fine: the Hub reads it before it checks the row');
  assert.deepEqual(readValueDomainClaims([outside, invented, good]), [good]);
  assert.deepEqual(readValueDomainClaims(undefined), []);
  assert.deepEqual(readValueDomainClaims({ ...good }), []);
  assert.deepEqual(readValueDomainClaims([]), []);
});
