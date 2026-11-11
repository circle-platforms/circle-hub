import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ExecutorDefinition } from './definition.ts';
import { HELP_TEXT_CHARS, capText, checkLine, readAnswer, type HelpSpec } from './help.ts';
import { definition } from './testing/definition.ts';
import { probes } from './testing/probes.ts';

const base = definition('http://127.0.0.1:1/');
const HELP = {
  line_pattern: '^[A-Za-z0-9 ._:/"\'-]{1,500}$',
  call: { tool: 'ask_position', arguments: { seat: { $value: 'seat_index' }, line: { $value: 'line' }, ticket: { $value: 'lease_id' } } },
  text: '/help', caret_only: '/caret', entered: '/entered', cleared: '/cleared',
};
const executor = (help: Record<string, unknown> = HELP, extra: Record<string, unknown> = {}) => ({
  ...base, allowed_tools: [...base.allowed_tools, 'inspect_seat', 'ask_position'], probes: { ...probes, help }, ...extra,
});
const spec = (help: Record<string, unknown> = {}): HelpSpec => {
  const parsed = ExecutorDefinition.parse(executor({ ...HELP, ...help }));
  return parsed.probes!.help!;
};

describe('the declaration', () => {
  it('accepts a help call that binds the line, the seat and the lease once, with defaults for the bound', () => {
    assert.equal(ExecutorDefinition.safeParse(executor()).success, true);
    assert.equal(spec().max_positions, 12);
    assert.equal(spec().modes, undefined);
    assert.equal(ExecutorDefinition.safeParse({ ...executor(), premises: { read_only: { version: '1', evidence: ['src:' + 'a'.repeat(64)] } } }).success, true, 'the premise has the shape of the others');
    assert.equal(ExecutorDefinition.safeParse({ ...executor(), premises: { read_only: { version: '1', evidence: [] } } }).success, false);
  });

  it('refuses a help call that does not bind exactly the line, the seat and the lease', () => {
    const args = HELP.call.arguments;
    const without = (key: string) => Object.fromEntries(Object.entries(args).filter(([name]) => name !== key));
    for (const broken of [without('line'), without('seat'), without('ticket'), { ...args, again: { $value: 'line' } }, { ...args, ahead: { $value: 'payload_base64' } }]) {
      assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: { ...HELP.call, arguments: broken } })).success, false, JSON.stringify(broken));
    }
  });

  it('binds the level only when levels are declared, once, and each level once', () => {
    const withLevel = { ...HELP.call, arguments: { ...HELP.call.arguments, level: { $value: 'mode' } } };
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: withLevel, modes: ['level-a', 'level-b'] })).success, true);
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: withLevel })).success, false, 'a level bound but none declared');
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, modes: ['level-a'] })).success, false, 'levels declared but none bound');
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: withLevel, modes: ['level-a', 'level-a'] })).success, false);
  });

  it('keeps the help tool apart from the version probe, the submit tool and the allowed list, and anchors the pattern', () => {
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: { ...HELP.call, tool: probes.call.tool } })).success, false, 'the version probe tool is not the help tool');
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: { ...HELP.call, tool: base.calls.submit.tool } })).success, false);
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, call: { ...HELP.call, tool: 'not_listed' } })).success, false);
    for (const pattern of ['[a-z ]+', '^[a-z ]+', '[a-z ]+$', '^(unclosed$']) assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, line_pattern: pattern })).success, false, pattern);
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, max_positions: 0 })).success, false);
    assert.equal(ExecutorDefinition.safeParse(executor({ ...HELP, entered: undefined })).success, false, 'the two safety fields are required');
  });
});

