import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExecutorDefinition } from './definition.ts';
import { checkReadLine, readOutput } from './read-line.ts';
import { definition } from './testing/definition.ts';
import { probes } from './testing/probes.ts';

const base = definition('http://127.0.0.1:1/');
const PATTERN = '^inspect [a-z0-9 ._:/"\'-]{1,200}$';
const SILENT = Symbol('no read declared');
const executor = (read: unknown = {}, extra: Record<string, unknown> = {}) => ({
  ...base, allowed_tools: [...base.allowed_tools, 'inspect_seat'], probes: { ...probes, command_pattern: PATTERN, ...(read === SILENT ? {} : { read }), ...extra },
});

describe('the declaration', () => {
  it('only opts in and bounds: the per-seat read\'s call, command shape and output place are the ones it uses', () => {
    const parsed = ExecutorDefinition.parse(executor());
    assert.deepEqual(parsed.probes!.read, { max_chars: 16000, max_reads: 1 }, 'the defaults');
    assert.equal(ExecutorDefinition.parse(executor({ max_chars: 64000 })).probes!.read!.max_chars, 64000);
    assert.equal(ExecutorDefinition.parse(executor(SILENT)).probes!.read, undefined, 'an executor that says nothing has not opted in');
    assert.equal(ExecutorDefinition.safeParse({ ...executor(), premises: {} }).success, true, 'no premise is asked for');
  });

  it('refuses a bound outside its range, more than one line per request, and any tool, shape or place of its own', () => {
    for (const read of [{ max_chars: 0 }, { max_chars: 64001 }, { max_chars: 1.5 }, { max_chars: '100' }, { max_reads: 2 }, { max_reads: 0 }, { call: probes.call }, { command_pattern: '^.*$' }, { output: '/other' }, { tool: 'inspect_seat' }, null, true]) {
      assert.equal(ExecutorDefinition.safeParse(executor(read)).success, false, JSON.stringify(read));
    }
  });

  it('rides on the per-seat read, whose rules hold as before: the call binds the command, the seat and the lease once, with an allowed tool', () => {
    const args = probes.call.arguments;
    const without = (key: string) => Object.fromEntries(Object.entries(args).filter(([name]) => name !== key));
    for (const broken of [without('command'), without('seat'), without('ticket'), { ...args, again: { $value: 'command' } }]) {
      assert.equal(ExecutorDefinition.safeParse(executor({}, { call: { ...probes.call, arguments: broken } })).success, false, JSON.stringify(broken));
    }
    assert.equal(ExecutorDefinition.safeParse(executor({}, { call: { ...probes.call, tool: 'not_listed' } })).success, false);
    assert.equal(ExecutorDefinition.safeParse(executor({}, { call: { ...probes.call, tool: base.calls.submit.tool } })).success, false, 'never the submit tool');
    for (const pattern of ['inspect .+', '^inspect .+', 'inspect .+$']) assert.equal(ExecutorDefinition.safeParse(executor({}, { command_pattern: pattern })).success, false, pattern);
  });
});

describe('the line before it is sent', () => {
  it('sends the whole line, its words joined by single spaces, a quoted word kept whole', () => {
    assert.deepEqual(checkReadLine('inspect peers', PATTERN), { ok: true, line: 'inspect peers', words: 2 });
    assert.deepEqual(checkReadLine('  inspect   peers  "a b"  ', PATTERN), { ok: true, line: 'inspect peers "a b"', words: 3 });
  });

  it('refuses a line with any control character, however it is spelled: nothing reaches a device that is not one line of text', () => {
    for (const control of ['\n', '\r', '\t', '\x1b', '\x03', '\x00', '\x7f', '\u0085']) {
      const checked = checkReadLine(`inspect${control}peers`, '^.*$');
      assert.equal(checked.ok, false, JSON.stringify(control));
      if (!checked.ok) assert.match(checked.fact, /控制字符/);
    }
    assert.equal(checkReadLine('inspect "peers\nunits"', '^[^]*$').ok, false, 'also inside quotes, whatever the declared shape allows');
    assert.equal(checkReadLine('inspect peers\ninspect units', '^[^]*$').ok, false, 'two lines are not one');
  });

  it('refuses what is not a line of whole words', () => {
    for (const bad of [undefined, null, 5, ['inspect peers'], '', '   ', 'inspect "peers', 'inspect "peers"x', 'x'.repeat(2001), Array.from({ length: 321 }, () => 'w').join(' ')]) {
      assert.equal(checkReadLine(bad, '^[^]*$').ok, false, String(bad).slice(0, 30));
    }
    assert.equal(checkReadLine(Array.from({ length: 320 }, () => 'w').join(' '), '^[a-z ]{1,2000}$').ok, true, 'the largest line the lexer takes');
  });

  it('holds the whole line to the declared shape, quoting the shape and the line refused', () => {
    const refused = checkReadLine('inspect peers; frobnicate', PATTERN);
    assert.ok(!refused.ok);
    assert.match(refused.fact, /不符合执行器声明的只读命令形状/);
    assert.match(refused.fact, /\^inspect \[a-z0-9/);
    assert.match(refused.fact, /peers; frobnicate/);
    assert.ok(refused.next_action.length > 0);
    assert.equal(checkReadLine('frobnicate peers', PATTERN).ok, false, 'not the declared beginning');
    assert.equal(checkReadLine('inspect', PATTERN).ok, false, 'less than the shape');
    assert.equal(checkReadLine('inspect peers', '^inspect (?:version|interfaces)$').ok, false, 'a shape that names its commands lets only them through');
    assert.equal(checkReadLine('inspect version', '^inspect (?:version|interfaces)$').ok, true);
  });

  it('lets no half line through a shape whose alternatives are not grouped: the match spans the line from its first character to its last', () => {
    const loose = '^inspect version|inspect interfaces$';
    assert.equal(checkReadLine('inspect version', loose).ok, true);
    assert.equal(checkReadLine('inspect interfaces', loose).ok, true);
    assert.equal(checkReadLine('inspect version now', loose).ok, false, 'the first alternative is not open at its end');
    assert.equal(checkReadLine('frobnicate inspect interfaces', loose).ok, false, 'the second alternative is not open at its beginning');
  });

  it('decides by structure alone: the words of a line are never compared with a list', () => {
    for (const word of ['frobnicate', 'wipe-all', 'halt-now', 'zorp', 'quux']) assert.ok(checkReadLine(`${word} widget`, '^[a-z-]+ widget$').ok, word);
  });
});

describe('the answer', () => {
  it('takes the text at the declared place as received; nothing, null or only blanks there is no output', () => {
    const text = 'name      state\n\nwidget-1  up\n';
    assert.deepEqual(readOutput({ output: text }, '/output'), { ok: true, text });
    assert.deepEqual(readOutput({ reply: { text } }, '/reply/text'), { ok: true, text });
    for (const none of [{}, { output: null }, { output: '' }, { output: ' \n ' }, null, 'text']) assert.deepEqual(readOutput(none, '/output'), { ok: true, text: null }, JSON.stringify(none));
  });

  it('refuses what is not text rather than guessing', () => {
    for (const odd of [{ output: ['a'] }, { output: 5 }, { output: { text: 'a' } }, { output: true }]) assert.equal(readOutput(odd, '/output').ok, false, JSON.stringify(odd));
  });

  it('never looks inside the words: whatever the text says, it is the text', () => {
    for (const text of ['Command was refused', '% Unknown token', '^', 'no entries', 'ok: false']) assert.deepEqual(readOutput({ output: text }, '/output'), { ok: true, text });
  });
});
