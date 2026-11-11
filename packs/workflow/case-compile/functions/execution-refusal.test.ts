// The commands a device refused to execute, read off a session (functions/delivery.ts executionRefusals). The reference keeps
// one authority for a device's CLI errors (tools/device/device_errors.py: the caret, and the device's one verdict line for any
// command that fails to execute) and hands the lines of the last run that carry one to the next writer, with the directive
// that the fault is in the case's own command sequence (compile_engine/briefs.py execution_failures). In run 23 one case sent
// the same host name three dispatches running; the device answered each time with its reason and its verdict line, and each
// time the answer was read as a possible product defect. Synthetic sessions and marker lines only.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executionRefusals } from './delivery.ts';

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
  // The line belongs to the reply of the command above it, never to a later command.
  assert.deepEqual(executionRefusals('seat#widget show\nSynthetic refusal of the command\nseat#widget list\nall widgets\nseat#\n', MARKERS).map((one) => one.command), ['widget show']);
  // Device words before any command belong to no command.
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
  // The same refusal met twice is listed once.
  assert.equal(executionRefusals(SESSION + '\n' + SESSION, MARKERS).length, 2);
});
