import assert from 'node:assert/strict';
import { test } from 'node:test';
import { consolidateDispatchNotes, runnerNote, runnerNoted } from './accepted.ts';
import type { JobStatus } from './service.ts';

const hex = (letter: string) => letter.repeat(64);
const finished = (letter: string, extra: Record<string, unknown> = {}) => {
  const job = hex(letter);
  return { job, ended: 'done' as const, boundary_refused: false, status: { job, phase: 'complete', outcome: 'effective', frozen: false, events: 2, result: `src:${hex(letter === 'a' ? '1' : '2')}`, ...extra } as unknown as JobStatus };
};
const nextStepsOf = (text: string) => text.match(/下一步/g)?.length ?? 0;

test('jobs that end with different results and give the same next step say it once, and every job keeps its note', () => {
  const notes = ['a', 'b', 'c'].map((letter) => runnerNoted(finished(letter)));
  assert.notEqual(notes[0].text, notes[1].text, 'the two results differ, so the notes do');
  const consolidated = consolidateDispatchNotes(notes);
  assert.equal(consolidated.length, 3, 'no job is dropped');
  assert.deepEqual(consolidated.map((note) => note.job), notes.map((note) => note.job));
  assert.equal(nextStepsOf(consolidated[0].text), 1);
  assert.match(consolidated[0].text, /下一步：读结果引用看逐条结论$/);
  for (const later of consolidated.slice(1)) {
    assert.match(later.text, /下一步：同上$/);
    assert.match(later.text, /结果引用 src:/, 'what is the job’s own stays');
  }
  assert.equal(consolidated.reduce((count, note) => count + (note.text.includes('读结果引用看逐条结论') ? 1 : 0), 0), 1);
  for (const note of consolidated) assert.deepEqual(Object.keys(note).filter((key) => key === 'next' || key === 'pointed'), [], 'the working fields do not go out');
  assert.deepEqual(consolidateDispatchNotes(consolidated), consolidated, 'notes already consolidated stay as they are');
});

test('a next step that differs is kept in full, and a note that is not a job note is left alone', () => {
  const effective = runnerNoted(finished('a'));
  const refused = runnerNoted(finished('b', { outcome: 'target_rejected', rejection_stage: 'admission', result: undefined }));
  const plain = { text: 'Hub 正在做上机验证前的核对；下一步由模型稍后原样重交，读取进展' };
  const consolidated = consolidateDispatchNotes([effective, refused, plain]);
  assert.deepEqual(consolidated.map((note) => note.text), [effective.text, refused.text, plain.text]);
});

test('notes with one and the same text stay one and the same text, for the answer to say once', () => {
  const [first, second] = ['a', 'b'].map((letter) => runnerNoted(finished(letter, { result: undefined })));
  assert.equal(first.text, second.text, 'two jobs that ended the same way read the same to a member');
  const consolidated = consolidateDispatchNotes([first, second]);
  assert.equal(consolidated[0].text, first.text);
  assert.equal(consolidated[1].text, consolidated[0].text);
  assert.deepEqual(consolidated.map((note) => note.job), [hex('a'), hex('b')]);
});

test('earlier jobs that were tried again say that once, and a refusal in the sentence form points to the step it shares', () => {
  const refused = (letter: string, fact: string) => finished(letter, { outcome: 'not_dispatched', not_sent: true, error_code: 'LEASE_UNAVAILABLE', call_error_category: 'occupied', member_missing_facts: [{ fact, next_action: '等占用结束后原样重交' }], result: undefined });
  const earlier = [refused('a', '测试环境 A 正被占用'), refused('b', '测试环境 B 正被占用')].map((job) => runnerNoted(job, true));
  const [one, two] = consolidateDispatchNotes(earlier);
  assert.match(one.text, /这次重交 Hub 已再试/);
  assert.match(two.text, /下一步：?同上/);
  const now = [refused('c', '测试环境 C 正被占用'), refused('d', '测试环境 D 正被占用')].map((job) => runnerNoted(job));
  const sentences = consolidateDispatchNotes(now);
  assert.match(sentences[0].text, /^已被占用：.*测试环境 C 正被占用.*等占用结束后原样重交。$/);
  assert.match(sentences[1].text, /^已被占用：.*测试环境 D 正被占用.*下一步同上。$/);
  assert.equal(sentences.map((note) => note.text).join('').split('等占用结束后原样重交').length - 1, 1, 'said once across the two');
  assert.deepEqual(runnerNote(refused('c', '测试环境 C 正被占用')), { ...sentences[0] }, 'runnerNote itself is the note as it was');
});
