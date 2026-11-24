import {labelOf} from './generated/vocabulary.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorConflictProblems, CLOSING, closeFailed, closeUnrun, closingCounts, closingLine, lockedStatements, readNotes, type AuthorConflict, type CaseOutcome, type ConflictGround, type MissingFact, type Notes } from './delivery.ts';

const ROOT = 'a'.repeat(64);
const ENTRY = `tree:${ROOT}/manual/guide/names@${'1'.repeat(64)}`, OTHER = `tree:${ROOT}/manual/guide/modes@${'2'.repeat(64)}`;
const MANUAL = '| peer_name | 合成参数说明：特殊字符仅支持“._-”。 |';
const AUTHOR = '配置对端名 peer:b';
const WORDS = ['合成标题', AUTHOR, '对端名显示成功'];
const GROUND: ConflictGround = { authored: { c1: WORDS, c2: WORDS, c3: WORDS }, statements: new Map([[ENTRY, MANUAL], [OTHER, '| mode | 合成参数说明：取值为 full 或 delta。 |']]) };
const CONFLICT: AuthorConflict = { author: AUTHOR, manual: '特殊字符仅支持“._-”', reference: ENTRY };
const TYPED_AT_THE_WRONG_PROMPT = ['seat(config)#exit', '', 'seat#widget sync to peer-b', '', 'widget sync to peer-b ', '^', ''].join('\n');
const SEEN = 'seat(config)#widget name peer:b\nWidget name format error.\nseat(config)#\n';

const failed = (autoid: string, status: CaseOutcome['status'] = 'failed'): CaseOutcome => ({ autoid, status, history: status === 'unrun' ? [] : [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: status === 'failed' ? 'fail' : 'no_verdict' }] });
const note = (extra: Partial<Notes['cases'][string]> = {}): Notes['cases'][string] => ({ judged: '合成判断', remedy: '合成取舍', ...extra });
const close = (outcome: CaseOutcome, notes: Notes, rounds: number | undefined, deviceTexts: string[] = [SEEN], ground: ConflictGround | undefined = GROUND) =>
  closeFailed([outcome], notes, rounds === undefined ? {} : { [outcome.autoid]: rounds }, {}, { [outcome.autoid]: deviceTexts }, ground);

test('quotes that stand close the case at any round, as the author-and-manual conflict it waits on, keeping the pair for the report', () => {
  const notes: Notes = { cases: { c1: note({ author_conflict: CONFLICT }) } };
  for (const rounds of [1, 2, 3, 4]) {
    const closed = close(failed('c1'), notes, rounds);
    assert.deepEqual(closed.problems, [], String(rounds));
    assert.deepEqual([closed.cases[0].closing, closed.cases[0].rounds, closed.cases[0].conflict], ['author_conflict', rounds, CONFLICT], `round ${rounds}: a verified claim waits for a ruling, it does not wait for the cap`);
  }
  const unsettled = close(failed('c1', 'unsettled'), notes, undefined);
  assert.deepEqual([unsettled.problems, unsettled.cases[0].closing, unsettled.cases[0].rounds], [[], 'author_conflict', undefined]);
});

test('without the claim the three older closings keep their rules: the cap at three rounds, a refusal before it, a verified defect candidate', () => {
  const plain: Notes = { cases: { c1: note() } };
  assert.equal(close(failed('c1'), plain, 3).cases[0].closing, 'authoring_failure');
  const early = close(failed('c1'), plain, 1);
  assert.equal(early.cases[0].closing, undefined);
  assert.match(early.cases[0].pending![0], /已记录 1 份不同内容的核验尚未通过，缺少可核验的原因归属.*既有预算内继续编写/);
  const candidate = { repro: '合成复现', expected: '对端名显示成功', actual: 'Widget name format error.' };
  const defect = closeFailed([failed('c1')], { cases: { c1: note({ defect_candidate: candidate }) } }, { c1: 1 }, { c1: ['对端名显示成功'] }, { c1: [SEEN] }, GROUND);
  assert.deepEqual([defect.cases[0].closing, defect.problems], ['device_defect', []]);
});

