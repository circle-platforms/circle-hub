import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  caseConclusion,
  CLOSING,
  closingLine,
  deliveryReport,
  extractModelReason,
  noteUserFacingProblems,
  OWNERS,
  REASONS,
  STATUS,
  timeline,
  unsuccessfulReport,
  type Assembly,
  type CaseOutcome,
  type Notes,
  type ReportInput,
} from './delivery.ts';

function makeInput(overrides: Partial<ReportInput> = {}): ReportInput {
  const cases: CaseOutcome[] = overrides.assembly?.cases ?? [
    { autoid: 'c1', status: 'delivered', history: [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'pass' }] },
  ];
  const assembly: Assembly = overrides.assembly ?? {
    cases,
    pass: { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', sha256: 'a'.repeat(64), items: ['c1'], rows: [] },
    unsuccessful: null,
    totals: { cases: cases.length, delivered: cases.filter((c) => c.status === 'delivered').length, failed: cases.filter((c) => c.status === 'failed').length, unsettled: cases.filter((c) => c.status === 'unsettled').length, unrun: cases.filter((c) => c.status === 'unrun').length },
  };
  return {
    name: '合成交付批',
    generatedAt: '2026-11-15 13:00',
    build: 'SYNTH-BUILD-1',
    assembly,
    notes: overrides.notes ?? { cases: {} },
    originals: overrides.originals ?? {
      c1: { title: '合成标题一', lines: [{ text: '执行命令 A', expected: ['输出正确'] }] },
      c2: { title: '合成标题二', lines: [{ text: '执行命令 B', expected: ['返回正常'] }] },
      c3: { title: '合成标题三', lines: [{ text: '执行命令 C', expected: ['配置生效'] }] },
    },
    excluded: overrides.excluded ?? [],
    files: overrides.files ?? { pass: { sha256: 'a'.repeat(64) }, unsuccessful: null },
    logs: overrides.logs ?? {},
    ...overrides,
  };
}

test('F10 & F11 terminology constants match hub-terms canonical values', () => {
  assert.deepEqual(STATUS, {
    delivered: '交付',
    failed: '上机验证未通过',
    unsettled: '上机验证无结论',
    unrun: '未做上机验证',
  });
  assert.equal(CLOSING.author_conflict, '用例作者的原句与手册冲突（待用例作者或使用者裁定）');
  assert.deepEqual(REASONS, ['缺资料', '原始用例的问题', '编写模型的问题', '临时故障', '设备的问题', '还没查清']);
  assert.deepEqual(OWNERS, ['程序', '模型', '使用者']);
});

