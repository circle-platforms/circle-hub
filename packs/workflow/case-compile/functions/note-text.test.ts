import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evidenceProblems, readNotes } from './delivery.ts';
import { CallFailure } from './text.ts';

const NOTE = { judged: '合成判断', remedy: '合成下一步' };
const read = (note: Record<string, unknown>) => readNotes({ cases: { c1: { ...NOTE, ...note } } }, ['c1']).cases.c1!;
function refusal(note: Record<string, unknown>): CallFailure {
  try { read(note); } catch (error) { assert.ok(error instanceof CallFailure, String(error)); return error; }
  return assert.fail('the note was accepted');
}
const NEXT_MISSING = '请按交付说明提供模型说明文件并保留原句';
const NEXT_LONG = '只引用说明问题的那一段，逐字复制，不改写';
const NEXT_CONTROL = '去掉这个字符后重试；引用设备输出时逐字复制，制表符照原样保留';
// A line of a name server's answer: the fields are apart by tabs, and the device prints them as they are.
const LINE = 'www.example.invalid.\t300\tIN\tA\t192.0.2.10';
const DEVICE = `;; ANSWER SECTION:\n${LINE}\n;; Query time: 1 msec\n`;

test('a quote with a tab that is a verbatim part of the device text is kept as it is and passes the verbatim check', () => {
  const notes = readNotes({ cases: { c1: { ...NOTE, evidence: ` ${LINE}\n ` } } }, ['c1']);
  assert.equal(notes.cases.c1!.evidence, LINE, 'only the ends are trimmed, the tabs between the fields stay');
  assert.deepEqual(evidenceProblems(notes, { c1: [DEVICE] }), []);
  const middle = readNotes({ cases: { c1: { ...NOTE, evidence: 'IN\tA' } } }, ['c1']);
  assert.deepEqual(evidenceProblems(middle, { c1: [DEVICE] }), [], 'a piece inside the line, tab included');
});

test('the same quote with the tabs written as spaces is not what the device printed, and the verbatim check says so in its own sentence', () => {
  const spaced = readNotes({ cases: { c1: { ...NOTE, evidence: LINE.replace(/\t/g, ' ') } } }, ['c1']);
  assert.deepEqual(evidenceProblems(spaced, { c1: [DEVICE] }), ['用例 c1 的设备输出不是最近一次上机验证的原话；逐字复制，不改写、不拼接']);
  const four = readNotes({ cases: { c1: { ...NOTE, evidence: LINE.replace(/\t/g, '    ') } } }, ['c1']);
  assert.equal(evidenceProblems(four, { c1: [DEVICE] }).length, 1, 'a tab is not folded into any number of spaces');
});

test('a text with carriage returns reads as the same text with line feeds only, in every field that takes a text', () => {
  const lf = read({ judged: '甲\n乙', remedy: '丙\n丁', evidence: '第一行\n第二行\t第三列' });
  const crlf = read({ judged: '甲\r\n乙', remedy: '丙\r\n丁', evidence: '第一行\r\n第二行\t第三列' });
  assert.deepEqual(crlf, lf);
  assert.equal(crlf.evidence, '第一行\n第二行\t第三列');
  assert.equal(read({ evidence: 'a\rb' }).evidence, 'ab', 'a lone one goes too');
  const candidate = readNotes({ cases: { c1: { ...NOTE, defect_candidate: { repro: '步骤一\r\n步骤二', expected: '期望\r\n原句', actual: '输出\r\n原句' } } } }, ['c1']).cases.c1!.defect_candidate;
  assert.deepEqual(candidate, { repro: '步骤一\n步骤二', expected: '期望\n原句', actual: '输出\n原句' });
  assert.deepEqual(evidenceProblems(readNotes({ cases: { c1: { ...NOTE, evidence: 'a\r\nb\tc' } } }, ['c1']), { c1: ['x\r\na\r\nb\tc\r\ny'] }), [], 'the device text with CRLF still holds the quote');
  assert.equal(readNotes({ cases: {}, batch: '一\r\n二' }, []).batch, '一\n二');
});

test('a text that is not there says that it is not there: not a text at all, or nothing but white space', () => {
  for (const value of [null, 5, ['x'], {}, '', '   ', ' \t\r\n ', '\r']) {
    const failure = refusal({ evidence: value });
    assert.deepEqual([failure.category, failure.fact, failure.next_action], ['invalid_parameters', '用例 c1 的设备输出没有写', NEXT_MISSING], JSON.stringify(value));
  }
  assert.equal(refusal({ judged: ' ' }).fact, '用例 c1 的结论没有写');
  assert.equal(refusal({ remedy: '\t' }).fact, '用例 c1 的下一步没有写');
  assert.equal(refusal({ defect_candidate: { repro: '', expected: 'e', actual: 'a' } }).fact, '用例 c1 的复现步骤没有写');
  assert.throws(() => readNotes({ cases: {}, batch: ' ' }, []), (error: unknown) => error instanceof CallFailure && error.fact === '补充说明没有写' && error.next_action === NEXT_MISSING);
});

