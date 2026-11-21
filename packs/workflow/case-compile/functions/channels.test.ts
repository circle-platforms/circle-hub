import assert from 'node:assert/strict';
import { test } from 'node:test';
import check, { readWorkbook } from './workbook.ts';
import { checkCommandsKnown } from './checks.ts';
import { generateWorkbookSet, type GenerationInput } from './generate.ts';
import { conflictText, movedText, volumeOrder, volumeProblems } from './channels.ts';
import { workbookCheckInput, coreModel, digest } from '../testing/workbook-model.ts';
import { AUTOIDS, BOOT, DISK, PEER, contractDoc, plainPolicy, planInput, profileDoc, rawCatalog, recipe } from '../testing/channels.ts';
import { MANIFEST_DOC } from './test-support.ts';

const [A, B, C, D, E] = AUTOIDS;
const SHOW = 'show pool', STORE = 'demo store file backup', PUSH = 'demo mirror push unit-b', BOOT_ON = 'demo mirror boot on', BOOT_OFF = 'demo mirror boot off', RELOAD = 'demo reload file backup';
const RANK_LOCAL = 'demo link rank group-a 10 20', RANK_PEER = 'demo link rank group-a 10 20 unit-b';
const codes = (outcomes: Array<{ verdict: string; code?: string }>) => outcomes.filter((row) => row.verdict === 'refute').map((row) => row.code);
const autoids = (inputs: readonly GenerationInput[]) => inputs.map((input) => input.fields.autoid);

/** The Hub's check input for item k of a verification run over `inputs` (document order), the workbook being `bytes`. */
function itemInput(inputs: GenerationInput[], bytes: Uint8Array, k: number) {
  const base = workbookCheckInput(bytes).subject;
  const planSet = inputs.map((input, at) => ({ item: `doc-1:c-${at + 1}`, fields: { autoid: input.fields.autoid, title: input.fields.title, path: input.fields.path, priority: input.fields.priority, steps: input.fields.steps }, plan: input.slots, command_catalog: input.fields.command_catalog }));
  return { subject: { ...base, item: `doc-1:c-${k + 1}`, data: inputs[k].slots, fields: inputs[k].fields, contract: contractDoc, profile: profileDoc, manifest: MANIFEST_DOC, command_identities: [], command_catalog: rawCatalog(), case_texts: [], plan_set: planSet } };
}

test('the cases that leave state behind are written last, in the order they had, and everything else keeps its place', () => {
  const inputs = [recipe(A, [SHOW]), recipe(B, [STORE]), recipe(C, [SHOW]), recipe(D, [PUSH]), recipe(E, [SHOW])];
  const { ordered, moved } = volumeOrder(inputs);
  assert.deepEqual(autoids(ordered), [A, C, E, B, D]);
  assert.deepEqual(moved.map((row) => [row.autoid, row.channels.map((channel) => channel.id)]), [[B, ['disk']], [D, ['peer']]]);
  assert.deepEqual(moved[0].channels[0], { id: 'disk', source: DISK, commands: [STORE] }, 'the declared source and the command that put the case there');
  assert.deepEqual(autoids(volumeOrder(ordered).ordered), [A, C, E, B, D], 'ordering an ordered volume changes nothing');

  const bytes = generateWorkbookSet(inputs), model = coreModel(bytes);
  const read = readWorkbook(model, inputs);
  assert.ok(read.ok, JSON.stringify(read)); if (!read.ok) return;
  assert.deepEqual(read.autoids, [A, C, E, B, D], 'the workbook holds the cases in volume order');
  assert.equal(digest(generateWorkbookSet(ordered)), digest(bytes), 'the same bytes whichever order the cases are given in');
  assert.ok(readWorkbook(model, ordered).ok);
  // The cases written in document order are not this workbook.
  const rows = (model.sheets[0].rows.flatMap((row) => row.cells.filter((cell) => cell.reference.startsWith('A') && cell.text !== '').map((cell) => cell.text)));
  assert.deepEqual(rows.filter((text) => AUTOIDS.includes(text)), [A, C, E, B, D]);
  const plain = inputs.map((input, k) => recipe(AUTOIDS[k], [[SHOW], [STORE], [SHOW], [PUSH], [SHOW]][k], plainPolicy));
  assert.deepEqual(autoids(volumeOrder(plain).ordered), AUTOIDS, 'a policy without the declarations leaves the order alone');
  assert.deepEqual(volumeOrder(plain).moved, []);
  assert.notEqual(digest(generateWorkbookSet(plain)), digest(bytes));
});