test('noteUserFacingProblems rejects internal identifiers, UTC timestamps, paths, protocol tokens, invented words, and malformed owners', () => {
  const longHex = 'f'.repeat(64);
  const badCases: Array<[string, Partial<Notes['cases'][string]>, RegExp]> = [
    ['rec reference', { judged: `依据 rec:${longHex} 得出结论` }, /包含内部编号或引用/],
    ['src reference', { remedy: `排查 src:${longHex}` }, /包含内部编号或引用/],
    ['tree reference', { judged: `手册树 tree:${longHex}/manual/foo` }, /包含内部编号或引用/],
    ['doc ref', { remedy: '核对 doc:doc:25365' }, /包含内部编号或引用/],
    ['usr id', { judged: '操作者 usr_abc1234' }, /包含内部编号或引用/],
    ['run id', { judged: '见 run_01aaaaaaaaaaaaaaaaaaaaaaaa' }, /包含内部编号或引用/],
    ['job id', { judged: `任务 job_${'0'.repeat(16)}` }, /包含内部编号或引用/],
    ['raw 64-hex', { judged: `摘要 ${longHex}` }, /包含内部编号或引用/],
    ['UTC timestamp', { judged: '2026-11-14T16:17:38.587Z 上机验证通过' }, /直接写出了世界时/],
    ['UTC time-only', { judged: '在 16:17:38Z 完成验证' }, /直接写出了世界时/],
    ['workspace notes path', { remedy: '参考 notes/run29.notes.json 的说明' }, /包含内部工作文件路径/],
    ['delivery.json path', { judged: '详见 delivery.json 统计' }, /包含内部工作文件路径/],
    ['dotted API path', { judged: '因为 parameters.exclude 已排除该项' }, /包含内部字段或协议英文词/],
    ['machine key=value', { judged: '目前 confidence=hypothesis 仍待查清' }, /包含内部字段或协议英文词/],
    ['protocol field predecessor', { judged: '继承了 predecessor 的参数' }, /包含内部字段或协议英文词/],
    ['protocol field cell_inputs', { judged: '缺失 cell_inputs 字段' }, /包含内部字段或协议英文词/],
    ['protocol word author_conflict', { judged: '触发 author_conflict 结办' }, /包含内部字段或协议英文词/],
    ['protocol word hypothesis', { judged: '这是模型提出的 hypothesis' }, /包含内部字段或协议英文词/],
    ['protocol word settled', { judged: '该项标记为 settled' }, /包含内部字段或协议英文词/],
    ['invented 开新修订', { remedy: '请先开新修订再重新编写' }, /使用了自造流程词/],
    ['invented 重新育苗', { remedy: '需要重新育苗' }, /使用了自造流程词/],
    ['invented 脑图编译', { judged: '本次脑图编译完成' }, /使用了自造流程词/],
    ['vague 产品侧', { remedy: '交由产品侧确认原因' }, /使用了泛称/],
    ['vague 相关方', { remedy: '由相关方决定后续处理' }, /使用了泛称/],
    ['retired 重交', { remedy: '改完后重新做重交' }, /使用了已淘汰词/],
    ['retired 重写', { remedy: '把这段脚本重写一遍' }, /使用了已淘汰词/],
    ['non-standard 待补资料', { judged: '当前状态是待补资料' }, /使用了非标准说法/],
    ['standalone 用户', { remedy: '请通知用户确认参数值' }, /使用了“用户”/],
    ['bare 上机', { judged: '上次上机结果不可用' }, /使用了被替代旧词「上机」/],
    ['owner placed in judged', { judged: '模型判定如此。决定者：模型。' }, /不应填写「决定者」/],
    ['owner placed in defect_candidate.repro', { defect_candidate: { repro: '执行步骤后检查。决定者：使用者。', expected: '预期输出', actual: '实际输出' } }, /不应填写「决定者」/],
    ['duplicate 决定者 in remedy', { remedy: '先由使用者核对。决定者：使用者。或再看决定者：程序。' }, /多次出现「决定者」/],
    ['compound 决定者', { remedy: '请核对配置。决定者：使用者＋程序。' }, /不合规范/],
    ['equals sign in 决定者', { remedy: '请核对配置。决定者＝模型' }, /不合规范/],
    ['parenthetical 决定者', { remedy: '请核对配置。决定者：使用者（产品侧）' }, /不合规范/],
    ['bare owner without remedy action', { remedy: '决定者：使用者。' }, /仅写了决定者而缺少实际「下一步」动作/],
  ];

  for (const [label, partial, expected] of badCases) {
    const notes: Notes = {
      cases: {
        c1: {
          judged: partial.judged ?? '上机验证未通过，按命令回显需要核对参数范围。',
          remedy: partial.remedy ?? '由编写模型根据本地时间 2026-11-15 00:17 的结果修改后再次上机验证。',
          ...(partial.defect_candidate ? { defect_candidate: partial.defect_candidate } : {}),
        },
      },
    };
    const problems = noteUserFacingProblems(notes);
    assert.ok(problems.some((p) => expected.test(p)), `${label}: expected match ${expected}, got ${JSON.stringify(problems)}`);
  }
});

test('noteUserFacingProblems allows clean prose, allowed compounds like 用户名/多用户/上机验证, single owner in remedy, and exempt verbatim evidence fields', () => {
  const longHex = 'a'.repeat(64);
  const notes: Notes = {
    cases: {
      c1: {
        judged: '多用户场景下用户名认证失败；已查过上机验证和未做上机验证的记录，原因还没查清，待用例作者与使用者确认。',
        remedy: '由编写模型对照环境维护者给出的设备配置再改写后上机验证。决定者：模型。',
        evidence: `2026-11-14T16:17:38.587Z run_01aaaaaaaaaaaaaaaaaaaaaaaa tree:${longHex}/x parameters.foo 用户 上机`,
        defect_candidate: {
          repro: '在多用户视图配置用户名并下发查询命令。',
          expected: '用户 user1 参数 parameters.user=ok',
          actual: `2026-11-14T16:17:38.587Z Error: run_01aaaaaaaaaaaaaaaaaaaaaaaa ${longHex}`,
        },
      },
      c2: {
        judged: '未做上机验证，原始用例的原句与手册冲突。',
        remedy: '由使用者对照手册原话决定是否修改原始用例。',
        author_conflict: {
          author: '配置用户参数上机检测',
          manual: 'parameters.exclude 与 doc:123 说明不一致',
          reference: `tree:${longHex}/manual/guide@${'b'.repeat(64)}`,
        },
      },
    },
  };
  assert.deepEqual(noteUserFacingProblems(notes), []);
});

