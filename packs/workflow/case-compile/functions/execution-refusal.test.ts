import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionRefusals, longNames } from './delivery.ts';

const MARKERS = ['Synthetic refusal of the command', 'Synthetic transfer failure from'];
const SESSION = [
  'seat(config)#widget on',
  'seat(config)#widget name "a_b:c" 60',
  '',
  'Widget name format error.',
  'Synthetic refusal of the command',
  '',
  'seat(config)#widget pool "a_b:c" "p1"',
  'The widget "a_b:c" does not exist.',
  'Synthetic refusal of the command',
  'seat(config)#exit',
  'seat#show widget name',
  'seat#',
].join('\n');

test('a command whose reply carries a declared execution-failure line is listed with its prompt and the device’s reason', () => {
  assert.deepEqual(executionRefusals(SESSION, MARKERS), [
    { command: 'widget name "a_b:c" 60', prompt: 'seat(config)#', reply: ['Widget name format error.', 'Synthetic refusal of the command'] },
    { command: 'widget pool "a_b:c" "p1"', prompt: 'seat(config)#', reply: ['The widget "a_b:c" does not exist.', 'Synthetic refusal of the command'] },
  ]);
});

test('an accepted command, a warning and a reply without a declared line list nothing; without declared lines nothing is read', () => {
  assert.deepEqual(executionRefusals('seat(config)#widget on\nWarning: widgets are slow.\nseat(config)#widget off\nseat(config)#\n', MARKERS), []);
  assert.deepEqual(executionRefusals(SESSION, []), [], 'the lines are the runner contract’s: none declared, none judged');
  assert.deepEqual(executionRefusals('seat#widget show\nSynthetic refusal of the command\nseat#widget list\nall widgets\nseat#\n', MARKERS).map((one) => one.command), ['widget show']);
  assert.deepEqual(executionRefusals('Synthetic refusal of the command\nseat#\n', MARKERS), []);
});

test('a long command the terminal redrew is given up to its first control character and marked as cut; the reply keeps its last lines', () => {
  const redrawn = 'seat(config)#widget name "aaaaaaaaaaaaaaaaaaaa\b\b\b\b$aaaaaaaa" 60';
  const many = Array.from({ length: 9 }, (_, at) => `reason line ${at + 1}`);
  const refusals = executionRefusals([redrawn, ...many, 'Synthetic transfer failure from the peer', 'seat(config)#'].join('\r\n'), MARKERS);
  assert.equal(refusals.length, 1);
  assert.equal(refusals[0].command, 'widget name "aaaaaaaaaaaaaaaaaaaa');
  assert.equal(refusals[0].echo_cut, true);
  assert.deepEqual(refusals[0].reply, ['reason line 5', 'reason line 6', 'reason line 7', 'reason line 8', 'reason line 9', 'Synthetic transfer failure from the peer']);
  assert.equal(executionRefusals(SESSION + '\n' + SESSION, MARKERS).length, 2);
});

test('generic Error, Failed and percent Invalid words do not declare an execution failure', () => {
  const session = ['seat#widget show', 'Error: synthetic business label', 'Failed to synthetic observation', '% Invalid synthetic label', 'seat#'].join('\n');
  assert.deepEqual(executionRefusals(session, MARKERS), []);
  assert.deepEqual(executionRefusals(session, ['Error: synthetic business label']), [{command:'widget show',prompt:'seat#',reply:['Error: synthetic business label']}]);
});

// A long name is measured in the text the device printed, so that nobody has to count it by eye or take it from the plan.
const NAME_A = 'a'.repeat(30) + 'MIDDLE' + 'z'.repeat(34), NAME_B = 'n'.repeat(200);

test('a long name in the command or in a reply line is listed with its length, once for each place it is in, and nothing else is added', () => {
  assert.deepEqual(longNames(`widget host ${NAME_A}`), [{ chars: 70, in: 'command', head: 'a'.repeat(16), tail: 'z'.repeat(16) }]);
  assert.deepEqual(longNames('widget host a-short-name', ['Error: no such host']), [], 'no long name, nothing listed');
  assert.deepEqual(longNames(`copy ${NAME_A} ${NAME_A} "${NAME_B}"`, [`Error: ${NAME_A} is refused`, `seen ${NAME_A} and ${NAME_A}`, `and ${NAME_B}.`]), [
    { chars: 70, in: 'command', head: 'a'.repeat(16), tail: 'z'.repeat(16) },
    { chars: 200, in: 'command', head: 'n'.repeat(16), tail: 'n'.repeat(16) },
    { chars: 70, in: 'reply', head: 'a'.repeat(16), tail: 'z'.repeat(16) },
    { chars: 200, in: 'reply', head: 'n'.repeat(16), tail: 'n'.repeat(16), final_dot: true },
  ], 'the same name twice in a place is one, in the command and in a reply is two; a full stop after the name is not counted in it, and the entry says one was there');
  assert.equal(longNames('x'.repeat(63)).length, 0); assert.equal(longNames('x'.repeat(64)).length, 1, 'sixty-four is where a token is long');
});

