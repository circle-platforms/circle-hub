import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseSiblings, commandWords, neededShapes, planCommandLines, siblingNote } from './sibling-reference.ts';

const brief = ['# 编写简报 03：合成', '', '## 重组记录点到的命令（2 条）', '', '### alpha zone sign', '# /commands/alpha/zone/sign', '· 引用 tree:…', '### show alpha zone', '', '## 这条用例的计划文件外壳', '### not a command of the record'].join('\n');
const record = { receipt: 'rec:synthetic', record: { sources: { states: [{ state: 'missing_prerequisite', prerequisites: ['alpha on', 'alpha listen 192.0.2.70', 'alpha pool name "p" 1', '由测试环境提供上级服务'] }] } } };
const flat = (...lines: string[]) => ({ slots: { plan: [{ data: { blocks: [], steps: lines.map((line) => ({ object: 'dut0', method: 'cmd_config', args: [line] })) } }] } });
const blocks = (...lines: string[]) => ({ slots: { plan: [{ data: { steps: [], blocks: lines.map((line, index) => ({ id: 'b' + index, kind: 'CONFIG', call: { object: 'dut0', method: 'cmd_config', args: [line] } })) } }] } });

test('command words stop at the first value', () => {
  assert.deepEqual(commandWords('alpha pool name "p" 1'), ['alpha', 'pool', 'name']);
  assert.deepEqual(commandWords('alpha listen 192.0.2.70'), ['alpha', 'listen']);
  assert.deepEqual(commandWords('"quoted first"'), []);
});

test('what a case needs is read from its brief section and from the prerequisites of its record', () => {
  const needed = neededShapes(brief, record);
  for (const shape of ['alpha zone sign', 'show alpha zone', 'alpha on', 'alpha listen', 'alpha pool name']) assert.ok(needed.has(shape), shape);
  assert.equal(needed.size, 5, 'one shape for each command');
  assert.equal([...needed].some((shape) => shape.startsWith('not a')), false, 'a heading of another section is not a command of the record');
  assert.equal([...needed].some((shape) => /由测试环境/.test(shape)), false, 'prose is no command');
  assert.deepEqual([...neededShapes('', null)], []);
});

test('the command texts of a plan are read from flat steps and from blocks', () => {
  assert.deepEqual(planCommandLines(flat('alpha on', 'alpha listen 192.0.2.70')), ['alpha on', 'alpha listen 192.0.2.70']);
  assert.deepEqual(planCommandLines(blocks('alpha on')), ['alpha on']);
  assert.deepEqual(planCommandLines({}), []);
});

test('plans that share at least two command shapes are offered, the device-judged first, at most two', () => {
  const needed = neededShapes(brief, record);
  const siblings = [
    { path: 'cases/00/plan/00.json', lines: planCommandLines(flat('alpha on', 'alpha listen 192.0.2.71', 'alpha pool name "q" 1', 'alpha zone sign "z"')), devicePassed: false },
    { path: 'cases/01/plan/01.json', lines: planCommandLines(blocks('alpha on', 'alpha listen 192.0.2.72')), devicePassed: true },
    { path: 'cases/02/plan/02.json', lines: planCommandLines(flat('beta on', 'alpha on')), devicePassed: true },
    { path: 'cases/04/plan/04.json', lines: planCommandLines(flat('alpha on', 'alpha listen 192.0.2.73', 'alpha pool name "r" 2')), devicePassed: false },
  ];
  const chosen = chooseSiblings(needed, siblings);
  assert.deepEqual(chosen.map((row) => row.path), ['cases/01/plan/01.json', 'cases/00/plan/00.json']);
  assert.equal(chosen[0].devicePassed, true);
  const note = siblingNote(chosen)!;
  assert.match(note, /cases\/01\/plan\/01\.json（相同命令 2 种，已上机通过）、cases\/00\/plan\/00\.json（相同命令 4 种）/);
  assert.match(note, /^供参考：/);
  // Disclosure only: the note states what exists and asks for nothing.
  assert.doesNotMatch(note, /必须|一定|不要|不得|禁止|严禁|务必|应当|照抄|可以照/);
  assert.equal(siblingNote(chooseSiblings(needed, siblings.slice(2, 3))), undefined, 'one shared shape is not enough to name a plan');
});