test('a command is in a channel by its tree prefix, and an optional parameter counts only when it was written', () => {
  const only = (lines: string[]) => volumeOrder([recipe(A, [SHOW]), recipe(B, lines)]).moved.map((row) => row.autoid);
  assert.deepEqual(only([STORE]), [B]);
  assert.deepEqual(only(['demo store memory']), [B], 'a command under the prefix');
  assert.deepEqual(only([PUSH]), [B]);
  assert.deepEqual(only([RANK_PEER]), [B], 'a rank that names its peer writes the peer');
  assert.deepEqual(only([RANK_LOCAL]), [], 'a rank without the optional peer parameter writes nothing there');
  assert.deepEqual(only([BOOT_ON]), [], 'a combination side alone is no channel');
  assert.deepEqual(only(['demo pool list']), []);
  assert.deepEqual(only([SHOW, BOOT_OFF, SHOW]), []);
  assert.deepEqual(only([SHOW, STORE]), [B], 'one command anywhere in the case is enough');
  // Nothing runs after anything when every case of the volume is a channel case, or the volume is one case: no placement is told.
  assert.deepEqual(volumeOrder([recipe(B, [STORE]), recipe(D, [PUSH])]).moved, []);
  assert.deepEqual(volumeOrder([recipe(B, [STORE])]).moved, []);
  assert.deepEqual(autoids(volumeOrder([recipe(B, [STORE]), recipe(D, [PUSH])]).ordered), [B, D]);
  assert.equal(movedText([]), '');
  assert.match(movedText(volumeOrder([recipe(A, [SHOW]), recipe(B, [STORE]), recipe(D, [PUSH])]).moved, new Map([[B, '合成用例 42']])), new RegExp(`^原始用例 ${B} 合成用例 42、${D} 的命令会留下用例结束后仍未清除的配置，已在自动化用例 Excel 中排到最后。决定者程序。$`));
});

test('a volume that holds both sides of a forbidden combination is not written, and every case on either side is named', () => {
  const inputs = [recipe(A, [BOOT_ON]), recipe(B, [SHOW]), recipe(C, [RELOAD]), recipe(D, [PUSH])];
  const rows = volumeProblems(inputs);
  assert.deepEqual(rows.map((row) => [row.combination, row.source, row.side_a.map((c) => c.autoid), row.side_b.map((c) => c.autoid)]), [['boot_reload', BOOT, [A], [C, D]]]);
  assert.deepEqual(rows[0].side_b.map((c) => c.commands), [[RELOAD], [PUSH]]);
  const text = conflictText(rows[0]);
  for (const part of [A, C, D, BOOT_ON, RELOAD, PUSH, '合成用例 41', '同一份自动化用例 Excel 中有产品文档声明不能一起使用的命令']) assert.ok(text.includes(part), part);
  assert.ok(!text.includes(B), 'a case on neither side is not named');
  // Only one side, the other side switched off, or no declaration: nothing is refused.
  assert.deepEqual(volumeProblems([recipe(A, [BOOT_ON]), recipe(B, [SHOW])]), []);
  assert.deepEqual(volumeProblems([recipe(A, [BOOT_OFF]), recipe(C, [RELOAD])]), [], 'switching the boot sync off is not side A');
  assert.deepEqual(volumeProblems(inputs.map((input, k) => recipe(AUTOIDS[k], [[BOOT_ON], [SHOW], [RELOAD], [PUSH]][k], plainPolicy))), []);
  // One case with both sides is the same violation.
  const same = volumeProblems([recipe(A, [BOOT_ON, RELOAD])]);
  assert.deepEqual(same.map((row) => [row.side_a[0].autoid, row.side_b[0].autoid]), [[A, A]]);
  assert.match(conflictText(same[0]), /^同一条自动化用例中有产品文档声明不能一起使用的命令/);
});