test('the refused command and the lines the device replied with carry the names they hold, counted before the entry clips a long line', () => {
  const echoLine = `Error: bad ${'k'.repeat(300)} and ${NAME_B} follows`;
  const session = ['seat#widget host ' + NAME_A, echoLine, 'Synthetic refusal of the command', 'seat#widget ok', 'ok', 'seat#'].join('\n');
  const [refusal] = executionRefusals(session, MARKERS);
  assert.equal(refusal!.reply[0]!.length, 401, 'the entry keeps a clipped copy of the long line');
  assert.deepEqual(refusal!.names, [
    { chars: 70, in: 'command', head: 'a'.repeat(16), tail: 'z'.repeat(16) },
    { chars: 300, in: 'reply', head: 'k'.repeat(16), tail: 'k'.repeat(16) },
    { chars: 200, in: 'reply', head: 'n'.repeat(16), tail: 'n'.repeat(16) },
  ], 'but the names are counted in the whole line');
  assert.deepEqual(Object.keys(refusal!), ['command', 'prompt', 'reply', 'names']);
  assert.equal('names' in executionRefusals(SESSION, MARKERS)[0]!, false, 'an entry without a long name has no names');
});

test('what a sentence puts around a name is not counted in it, at the lengths where the number matters', () => {
  const name = 'n'.repeat(200), entry = { chars: 200, in: 'command', head: 'n'.repeat(16), tail: 'n'.repeat(16) } as const;
  for (const around of ['"X"', "'X'", '"X".', '(X)', '[X]', '{X}', '<X>', 'X,', 'X;', 'X:', 'X!', 'X?', '(X),', '[X]:', 'see X: refused', ':X', 'X?!']) {
    assert.deepEqual(longNames(`widget host ${around.replace('X', name)}`), [entry], around);
  }
  for (const around of ['X.', '(X).', 'X.)', 'X...', '(X.)', 'X.,']) {
    assert.deepEqual(longNames(`widget host ${around.replace('X', name)}`), [{ ...entry, final_dot: true }], around);
  }
  // 253 characters is the longest a domain name may be, and a dot after it is how DNS tools print an absolute name.
  const domain = ['a'.repeat(63), 'b'.repeat(63), 'c'.repeat(63), 'd'.repeat(61)].join('.');
  assert.equal(domain.length, 253);
  const full = { chars: 253, in: 'command', head: 'a'.repeat(16), tail: 'd'.repeat(16) } as const;
  assert.deepEqual(longNames(`widget host ${domain}`), [full]);
  assert.deepEqual(longNames(`widget host ${domain}.`), [{ ...full, final_dot: true }], 'the dot is not in the 253, and it is said');
  assert.deepEqual(longNames('widget host a', [`${domain} is refused`, `refused: ${domain}.`]), [{ ...full, in: 'reply', final_dot: true }], 'one entry for the name in the reply, which says a dot followed it once');
  // The length that makes a name long is the name's own.
  assert.deepEqual(longNames(`widget host ${'x'.repeat(63)}.`), [], 'a name of 63 characters and a dot is not long');
  assert.deepEqual(longNames(`widget host ${'x'.repeat(64)}.`), [{ chars: 64, in: 'command', head: 'x'.repeat(16), tail: 'x'.repeat(16), final_dot: true }]);
  assert.deepEqual(longNames(`widget host (${'x'.repeat(62)})`), [], 'brackets do not make a name long');
  // Dots and punctuation inside a name stay in it.
  const inner = `${'a'.repeat(40)}.b-c_d:e@f/${'z'.repeat(30)}`;
  assert.deepEqual(longNames(`widget host ${inner};`), [{ chars: inner.length, in: 'command', head: inner.slice(0, 16), tail: inner.slice(-16) }]);
});