test('a text that is too long says how long it is and what the limit is, counted without the carriage returns', () => {
  const failure = refusal({ evidence: 'x'.repeat(4001) });
  assert.deepEqual([failure.category, failure.fact, failure.next_action], ['invalid_parameters', '用例 c1 的设备输出有 4001 字，上限 4000 字', NEXT_LONG]);
  assert.equal(refusal({ judged: '字'.repeat(5000) }).fact, '用例 c1 的结论有 5000 字，上限 4000 字');
  assert.equal(read({ evidence: 'x'.repeat(4000) }).evidence!.length, 4000, 'the limit itself is allowed');
  assert.equal(read({ evidence: `${'x'.repeat(4000)}\r` }).evidence!.length, 4000, 'a carriage return is not counted');
  assert.equal(read({ evidence: `${'x'.repeat(2000)}\r\n${'y'.repeat(1999)}` }).evidence!.length, 4000, 'the line feed of a CRLF counts once');
  assert.equal(refusal({ evidence: `${'x'.repeat(2000)}\r\n${'y'.repeat(2000)}` }).fact, '用例 c1 的设备输出有 4001 字，上限 4000 字');
});

test('a control character other than the tab and the line feed is named by its place and its code, and the place is counted from 1 in the text as it was given', () => {
  const said = (value: string) => { const failure = refusal({ evidence: value }); return [failure.category, failure.fact, failure.next_action]; };
  assert.deepEqual(said('ab\u0001cd'), ['invalid_parameters', '用例 c1 的设备输出的第 3 个字符是控制字符 U+0001，这里只能有换行和制表符', NEXT_CONTROL]);
  assert.equal(refusal({ evidence: '\u0000' }).fact, '用例 c1 的设备输出的第 1 个字符是控制字符 U+0000，这里只能有换行和制表符');
  assert.equal(refusal({ evidence: 'x\u001b[0m' }).fact, '用例 c1 的设备输出的第 2 个字符是控制字符 U+001B，这里只能有换行和制表符');
  assert.equal(refusal({ evidence: 'x\u007f' }).fact, '用例 c1 的设备输出的第 2 个字符是控制字符 U+007F，这里只能有换行和制表符');
  for (const code of [0, 1, 8, 11, 12, 14, 31, 127]) assert.match(refusal({ evidence: `a${String.fromCharCode(code)}` }).fact, new RegExp(`第 2 个字符是控制字符 U\\+${code.toString(16).toUpperCase().padStart(4, '0')}，`), String(code));
  assert.equal(refusal({ evidence: 'a\r\nb\u0002' }).fact, '用例 c1 的设备输出的第 5 个字符是控制字符 U+0002，这里只能有换行和制表符', 'a carriage return before it is a character of the text as given');
  assert.equal(refusal({ evidence: '\t\n\u0007' }).fact, '用例 c1 的设备输出的第 3 个字符是控制字符 U+0007，这里只能有换行和制表符', 'the tab and the line feed before it are characters like the others');
  assert.equal(refusal({ evidence: 'a\u0001b\u0002' }).fact, '用例 c1 的设备输出的第 2 个字符是控制字符 U+0001，这里只能有换行和制表符', 'the first one is named');
  for (const fine of ['a\tb', 'a\nb', '\ta\t\n', 'a\u0085b', 'a\u00a0b']) assert.equal(read({ evidence: fine }).evidence, fine.trim(), JSON.stringify(fine));
});

test('too long is said before a control character, and each of the three says it for the field it was found in', () => {
  assert.equal(refusal({ evidence: `${'x'.repeat(4001)}\u0001` }).fact, '用例 c1 的设备输出有 4002 字，上限 4000 字');
  assert.equal(refusal({ judged: 'a\u0001' }).fact, '用例 c1 的结论的第 2 个字符是控制字符 U+0001，这里只能有换行和制表符');
  assert.equal(refusal({ defect_candidate: { repro: 'r', expected: 'e\u0003', actual: 'a' } }).fact, '用例 c1 的期望原句的第 2 个字符是控制字符 U+0003，这里只能有换行和制表符');
  assert.equal(refusal({ author_conflict: { author: 'x', manual: 'y', reference: 'z\u0004' } }).fact, '用例 c1 对应的手册的第 2 个字符是控制字符 U+0004，这里只能有换行和制表符');
});

test('the one-line cause keeps its own rule: one line of at most 200 characters', () => {
  assert.equal(read({ cause: '设备拒绝了作者写的名字' }).cause, '设备拒绝了作者写的名字');
  for (const cause of ['第一行\n第二行', '第一行\r\n第二行', '字'.repeat(201)]) assert.equal(refusal({ cause }).fact, '用例 c1 的一句话原因要是一句话：不换行，不超过 200 字', JSON.stringify(cause).slice(0, 20));
  assert.equal(refusal({ cause: ' ' }).fact, '用例 c1 的一句话原因没有写', 'a cause with nothing in it is not there');
  assert.equal(refusal({ cause: 'a\u0001' }).fact, '用例 c1 的一句话原因的第 2 个字符是控制字符 U+0001，这里只能有换行和制表符');
});