test('F1, F2, F3 & F14 caseConclusion formats next step colon, single owner without double periods, and discloses conflicting model reason', () => {
  const outcomeFailed: CaseOutcome = {
    autoid: 'c2',
    status: 'failed',
    history: [{ ordinal: 4, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'fail' }],
  };
  const outcomeExhausted: CaseOutcome = {
    autoid: 'c3',
    status: 'failed',
    rounds: 3,
    closing: 'authoring_failure',
    history: [
      { ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'fail' },
      { ordinal: 3, run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', job: 'j'.repeat(64), terminal: 'fail' },
      { ordinal: 5, run: 'run_01cccccccccccccccccccccccc', job: 'j'.repeat(64), terminal: 'fail' },
    ],
  };

  // F1 & F2 & F3: `下一步：` present, single `决定者：...。`, no `。。`, strips embedded `决定者` cleanly.
  const input = makeInput({
    assembly: {
      cases: [
        { autoid: 'c1', status: 'delivered', history: [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'pass' }] },
        outcomeFailed,
        outcomeExhausted,
      ],
      pass: null,
      unsuccessful: null,
      totals: { cases: 3, delivered: 1, failed: 2, unsettled: 0, unrun: 0 },
    },
    notes: {
      cases: {
        c2: {
          judged: '错误：临时故障；设备接口瞬时超时。',
          remedy: '下一步：由环境维护者检查链路后重新上机验证。决定者：使用者。',
        },
        c3: {
          judged: '判断错误，原因设备的问题；设备没有按预期回显。',
          remedy: '请使用者联系产品包内容维护者排查设备状态。',
        },
      },
    },
  });

  const c1Line = caseConclusion(input, input.assembly.cases[0]);
  assert.equal(c1Line, '原始用例 c1 合成标题一，自动化用例 Excel 已完成上机验证，状态已确认，判断正确。决定者：程序。');

  const c2Line = caseConclusion(input, outcomeFailed);
  assert.ok(c2Line.includes('原因还没查清，下一步：由环境维护者检查链路后重新上机验证。决定者：使用者。'));
  assert.ok(!c2Line.includes('。。'), `unexpected double period: ${c2Line}`);
  assert.equal(c2Line.match(/决定者：/g)?.length, 1);
  // F14: model stated closed reason `临时故障`, while unclosed failure records `还没查清`.
  assert.ok(c2Line.includes('（模型自述原因是临时故障；按规则，未取得可确认依据前暂记还没查清，以程序规则记还没查清为准。）'));

  const c3Line = caseConclusion(input, outcomeExhausted);
  assert.ok(c3Line.includes('已改写自动化用例 3 次'));
  assert.ok(c3Line.includes('原因编写模型的问题，下一步：请使用者联系产品包内容维护者排查设备状态。决定者：程序。'));
  // F14: model stated `设备的问题`, while 3-round authoring_failure records `编写模型的问题`.
  assert.ok(c3Line.includes('（模型自述原因是设备的问题；按规则，改写 3 次后上机验证仍未正确，以程序规则记编写模型的问题为准。）'));

  // No reconciliation note when extractModelReason finds prose without closed reason or matches toolReason.
  assert.equal(extractModelReason('第 2 步命令行返回超时，需要补查设备侧日志。'), null);
  assert.equal(extractModelReason('原因：编写模型的问题。'), '编写模型的问题');
  const matchingInput = makeInput({
    notes: { cases: { c3: { judged: '错误：编写模型的问题，脚本漏配前缀命令。', remedy: '请使用者处理' } } },
  });
  const matchingLine = caseConclusion(matchingInput, outcomeExhausted);
  assert.ok(!matchingLine.includes('模型自述原因是'), `should not append reconciliation when reasons match: ${matchingLine}`);
});