describe('the line before it is sent', () => {
  it('asks the whole line first and each shorter prefix after it, whole words only, saying which word follows', () => {
    const checked = checkLine('widget set demo 1', undefined, spec());
    assert.ok(checked.ok);
    assert.equal(checked.asked.line, 'widget set demo 1');
    assert.equal(checked.asked.words, 4);
    assert.deepEqual(checked.asked.prefixes, [
      { text: 'widget set demo 1', words: 4, next_word: null },
      { text: 'widget set demo', words: 3, next_word: '1' },
      { text: 'widget set', words: 2, next_word: 'demo' },
      { text: 'widget', words: 1, next_word: 'set' },
    ]);
  });

  it('joins the words by single spaces and keeps a quoted word whole, quotes included', () => {
    const checked = checkLine('widget   set  demo "a b"', undefined, spec());
    assert.ok(checked.ok);
    assert.equal(checked.asked.line, 'widget set demo "a b"');
    assert.deepEqual(checked.asked.prefixes.map((p) => [p.words, p.next_word]), [[4, null], [3, '"a b"'], [2, 'demo'], [1, 'set']]);
  });

  it('asks no more positions than the executor declares, longest first', () => {
    const checked = checkLine('a b c d e', undefined, spec({ max_positions: 2 }));
    assert.ok(checked.ok);
    assert.deepEqual(checked.asked.prefixes.map((p) => p.text), ['a b c d e', 'a b c d']);
    assert.equal(checked.asked.words, 5);
  });

  it('refuses a line with any control character, however it is spelled: nothing reaches a terminal that is not text', () => {
    for (const control of ['\n', '\r', '\t', '\x1b', '\x03', '\x00', '\x7f', '\u0085']) {
      const checked = checkLine(`widget${control}set`, undefined, spec());
      assert.equal(checked.ok, false, JSON.stringify(control));
      if (!checked.ok) assert.match(checked.fact, /控制字符/);
    }
    assert.equal(checkLine('widget "set\ndemo"', undefined, spec()).ok, false, 'also inside quotes');
  });

  it('refuses what is not a line of whole words', () => {
    for (const bad of [undefined, null, 5, '', '   ', 'widget "set', 'widget "set"demo', 'x'.repeat(2001), Array.from({ length: 321 }, () => 'w').join(' ')]) {
      assert.equal(checkLine(bad, undefined, spec()).ok, false, String(bad).slice(0, 30));
    }
    assert.equal(checkLine(Array.from({ length: 320 }, () => 'w').join(' '), undefined, spec({ line_pattern: '^[a-z ]{1,2000}$', max_positions: 3 })).ok, true, 'the largest line the lexer takes');
  });

  it('holds the line and every prefix to the declared pattern, quoting the pattern and the text refused', () => {
    const refused = checkLine('widget set demo; frobnicate', undefined, spec());
    assert.ok(!refused.ok);
    assert.match(refused.fact, /\^\[A-Za-z0-9/);
    assert.match(refused.fact, /demo;/);
    assert.equal(checkLine('widget set demo ?', undefined, spec()).ok, false, 'the question mark is the target\'s to add, this pattern leaves it out');
    // A pattern that a short prefix does not fit refuses the whole line, although the line itself fits it.
    const twoWords = spec({ line_pattern: '^\\S+ \\S+.*$' });
    const checked = checkLine('widget set demo', undefined, twoWords);
    assert.ok(!checked.ok);
    assert.match(checked.fact, /"widget"/);
    assert.equal(checkLine('widget set demo', undefined, spec({ line_pattern: '^\\S+ \\S+.*$', max_positions: 2 })).ok, true, 'only the prefixes that will be sent are held to it');
  });

  it('takes a level only from the declared set, and none when the executor declares none', () => {
    const levelled = spec({ call: { ...HELP.call, arguments: { ...HELP.call.arguments, level: { $value: 'mode' } } }, modes: ['level-a', 'level-b'] });
    assert.ok(checkLine('widget', 'level-b', levelled).ok);
    const missing = checkLine('widget', undefined, levelled);
    assert.ok(!missing.ok);
    assert.match(missing.fact, /level-a、level-b/);
    assert.equal(checkLine('widget', 'level-c', levelled).ok, false);
    assert.equal(checkLine('widget', 'level-a', spec()).ok, false);
  });

  it('decides by structure alone: the words of a line are never compared with a list', () => {
    for (const word of ['frobnicate', 'wipe-all', 'halt-now', 'ZORP', 'quux']) assert.ok(checkLine(`${word} widget`, undefined, spec()).ok, word);
  });
});

describe('the answer', () => {
  it('reads the description, the caret and the two safety fields at the declared places and keeps the text as received', () => {
    const text = 'name   the widget name\n\n  <1-9>   a number\n';
    assert.deepEqual(readAnswer(spec(), { help: text, caret: false, entered: false, cleared: true }), { ok: true, text, caret_only: false });
    assert.deepEqual(readAnswer(spec(), { help: '', caret: true, entered: false, cleared: true }), { ok: true, text: null, caret_only: true });
    assert.deepEqual(readAnswer(spec(), { entered: false, cleared: true }), { ok: true, text: null, caret_only: null }, 'nothing at the declared places is no description');
    assert.deepEqual(readAnswer(spec(), { help: null, entered: false, cleared: true }), { ok: true, text: null, caret_only: null });
    assert.deepEqual(readAnswer(spec(), { help: ' \n ', entered: false, cleared: true }), { ok: true, text: null, caret_only: null });
  });

  it('does not show an answer that does not say, as plain true and false, that nothing was entered and the line was cleared', () => {
    for (const unsafe of [{ entered: true, cleared: true }, { entered: false, cleared: false }, { entered: false }, { cleared: true }, {}, { entered: 'false', cleared: 'true' }, { entered: 0, cleared: 1 }, { entered: null, cleared: true }]) {
      const read = readAnswer(spec(), { help: 'looks fine', ...unsafe });
      assert.equal(read.ok, false, JSON.stringify(unsafe));
    }
  });

  it('refuses fields of the wrong kind rather than guessing', () => {
    assert.equal(readAnswer(spec(), { help: ['a'], entered: false, cleared: true }).ok, false);
    assert.equal(readAnswer(spec(), { help: 'a', caret: 'yes', entered: false, cleared: true }).ok, false);
    assert.deepEqual(readAnswer(spec({ caret_only: undefined }), { help: 'a', caret: true, entered: false, cleared: true }), { ok: true, text: 'a', caret_only: null }, 'no caret place declared');
  });

  it('never looks inside the words: whatever the text says, it is the text', () => {
    for (const text of ['Command was refused', '% Unknown token', '^', 'Enter the secret word', 'entered: true']) {
      assert.deepEqual(readAnswer(spec(), { help: text, entered: false, cleared: true }), { ok: true, text, caret_only: null });
    }
  });

  it('keeps only the start of a very long text, at a character boundary, and says so', () => {
    assert.deepEqual(capText('short'), { text: 'short', truncated: false });
    const long = 'x'.repeat(HELP_TEXT_CHARS + 5);
    const cut = capText(long);
    assert.equal(cut.text.length, HELP_TEXT_CHARS);
    assert.equal(cut.truncated, true);
    const split = capText('a'.repeat(9) + '\u{1F600}'.repeat(3), 10);
    assert.equal(split.text, 'a'.repeat(9), 'a surrogate pair is not cut in half');
  });
});
