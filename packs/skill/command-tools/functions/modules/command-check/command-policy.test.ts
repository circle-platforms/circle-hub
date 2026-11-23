import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alternativeLines, caseProfile, commandCounts, inverseLines, readCommandPolicy, volumeConflicts, volumeOrder, type CommandPolicy, type ParsedCommand } from './command-policy.ts';

const base = { schema: 'command-policy@1', read_only: ['/commands/show'], inverse_rules: [] };
const declared = {
  ...base,
  persistence_channels: [
    { id: 'disk', commands: [{ prefix: '/commands/demo/store' }], source: 'Demo manual 4.2: a stored file stays on the unit after the runner cleans up' },
    { id: 'peer', commands: [{ prefix: '/commands/demo/mirror/push' }, { prefix: '/commands/demo/link/rank', with_parameter: 3 }], source: 'Demo manual 7.1: a push writes the peer\'s saved configuration' },
  ],
  forbidden_combinations: [
    { id: 'boot_reload', side_a: [{ prefix: '/commands/demo/mirror/boot/on' }], side_b: [{ prefix: '/commands/demo/reload' }, { prefix: '/commands/demo/mirror/push' }], source: 'Demo manual 7.3: switch the boot sync off before a reload or a push' },
  ],
};
const policy = readCommandPolicy(declared) as CommandPolicy;
const command = (path: string, positions: number[] = [], line?: string): ParsedCommand => ({ path, parameters: positions.map((position) => ({ position })), ...(line === undefined ? {} : { line }) });

test('a policy with channels and combinations reads, and a malformed declaration refuses the whole policy', () => {
  assert.ok(policy);
  assert.deepEqual(readCommandPolicy(base), base, 'a policy without the declarations is as before');
  const mutations: Array<[string, (value: any) => void]> = [
    ['an unknown key', (v) => { v.persistence_channel = []; }],
    ['a row with an unknown key', (v) => { v.persistence_channels[0].scope = 'volume'; }],
    ['a duplicate channel id', (v) => { v.persistence_channels[1].id = 'disk'; }],
    ['a duplicate combination id', (v) => { v.forbidden_combinations.push({ ...v.forbidden_combinations[0] }); }],
    ['an id that is not lowercase words', (v) => { v.persistence_channels[0].id = 'Disk'; }],
    ['a prefix outside the command tree', (v) => { v.persistence_channels[0].commands[0].prefix = '/knowledge/demo'; }],
    ['a prefix with an empty segment', (v) => { v.persistence_channels[0].commands[0].prefix = '/commands//store'; }],
    ['a bare string for a command', (v) => { v.persistence_channels[0].commands = ['/commands/demo/store']; }],
    ['no command in a channel', (v) => { v.persistence_channels[0].commands = []; }],
    ['an empty side', (v) => { v.forbidden_combinations[0].side_b = []; }],
    ['a missing side', (v) => { delete v.forbidden_combinations[0].side_a; }],
    ['a parameter position below zero', (v) => { v.persistence_channels[1].commands[1].with_parameter = -1; }],
    ['a parameter position that is not a whole number', (v) => { v.persistence_channels[1].commands[1].with_parameter = 1.5; }],
    ['a parameter position that is text', (v) => { v.persistence_channels[1].commands[1].with_parameter = '3'; }],
    ['no source', (v) => { delete v.persistence_channels[0].source; }],
    ['a source on two lines', (v) => { v.forbidden_combinations[0].source = 'one\ntwo'; }],
    ['a source that is too long', (v) => { v.persistence_channels[0].source = 'x'.repeat(401); }],
    ['more than sixteen channels', (v) => { v.persistence_channels = Array.from({ length: 17 }, (_, k) => ({ ...v.persistence_channels[0], id: `c${k}` })); }],
    ['channels that are not a list', (v) => { v.persistence_channels = {}; }],
  ];
  for (const [name, mutate] of mutations) {
    const value = structuredClone(declared); mutate(value);
    assert.equal(readCommandPolicy(value), null, name);
  }
});

test('a command counts by whole path segments, and by a supplied parameter only when the declaration names one', () => {
  const store = { prefix: '/commands/demo/store' };
  assert.ok(commandCounts(command('/commands/demo/store'), store), 'the prefix itself');
  assert.ok(commandCounts(command('/commands/demo/store/file'), store), 'a command under the prefix');
  assert.ok(!commandCounts(command('/commands/demo/storefront'), store), 'a longer word is not the same segment');
  assert.ok(!commandCounts(command('/commands/demo'), store), 'the parent of the prefix is not under it');
  assert.ok(!commandCounts(command('/commands/other/store'), store));
  const rank = { prefix: '/commands/demo/link/rank', with_parameter: 3 };
  assert.ok(commandCounts(command('/commands/demo/link/rank', [0, 1, 2, 3]), rank), 'written with the fourth parameter');
  assert.ok(!commandCounts(command('/commands/demo/link/rank', [0, 1, 2]), rank), 'the optional parameter was not given');
  assert.ok(!commandCounts(command('/commands/demo/link/rank', [0, 1, 2, 4]), rank), 'another position is another parameter');
});

