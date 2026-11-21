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