test('each quote is checked on its own and a claim that does not stand names what to copy again, closing nothing', () => {
  const cases: Array<[string, AuthorConflict, RegExp]> = [
    ['an author sentence the case never had', { ...CONFLICT, author: '作者没写过这一句' }, /原始用例引文不是标题、步骤或期望的原句；逐字复制，不改写、不拼接$/],
    ['a reference outside the locked root', { ...CONFLICT, reference: `tree:${ROOT}/manual/guide/gone@${'3'.repeat(64)}` }, /所选手册不属于脚本编写时使用的手册和命令树，请使用同一构建的手册和命令树/],
    ['a statement the cited entry does not hold', { ...CONFLICT, manual: '特殊字符仅支持“._-:”' }, /手册引文不是所选手册的原话/],
    ['the statement of another entry', { ...CONFLICT, reference: OTHER }, /手册引文不是所选手册的原话/],
    ['quotes too short to point at anything', { ...CONFLICT, author: 'peer', manual: '._-' }, /原始用例原句和手册原话各要逐字引用一整句，至少 4 个字/],
  ];
  for (const [name, conflict, expected] of cases) {
    const closed = close(failed('c1'), { cases: { c1: note({ author_conflict: conflict }) } }, 1);
    assert.equal(closed.cases[0].closing, undefined, name);
    assert.equal(closed.cases[0].pending!.length, 1, name);
    assert.match(closed.cases[0].pending![0], expected, name);
    assert.ok(closed.cases[0].pending![0].startsWith('用例 c1 判断原始用例的问题时，'), name);
  }
  const both = close(failed('c1'), { cases: { c1: note({ author_conflict: { ...CONFLICT, author: '作者没写过这一句', manual: '手册没写过这一句' } }) } }, 1);
  assert.match(both.cases[0].pending![0], /原始用例引文不是标题、步骤或期望的原句；手册引文不是所选手册的原话；逐字复制/);
  assert.deepEqual(authorConflictProblems('c1', CONFLICT, { authored: { c1: WORDS.map((line) => line.replace(' ', ' \r')) }, statements: new Map([[ENTRY, MANUAL.replace('特殊字符', '特殊\r字符')]]) }, []), []);
  assert.match(close(failed('c1'), { cases: { c1: note({ author_conflict: CONFLICT }) } }, 1, [SEEN], { authored: {}, statements: new Map() }).cases[0].pending![0], /这条原始用例的原文取不到，请补齐用例重组或脚本编写时的原始用例；所选手册不属于/);
  assert.match(closeFailed([failed('c1')], { cases: { c1: note({ author_conflict: CONFLICT }) } }, { c1: 1 }, {}, { c1: [SEEN] }).cases[0].pending![0], /取不到/);
});