test('a case belongs to the channels and combination sides its commands name, with the commands that put it there', () => {
  const saver = caseProfile(policy, [command('/commands/demo/store/file', [0], 'demo store file a'), command('/commands/demo/show')]);
  assert.deepEqual(saver.channels, [{ id: 'disk', source: declared.persistence_channels[0].source, commands: ['demo store file a'] }]);
  assert.deepEqual(saver.sides, []);
  const pusher = caseProfile(policy, [command('/commands/demo/mirror/push', [0], 'demo mirror push b'), command('/commands/demo/mirror/push', [0], 'demo mirror push c'), command('/commands/demo/mirror/push', [0], 'demo mirror push b')]);
  assert.deepEqual(pusher.channels.map((row) => [row.id, row.commands]), [['peer', ['demo mirror push b', 'demo mirror push c']]]);
  assert.deepEqual(pusher.sides.map((row) => [row.combination, row.side]), [['boot_reload', 'b']]);
  const many = caseProfile(policy, Array.from({ length: 7 }, (_, k) => command('/commands/demo/store/file', [0], `demo store file f${k}`)));
  assert.deepEqual(many.channels[0].commands, ['f0', 'f1', 'f2', 'f3', 'f4'].map((name) => `demo store file ${name}`), 'only the first few commands are kept to tell people');
  const ranker = (positions: number[]) => caseProfile(policy, [command('/commands/demo/link/rank', positions)]);
  assert.deepEqual(ranker([0, 1, 2, 3]).channels.map((row) => row.id), ['peer']);
  assert.deepEqual(ranker([0, 1, 2]).channels, [], 'a rank that names no peer writes nothing there');
  assert.deepEqual(caseProfile(policy, [command('/commands/demo/mirror/boot/off')]), { channels: [], sides: [] }, 'turning the boot sync off is neither side');
  assert.deepEqual(caseProfile(policy, [command('/commands/demo/mirror/boot/on')]).sides.map((row) => [row.combination, row.side, row.commands]), [['boot_reload', 'a', ['/commands/demo/mirror/boot/on']]], 'without a line the path names the command');
  for (const none of [null, readCommandPolicy(base)]) assert.deepEqual(caseProfile(none, [command('/commands/demo/store')]), { channels: [], sides: [] });
});

test('a volume puts the cases with a channel command last and leaves every other order as it was', () => {
  const cases = ['one', 'two', 'three', 'four', 'five'].map((id) => ({ id, profile: caseProfile(policy, id === 'two' || id === 'four' ? [command('/commands/demo/store')] : [command('/commands/demo/show')]) }));
  const { ordered, moved } = volumeOrder(cases);
  assert.deepEqual(ordered.map((row) => row.id), ['one', 'three', 'five', 'two', 'four']);
  assert.deepEqual(moved.map((row) => row.id), ['two', 'four']);
  assert.deepEqual(volumeOrder(volumeOrder(cases).ordered).ordered.map((row) => row.id), ['one', 'three', 'five', 'two', 'four'], 'ordering an ordered volume changes nothing');
  assert.deepEqual(volumeOrder(cases.filter((row) => row.id !== 'two' && row.id !== 'four')).moved, [], 'a volume without a channel case stays as it is');
  const onlyChannels = cases.filter((row) => row.id === 'two' || row.id === 'four');
  assert.deepEqual(volumeOrder(onlyChannels).ordered.map((row) => row.id), ['two', 'four'], 'a volume of channel cases only keeps its order');
  assert.deepEqual(volumeOrder(onlyChannels).moved, [], 'and nothing in it runs after anything else');
  assert.deepEqual(volumeOrder(onlyChannels.slice(0, 1)).moved, [], 'a volume of one case has nothing before it');
});

test('a volume holds a forbidden combination when both sides are in it, in two cases or in one, and one side alone is none', () => {
  const profile = (...commands: ParsedCommand[]) => caseProfile(policy, commands);
  const boot = command('/commands/demo/mirror/boot/on'), reload = command('/commands/demo/reload'), show = command('/commands/demo/show');
  const split = volumeConflicts([{ id: 'a1', profile: profile(boot) }, { id: 'b1', profile: profile(show) }, { id: 'b2', profile: profile(reload) }]);
  assert.deepEqual(split, [{ combination: 'boot_reload', source: declared.forbidden_combinations[0].source, side_a: ['a1'], side_b: ['b2'] }]);
  const same = volumeConflicts([{ id: 'both', profile: profile(boot, reload) }]);
  assert.deepEqual(same.map((row) => [row.side_a, row.side_b]), [[['both'], ['both']]], 'one case holding both sides is the same violation');
  assert.deepEqual(volumeConflicts([{ id: 'a1', profile: profile(boot) }, { id: 'a2', profile: profile(boot) }]), [], 'side A alone');
  assert.deepEqual(volumeConflicts([{ id: 'b2', profile: profile(reload) }]), [], 'side B alone');
  assert.deepEqual(volumeConflicts([{ id: 'a1', profile: profile(command('/commands/demo/mirror/boot/off')) }, { id: 'b2', profile: profile(reload) }]), [], 'the boot sync switched off is not side A');
  const many = volumeConflicts([{ id: 'a1', profile: profile(boot) }, { id: 'a2', profile: profile(boot) }, { id: 'b1', profile: profile(reload) }, { id: 'b2', profile: profile(command('/commands/demo/mirror/push', [0])) }]);
  assert.deepEqual(many.map((row) => [row.side_a, row.side_b]), [[['a1', 'a2'], ['b1', 'b2']]]);
});