test('F4 timeline counts per-case verification runs rather than batch dispatch ordinals', () => {
  const singleLateBatch: CaseOutcome = {
    autoid: 'c2',
    status: 'failed',
    history: [{ ordinal: 4, run: 'run_01dddddddddddddddddddddddd', job: 'j'.repeat(64), terminal: 'fail' }],
  };
  assert.equal(timeline(singleLateBatch, false), '第 1 次上机验证判断错误。');

  const multiSparseBatches: CaseOutcome = {
    autoid: 'c2',
    status: 'unsettled',
    history: [
      { ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'fail' },
      { ordinal: 2, run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', job: 'j'.repeat(64), terminal: 'pass', audit: { where: 'run.log', line: 'Command failed' } },
      { ordinal: 5, run: 'run_01cccccccccccccccccccccccc', job: 'j'.repeat(64), terminal: 'no_verdict' },
    ],
  };
  assert.equal(
    timeline(multiSparseBatches, false),
    '本条原始用例共上机验证 3 次：第 1 次上机验证判断错误；第 2 次上机验证状态未知，设备输出有执行失败原话“Command failed”，自动化用例没有检查这一行；第 3 次上机验证判断未知。',
  );
  assert.equal(timeline({ autoid: 'c3', status: 'unrun', history: [] }, true), '未做上机验证，这条原始用例未完成脚本编写。');
  assert.equal(timeline({ autoid: 'c3', status: 'unrun', history: [] }, false), '未做上机验证。');
});

test('F5, F10, F11, F13 deliveryReport and unsuccessfulReport handle unrun evidence, singular/plural head summary, and updated headings', () => {
  const singleUnsuccessful = makeInput({
    assembly: {
      cases: [
        { autoid: 'c1', status: 'delivered', history: [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'pass' }] },
        { autoid: 'c2', status: 'failed', rounds: 3, closing: 'authoring_failure', history: [{ ordinal: 1, run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), terminal: 'fail' }, { ordinal: 2, run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', job: 'j'.repeat(64), terminal: 'fail' }, { ordinal: 3, run: 'run_01cccccccccccccccccccccccc', job: 'j'.repeat(64), terminal: 'fail' }] },
        { autoid: 'c3', status: 'unrun', closing: 'author_conflict', history: [], conflict: { author: '配置用户模式为本地', manual: '该版本手册不支持本地用户模式', reference: `tree:${'a'.repeat(64)}/manual/x@${'b'.repeat(64)}` } },
      ],
      pass: { run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', job: 'j'.repeat(64), plan_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', sha256: 'a'.repeat(64), items: ['c1'], rows: [] },
      unsuccessful: { items: ['c2'], sources: {} },
      totals: { cases: 3, delivered: 1, failed: 1, unsettled: 0, unrun: 1 },
    },
    files: { pass: { sha256: 'a'.repeat(64) }, unsuccessful: { sha256: 'b'.repeat(64) } },
    notes: {
      cases: {
        c2: { judged: '原因还没查清，第 3 次上机验证仍提示预期未命中。', remedy: '请编写模型补充前置步骤再试', evidence: 'Error: assert failed' },
        c3: { judged: '原始用例写的配置模式被手册排除。', remedy: '待使用者决定', evidence: '补充核对引文：配置仅支持远端模式。', author_conflict: { author: '配置用户模式为本地', manual: '该版本手册不支持本地用户模式', reference: `tree:${'a'.repeat(64)}/manual/x@${'b'.repeat(64)}` } },
      },
    },
    passAudit: { markers: null, read: 1, downgraded: 0, wordless: 0 },
    logs: { c3: { reference: 'x', job: 'y', text: null, withheld: '本次没有做上机验证' } },
  });

  const report = deliveryReport(singleUnsuccessful);
  // F13 singular wording for 1 unsuccessful item
  assert.ok(report.includes('另有 1 条判断错误的原始用例（c2），unsuccessful_cases.xlsx 放的是它最近一次改写后的自动化用例，没有并入本次一起上机验证的那份 Excel。'));
  assert.ok(!report.includes('它们各自'));
  // F1 & F3 in head() passAudit line
  assert.ok(report.includes('下一步：由使用者补齐执行器规则，再核对设备输出。决定者：程序。'));
  // F5: ran case c2 gets **证据，设备输出**; unrun case c3 never gets **证据，设备输出**
  const c2Part = report.slice(report.indexOf('## 原始用例 c2'), report.indexOf('## 原始用例 c3'));
  const c3Part = report.slice(report.indexOf('## 原始用例 c3'));
  assert.ok(c2Part.includes('**证据，设备输出**，已按照规则核对设备输出。'));
  assert.ok(!c3Part.includes('**证据，设备输出**'), `unrun case must not claim device output: ${c3Part}`);
  assert.ok(c3Part.includes('**证据，手册核对补充引文**（未做上机验证，无设备输出）。'));
  assert.ok(c3Part.includes('**证据，原始用例原句**，已按照规则核对原文。'));
  assert.ok(c3Part.includes('**证据，手册原话**，构建 SYNTH-BUILD-1，已按照规则核对原文。'));

  const longReport = unsuccessfulReport(singleUnsuccessful);
  assert.ok(longReport.includes('**设备输出**。状态未知，原因还没查清，本次没有做上机验证；下一步：由使用者补齐设备输出。'));

  // Verify plural wording when >1 unsuccessful item and updated closingLine
  const plural = makeInput({
    assembly: {
      ...singleUnsuccessful.assembly,
      unsuccessful: { items: ['c2', 'c3'], sources: {} },
    },
    files: singleUnsuccessful.files,
    notes: singleUnsuccessful.notes,
  });
  const pluralReport = deliveryReport(plural);
  assert.ok(pluralReport.includes('另有 2 条仍有错误或未知的原始用例（c2、c3），unsuccessful_cases.xlsx 放的是它们各自最近一次改写后的自动化用例，没有并入本次一起上机验证的那份 Excel。'));

  const conflictLine = closingLine(singleUnsuccessful.assembly.cases[2]);
  assert.ok(conflictLine?.startsWith(CLOSING.author_conflict));
  assert.ok(conflictLine?.includes('它未做上机验证，裁定前不再为它做上机验证'));
});