test('the verification run supports a volume with its placement disclosed, and refuses the cases on either side of a forbidden one', () => {
  const inputs = [recipe(A, [SHOW]), recipe(B, [STORE]), recipe(C, [SHOW]), recipe(D, [PUSH])];
  const bytes = generateWorkbookSet(inputs);
  const results = inputs.map((_, k) => check(itemInput(inputs, bytes, k)));
  for (const result of results) { assert.equal(result.length, 1); assert.equal(result[0].verdict, 'support', JSON.stringify(result)); }
  const data = results[0][0].data as { autoids: string[]; moved_tail: Array<{ autoid: string; channels: Array<{ id: string; source: string }> }> };
  assert.deepEqual(data.autoids, [A, C, B, D], 'the run reports the cases in the order the workbook holds them');
  assert.deepEqual(data.moved_tail.map((row) => [row.autoid, row.channels.map((channel) => [channel.id, channel.source])]), [[B, [['disk', DISK]]], [D, [['peer', PEER]]]]);
  assert.match(results[0][0].statement, new RegExp(`原始用例 ${B} 合成用例 42、${D} 合成用例 44 的命令会留下用例结束后仍未清除的配置，已在自动化用例 Excel 中排到最后。决定者程序。`));
  assert.deepEqual(results[1][0].data, results[0][0].data, 'every item of the run reports the same volume');
  // A workbook written in document order is not this volume's workbook.
  const unordered = generateWorkbookSet(inputs.map((input) => ({ ...input, fields: { ...input.fields, command_catalog: { ...(input.fields.command_catalog as object), policy: plainPolicy } } })));
  assert.ok(check(itemInput(inputs, unordered, 0)).some((row) => row.verdict === 'refute' && row.code === 'case-compile.workbook_invalid'));
  // Nothing is disclosed when no case leaves state behind.
  const quiet = [recipe(A, [SHOW]), recipe(C, [SHOW])];
  const quietData = check(itemInput(quiet, generateWorkbookSet(quiet), 0))[0].data as Record<string, unknown>;
  assert.deepEqual(Object.keys(quietData).sort(), ['autoids', 'bed', 'build', 'generator', 'plan_run', 'sha256']);

  const forbidden = [recipe(A, [BOOT_ON]), recipe(B, [SHOW]), recipe(C, [RELOAD])];
  const written = generateWorkbookSet(forbidden);
  const outcomes = forbidden.map((_, k) => check(itemInput(forbidden, written, k)));
  assert.deepEqual(outcomes.map((rows) => rows.map((row) => row.verdict)), [['refute'], ['support'], ['refute']], 'the cases on the two sides are refused; the other case is verified as before');
  for (const k of [0, 2]) {
    const refused = outcomes[k][0] as unknown as { code: string; statement: string; item: string; data: { conflicts: Array<{ combination: string }> } };
    assert.equal(refused.code, 'case-compile.combination_forbidden');
    for (const part of [A, C, BOOT_ON, RELOAD, '尚未向设备发送命令', '请使用者决定是否修改原始用例']) assert.ok(refused.statement.includes(part), part);
    assert.deepEqual(refused.data.conflicts.map((row) => row.combination), ['boot_reload']);
  }
  assert.equal((outcomes[0][0] as { item: string }).item, 'doc-1:c-1');
});

test('a plan that holds both sides of a forbidden combination is refused when it is checked, with the step that holds side B', () => {
  const supported = checkCommandsKnown(planInput([SHOW, BOOT_ON, SHOW]));
  assert.deepEqual(supported.map((row) => row.verdict), ['support'], JSON.stringify(supported));
  assert.deepEqual(checkCommandsKnown(planInput([BOOT_ON, BOOT_OFF, RELOAD])).map((row) => row.verdict), ['refute'], 'the boot sync is still side A once it has been on');
  const refused = checkCommandsKnown(planInput([SHOW, BOOT_ON, SHOW, RELOAD])) as unknown as Array<{ verdict: string; code: string; statement: string; pointer: string; data: { conflicts: Array<{ combination: string; a: string[]; b: string[] }> } }>;
  assert.deepEqual(refused.map((row) => [row.verdict, row.code, row.pointer]), [['refute', 'case-compile.combination_forbidden', '/data/steps/3/args/0']]);
  for (const part of ['自动化用例中有产品文档声明不能一起使用的命令', BOOT_ON, RELOAD, '请使用者决定是否修改原始用例']) assert.ok(refused[0].statement.includes(part), part);
  assert.deepEqual(refused[0].data.conflicts.map((row) => [row.combination, row.a, row.b]), [['boot_reload', [BOOT_ON], [RELOAD]]]);
  assert.deepEqual(codes(checkCommandsKnown(planInput([BOOT_ON, PUSH]))), ['case-compile.combination_forbidden'], 'a push is side B and a channel command at once');
  assert.deepEqual(checkCommandsKnown(planInput([BOOT_ON, RELOAD], plainPolicy)).map((row) => row.verdict), ['support'], 'without the declaration nothing is refused');
  assert.deepEqual(checkCommandsKnown(planInput([STORE, PUSH])).map((row) => row.verdict), ['support'], 'channel commands alone are ordered, never refused');
});