test('a last device output with a syntax rejection is the device not accepting the command, so no conflict is closed on it', () => {
  const notes: Notes = { cases: { c1: note({ author_conflict: CONFLICT }) } };
  const refused = close(failed('c1'), notes, 1, ['合成日志', TYPED_AT_THE_WRONG_PROMPT]);
  assert.equal(refused.cases[0].closing, undefined);
  assert.equal(refused.cases[0].pending!.length, 1);
  assert.match(refused.cases[0].pending![0], /用例 c1 判断原始用例的问题时，它最后一次上机里设备用 \^ 拒绝了命令 “widget sync to peer-b”（在 seat# 下）。设备没有接受这条命令的写法，作者的场景没有在设备上实现，够不上作者步骤与手册冲突：请重新判断原因，先修这条命令再做上机验证；最多重交 3 次，仍未核对正确时只陈述这些内容的核验结果，原因未查清就保留未知/);
  assert.equal(close(failed('c1'), notes, 1, [SEEN]).cases[0].closing, 'author_conflict');
  assert.equal(close(failed('c1'), notes, 1, []).cases[0].closing, 'author_conflict');
});

test('a case never sent to the bed closes on the claim too, after the Hub’s own records, and otherwise goes back to authoring', () => {
  const notes: Notes = { cases: { c3: note({ author_conflict: CONFLICT }) } };
  const unrun = failed('c3', 'unrun');
  const closed = closeUnrun([unrun], {}, notes, GROUND);
  assert.deepEqual([closed.problems, closed.cases[0].closing, closed.cases[0].conflict, closed.cases[0].rounds], [[], 'author_conflict', CONFLICT, undefined]);
  const fact: MissingFact = { kind: 'data_gap', plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', requirement: 'contract_methods', missing: '合成缺失事实' };
  assert.equal(closeUnrun([unrun], { c3: fact }, notes, GROUND).cases[0].closing, 'missing_fact', 'what the Hub recorded keeps its place');
  const stale = closeUnrun([unrun], {}, { cases: { c3: note({ author_conflict: { ...CONFLICT, manual: '手册没写过这一句' } }) } }, GROUND);
  assert.equal(stale.cases[0].closing, undefined);
  assert.match(stale.cases[0].pending![0], /^用例 c3 判断原始用例的问题时，手册引文不是所选手册的原话；逐字复制/);
  const none = closeUnrun([unrun], {}, { cases: { c3: note() } }, GROUND);
  assert.match(none.cases[0].pending![0], /^没有取得可核验的计划结论或具名缺失事实出口$/);
  assert.equal(closeUnrun([unrun], {}).cases[0].pending!.length, 1, 'the callers that pass no notes keep working');
  const manyUnrun = Array.from({ length: 13 }, (_, i) => failed(`c${i + 1}`, 'unrun'));
  const aggregated = closeUnrun(manyUnrun, {});
  assert.deepEqual(aggregated.problems, []);
  assert.equal(aggregated.cases.length, 13);
  assert.ok(aggregated.cases.every(c => c.pending?.length === 1 && !c.closing));
});

test('the notes carry the claim as exactly three plain texts, never beside a defect candidate', () => {
  const read = (note: unknown) => readNotes({ cases: { c1: note } }, ['c1']);
  const parsed = read({ judged: '合成判断', remedy: '合成取舍', author_conflict: { author: ` ${AUTHOR} `, manual: CONFLICT.manual, reference: ENTRY } });
  assert.deepEqual(parsed.cases.c1.author_conflict, CONFLICT, 'the texts are kept trimmed');
  assert.throws(() => read({ judged: 'j', remedy: 'r', author_conflict: { author: AUTHOR, manual: CONFLICT.manual } }), /用例 c1 判断原始用例的问题时，请只写原始用例原句、手册原话和对应的手册三项/);
  assert.throws(() => read({ judged: 'j', remedy: 'r', author_conflict: { ...CONFLICT, extra: '多余' } }), /判断原始用例的问题时，请只写原始用例原句、手册原话和对应的手册三项/);
  assert.throws(() => read({ judged: 'j', remedy: 'r', author_conflict: { ...CONFLICT, manual: '' } }), /用例 c1 的手册原话没有写/);
  assert.throws(() => read({ judged: 'j', remedy: 'r', author_conflict: CONFLICT, defect_candidate: { repro: 'r', expected: 'e', actual: 'a' } }), /用例 c1 不能同时判断为设备的问题和原始用例的问题/);
  assert.throws(() => read({ judged: 'j', remedy: 'r', other: 1 }), /判断设备问题或原始用例问题所需的原文/);
  const withRound = read({ judged: 'j', remedy: 'r', round: 2 });
  assert.equal(withRound.cases.c1.round, 2);
  const withoutRound = read({ judged: 'j', remedy: 'r' });
  assert.equal(withoutRound.cases.c1.round, undefined);
  assert.throws(() => read({ judged: 'j', remedy: 'r', round: 0 }), /轮次（round）须是大于等于 1 的整数/);
  assert.throws(() => read({ judged: 'j', remedy: 'r', round: 1.5 }), /轮次（round）须是大于等于 1 的整数/);
});

test('the report names the closing and what was and was not checked, in plain words', () => {
  const at = (n: number): CaseOutcome => ({ ...failed('c1'), rounds: n, closing: 'author_conflict', conflict: CONFLICT });
  assert.equal(CLOSING.author_conflict, '作者步骤与手册冲突（待作者或用户裁定）');
  const ran = closingLine(at(1))!;
  assert.ok(ran.startsWith('作者步骤与手册冲突（待作者或用户裁定）：模型判断作者的步骤要的取值或写法，在产品自己的手册说明里被排除了。'), ran);
  assert.match(ran, /作者原句和手册原句已逐字核对（见下），工具只核了这两段原文确实存在，没有核它们是否真的对不上，也没有判谁对：是按手册改作者的步骤，还是作者就要照原样测，由作者或用户裁定。它已上机 1 次（已核验 1 份不同内容），裁定前不再为它上机，也不为凑满 3 轮再跑一卷。下面“怎么判断的”是模型自述，不是裁定。$/);
  assert.match(closingLine({ ...failed('c3', 'unrun'), closing: 'author_conflict', conflict: CONFLICT })!, /。它没有上机，裁定前不再为它上机/);
  assert.match(closingLine({ ...failed('c1', 'unsettled'), closing: 'author_conflict', conflict: CONFLICT })!, /。它已上机 1 次，裁定前不再为它上机/, 'no authored rounds are counted for a case with no verdict, so none is claimed');
  assert.equal(closingLine({ ...failed('c1'), closing: 'authoring_failure', rounds: 3 })!.startsWith('所记录的核验尚未通过：已核验 3 份不同内容'), true, 'recorded failures do not claim a model cause');
  const exhaustedLine = closingLine({ autoid: 'c4', rounds: 0, status: 'unrun', closing: 'authoring_failure', missing: { kind: 'repair_exhausted', plan_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', requirement: 'plan', missing: '合成拒绝原话' }, history: [] })!;
  assert.doesNotMatch(exhaustedLine, /收口|受理|计划运行/);
  assert.match(exhaustedLine, /计划已交给 Hub.*也没有被脚本合并接受.*不能据此确认原因在编写模型/);
  const auditedLine = closingLine({ ...failed('c5'), rounds: 2, closing: 'authoring_failure', history: [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'job_1', terminal: 'pass', audit: { where: 'stdout', line: 'ERROR: bad' } }] })!;
  assert.doesNotMatch(auditedLine, /收口|受理|计划运行/);
  assert.equal(closingCounts([at(1), { ...failed('c2'), rounds: 3, closing: 'authoring_failure' }, { ...failed('c3', 'unrun'), closing: 'author_conflict', conflict: CONFLICT }]), `原始用例 c1，原因${labelOf('attribution','author_input')}。原始用例 c2，原因${labelOf('attribution','unattributed')}。原始用例 c3，原因${labelOf('attribution','author_input')}。`);
});

test('the statements of the cited entries come from the Hub’s batch of the locked root and from nothing else', () => {
  const node = (path: string, entries: Array<[string, string]>) => ({ path, children: [], entries: entries.map(([reference, statement]) => ({ entry: '1'.repeat(64), kind: 'behaviour', statement, reference, data: {} })) });
  const nodes = [node('/manual/guide/names', [[ENTRY, MANUAL]]), node('/manual/guide/modes', [[OTHER, '合成另一条']]), node('/commands/widget', [[`tree:${ROOT}/commands/widget@${'4'.repeat(64)}`, 'widget name <arg1:string>']])];
  const batch = (head: Record<string, unknown> = {}, lines: unknown[] = nodes) => Buffer.from([{ schema: 'run-knowledge@1', run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', root: ROOT, composition: null, nodes: lines.length, entries: 3, ...head }, ...lines].map((line) => JSON.stringify(line)).join('\n') + '\n');
  const found = lockedStatements(batch(), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY, `tree:${ROOT}/manual/guide/gone@${'3'.repeat(64)}`]));
  assert.equal(found.root, ROOT);
  assert.deepEqual([...found.statements], [[ENTRY, MANUAL]], 'only the cited references are kept; one the root does not hold is absent');
  assert.throws(() => lockedStatements(batch(), 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', new Set([ENTRY])), /手册和命令树不属于本次脚本编写或内容不完整/);
  assert.throws(() => lockedStatements(batch({ schema: 'run-knowledge@2' }), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树不属于本次脚本编写或内容不完整/);
  assert.throws(() => lockedStatements(batch({ nodes: 7 }), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树缺少内容/);
  assert.throws(() => lockedStatements(Buffer.from(''), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树缺少内容/);
  assert.throws(() => lockedStatements(Buffer.from('not json\n'), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树内容不完整/);
  assert.throws(() => lockedStatements(Buffer.from([0xff, 0xfe, 0x0a]), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树无法读取/);
  assert.throws(() => lockedStatements(batch({}, [{ path: '/x' }]), 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', new Set([ENTRY])), /手册和命令树内容不完整/);
});