const pairs = readCommandPolicy({
  schema: 'command-policy@1', read_only: ['/commands/show'],
  inverse_rules: [{ source_prefix: '/commands/no', inverse_prefix: '/commands' }, { source_prefix: '/commands', inverse_prefix: '/commands/no' }],
  inverse_alternatives: [['on', 'off'], ['enable', 'disable']],
}) as CommandPolicy;

test('a declared pair of alternative values asks for the partner\'s path, cut after the swapped word', () => {
  assert.deepEqual(alternativeLines(pairs, ['demo switch on']), ['demo switch off']);
  assert.deepEqual(alternativeLines(pairs, ['demo switch off']), ['demo switch on']);
  assert.deepEqual(alternativeLines(pairs, ['demo relay enable 5 "two words"']), ['demo relay disable'], 'what follows the swapped word is not part of the path');
  assert.deepEqual(alternativeLines(pairs, ['demo mode on level']), ['demo mode off'], 'an enum argument is asked for too: the same path, so it adds nothing to a walk');
  assert.deepEqual(alternativeLines(pairs, ['demo switch on 1', 'demo switch on 2', 'demo relay enable']).sort(), ['demo relay disable', 'demo switch off'], 'one line for one path');
  assert.deepEqual(alternativeLines(pairs, ['a on b off']).sort(), ['a off', 'a on b on'], 'each member of a pair in a line is swapped alone');
});

test('a partner the plan already walks to, a quoted word and a line the tokenizer refuses ask for nothing', () => {
  assert.deepEqual(alternativeLines(pairs, ['demo switch on', 'demo switch off']), [], 'the plan sends both');
  assert.deepEqual(alternativeLines(pairs, ['demo switch on', 'demo switch off 5']), [], 'the plan walks to the partner already');
  assert.deepEqual(alternativeLines(pairs, ['demo switch on', 'demo switch "off"']), ['demo switch off'], 'a quoted word ends a walk, so it does not walk to the partner');
  assert.deepEqual(alternativeLines(pairs, ['demo "x" on', 'demo "on"', 'demo \'on\'']), [], 'the walk stops at a quoted word');
  assert.deepEqual(alternativeLines(pairs, ['demo switch "unterminated on']), []);
  assert.deepEqual(alternativeLines(pairs, ['demo switch']), []);
  assert.deepEqual(alternativeLines(null, ['demo switch on']), []);
  const none = readCommandPolicy({ schema: 'command-policy@1', read_only: [], inverse_rules: [] }) as CommandPolicy;
  assert.deepEqual(alternativeLines(none, ['demo switch on']), [], 'a policy without pairs asks for nothing');
  const odd = readCommandPolicy({ schema: 'command-policy@1', read_only: [], inverse_rules: [], inverse_alternatives: [['up', 'down now']] }) as CommandPolicy;
  assert.deepEqual(alternativeLines(odd, ['demo link up']), []);
  assert.deepEqual(alternativeLines(odd, ['demo link down']), []);
  assert.deepEqual(alternativeLines(pairs, Array.from({ length: 129 }, (_, index) => `s${index} on`)), []);
});

test('the lines of declared pairs come first and are never dropped, the lines of the prefix rules are all of them or none', () => {
  assert.deepEqual(inverseLines(pairs, ['demo switch on', 'demo pool add one 10']), ['demo switch off', 'no demo switch on', 'no demo pool add one 10']);
  assert.deepEqual(inverseLines(pairs, ['demo switch on', 'no demo switch on']), ['demo switch off', 'no demo switch off'], 'a rule line the plan sends is not asked twice');
  assert.deepEqual(inverseLines(null, ['demo switch on']), []);
  const plan = Array.from({ length: 62 }, (_, index) => `demo pool add n${index} ${index}`);
  const fits = inverseLines(pairs, [...plan, 'demo switch on']);
  assert.equal(fits.length, 1 + 63);
  assert.equal(fits[0], 'demo switch off', 'the pair line comes first');
  const over = inverseLines(pairs, [...plan, 'demo pool add last 1', 'demo switch on']);
  assert.deepEqual(over, ['demo switch off']);
  const switches = Array.from({ length: 128 }, (_, index) => `s${index} on`);
  assert.deepEqual(inverseLines(pairs, switches), switches.map((line) => line.replace(' on', ' off')));
  assert.deepEqual(inverseLines(pairs, [...switches, 's128 on']), []);
});
