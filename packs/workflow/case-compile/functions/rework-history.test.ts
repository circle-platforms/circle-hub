// Unit tests for single-case prior-round history extraction, 12,000-char truncation disclosure, and same-error streak analysis.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AMBIGUOUS_STEP_MSG,
  analyzeRoundHistory,
  buildCaseIdSet,
  consecutiveRepeatedGateCodes,
  decodeHorizontalScrollRedraw,
  diffPlanSnapshots,
  extractCaseDeviceEvidence,
  MISSING_EVIDENCE_CAVEAT,
  MISSING_STEP_NOT_FOUND_MSG,
  MISSING_STEP_TRUNCATION_MSG,
  parseGateRefusalsFromAnswer,
  parseHubAnswerNotices,
  parsePriorAttribution,
  parsePriorPlanSnapshot,
  renderPriorRoundsMarkdown,
  sanitizeHubAnswerField,
  SESSION_RETAINED_CHARS,
} from './rework-history.ts';
import { buildCompileBrief, renderCompileBriefMd, validateCompileBrief } from './authoring-brief.ts';

const CASE_ID = '990000000000000301';
const OTHER_CASE_ID = '990000000000000399';

function makePlan(item: string, cmd1: string, cmd2: string, expectText: string, cleanupCmd?: string) {
  return {
    item,
    handling: 'handled',
    slots: {
      plan: [
        {
          text: '合成测试计划',
          quotes: [{ reference: 'src:' + '1'.repeat(64) + '/kityminder@1/n/e1', text: '合成期望' }],
          data: {
            bucket: 'bed-a',
            blocks: [],
            replacements: [{ case: '192.0.2.50', bed: '192.0.2.10' }],
            steps: [
              { object: 'dut0', method: 'exec', args: [cmd1], keywords: {}, description: '第一步配置' },
              { object: 'dut0', method: 'exec', args: [cmd2], keywords: {}, description: '第二步查询' },
              ...(cleanupCmd
                ? [{ object: 'dut0', method: 'exec', args: [cleanupCmd], keywords: {}, description: '清理', cleanup: true }]
                : []),
            ],
            expects: [
              {
                text: expectText,
                quote: { reference: 'src:' + '1'.repeat(64) + '/kityminder@1/n/e1', text: '合成期望' },
                after: 2,
              },
            ],
          },
        },
      ],
    },
  };
}

test('plan snapshots refuse cross-case files and compute crisp chronological diffs', () => {
  const ids = buildCaseIdSet(CASE_ID, { id: `case-${CASE_ID}`, fields: { autoid: CASE_ID } });
  const r1 = parsePriorPlanSnapshot(
    makePlan(CASE_ID, 'widget sync to peer-a', 'show widget sync', 'peer-a online', 'no widget sync'),
    ids,
    'plans-r1/00.json',
  );
  const r2 = parsePriorPlanSnapshot(
    makePlan(CASE_ID, 'widget sync to peer_a', 'show widget sync', 'peer_a online', 'no widget sync'),
    ids,
    'plans-r2/00.json',
  );
  assert.equal(r1.steps.length, 3);
  assert.equal(r1.expects.length, 1);

  const diff = diffPlanSnapshots(r1, r2, 1, 2);
  assert.equal(diff.unchanged, false);
  assert.equal(diff.modified.length, 2);
  assert.ok(diff.lines.some((l) => l.includes('peer-a') && l.includes('peer_a')));
  assert.equal(diffPlanSnapshots(r1, r1, 1, 2).unchanged, true);

  assert.throws(
    () => parsePriorPlanSnapshot(makePlan(OTHER_CASE_ID, 'show widget', 'show widget', 'ok'), ids, 'plans-r1/01.json'),
    /禁止混入其他用例计划/,
  );
});

test('device evidence extracts matched failing step excerpts and discloses missing steps truncated outside tail 12,000 chars', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const plan = parsePriorPlanSnapshot(
    makePlan(CASE_ID, 'widget broken-early-step', 'show widget summary', 'Summary', 'no widget reset'),
    ids,
  );

  // Gateway keeps trailing <= 12,000 chars: early step `widget broken-early-step` was cut from head,
  // while trailing output holds cleanup lines and `show widget summary`.
  const filler = Array.from({ length: 600 }, (_, i) => `seat# noise line ${String(i).padStart(3, '0')} ok`).join('\n');
  const sessionBody = [
    filler,
    'seat#show widget summary',
    'Error: rule missing before summary',
    'seat#no widget reset',
    'seat#',
  ].join('\n');
  const retainedTail = sessionBody.slice(-SESSION_RETAINED_CHARS);
  assert.ok(retainedTail.length <= SESSION_RETAINED_CHARS && !retainedTail.includes('widget broken-early-step'));

  const returnsIndex = {
    schema: 'device-returns@1',
    run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
    jobs: [
      {
        job: 'c'.repeat(64),
        verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
        rows: [
          {
            item: OTHER_CASE_ID,
            verdict: 'fail',
            syntax_rejected: [{ session: 'dut0.txt', command: 'secret other case cmd', token: 'secret', prompt: 'seat#' }],
          },
          {
            item: CASE_ID,
            verdict: 'fail',
            runner_verdict: 'fail',
            log: 'c'.repeat(12) + `/cases/${CASE_ID}/log.txt`,
            sessions: { 'dut0.txt': 'c'.repeat(12) + `/cases/${CASE_ID}/dut0.txt` },
            syntax_rejected: [{ session: 'dut0.txt', command: 'widget broken-early-step', token: 'widget', prompt: 'seat#' }],
            execution_refused: [
              {
                session: 'dut0.txt',
                prompt: 'seat#',
                command: 'show widget summary',
                reply: ['Error: rule missing before summary'],
              },
            ],
          },
        ],
      },
    ],
  };

  const ev = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex,
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: retainedTail }]]),
    logText: 'step 1 dispatched widget broken-early-step\nstep 2 failed: rule missing before summary\n',
    logPath: 'log.txt',
    priorPlan: plan,
  })!;

  assert.ok(ev);
  assert.ok(!JSON.stringify(ev).includes('secret other case cmd'), 'other case never leaks');
  assert.ok(ev.inlineTail.length <= 6000);
  assert.ok(ev.anomalyLines.length <= 5);

  const missingStep = ev.stepExcerpts.find((s) => s.commandText === 'widget broken-early-step');
  assert.ok(missingStep);
  assert.equal(missingStep.found, false);
  assert.equal(missingStep.missingNotice, MISSING_STEP_TRUNCATION_MSG);

  const foundStep = ev.stepExcerpts.find((s) => s.commandText === 'show widget summary');
  assert.ok(foundStep && foundStep.found);
  assert.ok(foundStep.excerpt?.includes('Error: rule missing before summary'));
});

test('gate refusals and prior attributions isolate a single case and pin hypothesis confidence', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const answerText = [
    `用例 ${OTHER_CASE_ID} CONFLICTING_CLEANUP：不应该出现`,
    `用例 ${CASE_ID} INVALID_SYNTAX 路径 /slots/plan/0/data/steps/1：命令参数越界`,
    `修复：改按手册范围填写 1..60`,
  ].join('\n');
  const gates = parseGateRefusalsFromAnswer(answerText, ids, 1);
  assert.equal(gates.length, 1);
  assert.equal(gates[0].code, 'INVALID_SYNTAX');
  assert.ok(!gates[0].message.includes(OTHER_CASE_ID));

  const notes = {
    cases: {
      [OTHER_CASE_ID]: { judged: '其他用例失败', remedy: '忽略' },
      [CASE_ID]: { judged: '未生效原因疑为参数字符非法', remedy: '改为字母数字组合', evidence: 'Error: bad arg' },
    },
  };
  const attr = parsePriorAttribution(notes, ids, 1, 'notes-r1.json');
  assert.ok(attr);
  assert.equal(attr.confidence, 'hypothesis');
  assert.equal(attr.round, null, 'notes without `round` never invent a round number from CLI position');
  assert.equal(attr.roundRecorded, false);
  assert.equal(attr.judged, '未生效原因疑为参数字符非法');

  const notesWithRound = {
    round: 2,
    cases: {
      [CASE_ID]: { round: 2, judged: '第二次确认前置顺序有误', remedy: '先开启全局开关' },
    },
  };
  const recordedAttr = parsePriorAttribution(notesWithRound, ids, null, 'notes-r2.json');
  assert.ok(recordedAttr);
  assert.equal(recordedAttr.round, 2);
  assert.equal(recordedAttr.roundRecorded, true);
  assert.equal(parsePriorAttribution({ item: OTHER_CASE_ID, judged: 'x', remedy: 'y' }, ids, 1, 'other.json'), null);
});

test('consecutive same-error streak counts matching rounds, sets vary_form_required, and renders round changes verbatim', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const p1 = parsePriorPlanSnapshot(makePlan(CASE_ID, 'widget mode a-1', 'show widget', 'mode a-1'), ids);
  const p2 = parsePriorPlanSnapshot(makePlan(CASE_ID, 'widget mode a_2', 'show widget', 'mode a_2'), ids);

  const rounds = [
    {
      round: 1,
      planSource: 'plans-r1/00.json',
      plan: p1,
      gateRefusals: [],
      errorSignatures: ['exec_refused:show widget:Error: missing rule'],
      attribution: {
        round: 1,
        roundRecorded: true,
        sourceFile: 'notes-r1.json',
        confidence: 'hypothesis' as const,
        judged: '可能缺少初始化',
        remedy: '改为下划线参数',
        evidenceQuotes: ['Error: missing rule'],
      },
    },
    {
      round: 2,
      planSource: 'plans-r2/00.json',
      plan: p2,
      gateRefusals: [],
      errorSignatures: ['exec_refused:show widget:Error: missing rule'],
      attribution: {
        round: 2,
        roundRecorded: true,
        sourceFile: 'notes-r2.json',
        confidence: 'hypothesis' as const,
        judged: '同一错误再次发生',
        remedy: '改查手册前置',
        evidenceQuotes: ['Error: missing rule'],
      },
    },
  ];

  const streak = analyzeRoundHistory({ currentRound: 3, rounds });
  assert.equal(streak.consecutiveSameError, 2);
  assert.equal(streak.finalAttempt, true);
  // InfoTest provenance (`remedies.py:39-42`, `briefs.py:2792-2820`): non-frozen device errors report consecutive streak without auto-forcing vary_form.
  assert.equal(streak.varyFormRequired, false);
  assert.equal(streak.roundChanges.length, 1);

  const md = renderPriorRoundsMarkdown({ caseRef: CASE_ID, currentRound: 3, rounds, streak });
  assert.ok(md.includes('第 3 轮'));
  assert.ok(md.includes('最后一次机会'));
  assert.ok(!md.includes('FINAL attempt'), 'never leak bare English FINAL attempt prose');
  assert.ok(md.includes(MISSING_EVIDENCE_CAVEAT));
  assert.ok(md.includes('连续 2 轮命中同类错误'));
  assert.ok(md.includes('不替代编写模型/分析模型的独立判断'));
  assert.ok(md.includes('widget mode a-1') && md.includes('widget mode a_2'));
  assert.ok(md.includes('confidence: "hypothesis"'));

  const frozenRounds = [
    rounds[0],
    { ...rounds[1], attribution: { ...rounds[1].attribution, disposition: 'frozen' } },
  ];
  const frozenStreak = analyzeRoundHistory({ currentRound: 3, rounds: frozenRounds });
  assert.equal(frozenStreak.varyFormRequired, true);
});

test('D1: parseGateRefusalsFromAnswer parses multi-line submit_result JSON cleanly without dumping 500KB payload, and capper omits in fixed order', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const padding = 'x'.repeat(500_000);
  const submitPayload = {
    call_result: 'partial',
    original_cases: [
      { id: 'doc-1:c-1', autoid: CASE_ID, title: '主用例', raw: padding },
      { id: 'doc-1:c-2', autoid: OTHER_CASE_ID, title: '别案', raw: padding },
    ],
    errors: [
      { item: OTHER_CASE_ID, code: 'WRONG_CASE_CODE', pointer: '/slots/plan/0', message: '不应泄露的别案错误', fix: '无' },
      { item: CASE_ID, code: 'UNRESOLVED_COMMAND', pointer: '/slots/plan/0/data/steps/1', message: '命令未命中手册', fix: '改查手册命令节点' },
    ],
    result: {
      partitions: {
        rejected: [
          {
            code: 'PARTITION_REFUSAL',
            items: [{ autoid: CASE_ID, pointer: '/slots/plan/0/data/expects/0', message: '期望缺引用', fix: '补充 quote' }],
          },
        ],
      },
    },
  };
  const multiLineAnswer = [
    `已接收 1 条，拒绝 1 条（用例 ${OTHER_CASE_ID} 拒绝）`,
    `用例 ${CASE_ID} UNRESOLVED_COMMAND /slots/plan/0/data/steps/1`,
    '供模型引用',
    JSON.stringify(submitPayload),
  ].join('\n');

  const gates = parseGateRefusalsFromAnswer(multiLineAnswer, ids, 1);
  assert.equal(gates.length, 2);
  assert.ok(gates.every((g) => g.message.length < 500));
  assert.ok(!JSON.stringify(gates).includes('WRONG_CASE_CODE'));
  assert.ok(!JSON.stringify(gates).includes(OTHER_CASE_ID));

  // If THIS case passed while trailing JSON still mentions CASE_ID in `original_cases`, must return [] rather than dumping raw JSON line!
  const cleanPayload = {
    call_result: 'ok',
    original_cases: [{ id: 'doc-1:c-1', autoid: CASE_ID, title: '主用例', raw: padding }],
    errors: [{ item: OTHER_CASE_ID, code: 'OTHER_ERR', message: '其他案错误', fix: '' }],
    result: { partitions: { accepted: [{ autoid: CASE_ID }] } },
  };
  const cleanMultiLine = [`用例 ${CASE_ID} 已接收`, '供模型引用', JSON.stringify(cleanPayload)].join('\n');
  assert.deepEqual(parseGateRefusalsFromAnswer(cleanMultiLine, ids, 1), []);

  // Fixed omission order capper
  const p1 = parsePriorPlanSnapshot(makePlan(CASE_ID, 'cmd one', 'cmd two', 'exp'), ids);
  const mdCapped = renderPriorRoundsMarkdown({
    caseRef: CASE_ID,
    currentRound: 2,
    maxChars: 2400,
    rounds: [
      {
        round: 1,
        planSource: 'p1.json',
        plan: p1,
        gateRefusals: gates,
        errorSignatures: ['gate:UNRESOLVED_COMMAND'],
        deviceEvidence: {
          round: 1,
          verificationRun: 'run_01',
          job: 'j'.repeat(64),
          verdict: 'fail',
          passReview: null,
          logFile: 'log.txt',
          sessionFiles: { 'dut0.txt': 'dut0.txt' },
          sessionLengths: { 'dut0.txt': 11500 },
          syntaxRejected: [],
          executionRefused: [],
          stepExcerpts: [
            { stepIndex: 1, stepSummary: 'cmd one', commandText: 'cmd one', source: 'plan_step', found: true, sessionName: 'dut0.txt', excerpt: 'A'.repeat(1600) },
          ],
          inlineTail: 'T'.repeat(3000),
          logExcerpt: 'L'.repeat(2500),
          anomalyLines: ['#### Fail Num 1: critical line'],
          errorSignatures: ['exec_fail:critical'],
          withheldNotes: [],
        },
        attribution: null,
      },
    ],
    unrecordedAttribution: {
      round: null,
      roundRecorded: false,
      sourceFile: 'notes.json',
      confidence: 'hypothesis',
      judged: '关键归因结论不可被截断',
      remedy: '必须保留归因建议',
      evidenceQuotes: [],
    },
    streak: analyzeRoundHistory({ currentRound: 2, rounds: [] }),
  });
  assert.ok(mdCapped.length <= 2400, `expected <= 2400, got ${mdCapped.length}`);
  assert.ok(mdCapped.includes('历史上下文篇幅控制与省略披露'));
  assert.ok(mdCapped.includes('设备会话末尾原话摘录'));
  assert.ok(mdCapped.includes('关键归因结论不可被截断'));
  assert.ok(mdCapped.includes(MISSING_EVIDENCE_CAVEAT));
});

test('D4: step locator avoids 24-char prefix collisions, handles APV redraw & duplicate occurrences, and flags ambiguous steps', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const plan = parsePriorPlanSnapshot({
    item: CASE_ID,
    handling: 'handled',
    slots: {
      plan: [{
        text: 'prefix + redraw + duplicate steps',
        quotes: [],
        data: {
          bucket: 'bed-a',
          blocks: [],
          replacements: [],
          steps: [
            { object: 'dut0', method: 'exec', args: ['show dns record-config -t A -n alpha.example.test'], keywords: {} },
            { object: 'dut0', method: 'exec', args: ['show dns record-config -t CNAME -n beta.example.test'], keywords: {} },
            { object: 'dut0', method: 'exec', args: ['show gslb dnssec-key 256 ZSK example.test'], keywords: {} },
            { object: 'dut0', method: 'exec', args: ['check sync status'], keywords: {} },
            { object: 'dut0', method: 'exec', args: ['check sync status'], keywords: {} },
          ],
          expects: [],
        },
      }],
    },
  }, ids);

  const sessionText = [
    'apv#show dns record-config -t A -n alpha.example.test',
    'A addr = 192.0.2.10',
    'apv#show dns record-config -t CNAME -n beta.example.test',
    'CNAME target = gw.example.test',
    'apv#show gslb dnssec-key$k 256 ZSK example.test',
    'ZSK active',
    'apv#check sync status',
    'first check: sync pending',
    'apv#check sync status',
    'second check: sync done',
    'apv#',
  ].join('\n');

  const ev = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: {
      schema: 'device-returns@1',
      run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
      jobs: [{ job: 'e'.repeat(64), verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'apv.txt': 'apv.txt' } }] }],
    },
    caseIds: ids,
    sessionTexts: new Map([['apv.txt', { path: 'apv.txt', text: sessionText }]]),
    logText: null,
    logPath: null,
    priorPlan: plan,
  })!;

  const s1 = ev.stepExcerpts.find((s) => s.stepIndex === 1)!;
  const s2 = ev.stepExcerpts.find((s) => s.stepIndex === 2)!;
  const s3 = ev.stepExcerpts.find((s) => s.stepIndex === 3)!;
  const s4 = ev.stepExcerpts.find((s) => s.stepIndex === 4)!;
  const s5 = ev.stepExcerpts.find((s) => s.stepIndex === 5)!;
  assert.ok(s1.found && s1.excerpt?.includes('A addr = 192.0.2.10'), 'step 1 matches -t A, never -t CNAME');
  assert.ok(s2.found && s2.excerpt?.includes('CNAME target = gw.example.test'), 'step 2 matches -t CNAME, never -t A');
  assert.ok(s3.found && s3.excerpt?.includes('ZSK active'), 'step 3 handles terminal $ redraw preserving ZSK token');
  assert.ok(s4.found && s4.excerpt?.includes('first check: sync pending'), 'first duplicate occurrence binds to step 4');
  assert.ok(s5.found && s5.excerpt?.includes('second check: sync done'), 'second duplicate occurrence binds to step 5');

  // If count of repeated command occurrences mismatches in the window (3 occurrences for 2 plan steps without separating anchor), refuse guessing!
  const ambiguousEv = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: {
      schema: 'device-returns@1',
      run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
      jobs: [{ job: 'e'.repeat(64), verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'apv.txt': 'apv.txt' } }] }],
    },
    caseIds: ids,
    sessionTexts: new Map([['apv.txt', {
      path: 'apv.txt',
      text: `${sessionText}\napv#check sync status\nthird check: extra occurrence\napv#\n`,
    }]]),
    logText: null,
    logPath: null,
    priorPlan: plan,
  })!;
  const amb4 = ambiguousEv.stepExcerpts.find((s) => s.stepIndex === 4)!;
  assert.equal(amb4.found, false);
  assert.equal(amb4.ambiguous, true);
  assert.equal(amb4.missingNotice, AMBIGUOUS_STEP_MSG);
});

test('D2 & Section 6: short missing steps cite not-found (not 12,000 truncation), ~11,371 truncated session cites 12,000, and plan/returns mismatch throws', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const plan = parsePriorPlanSnapshot(makePlan(CASE_ID, 'widget setup-early', 'show widget summary', 'ok'), ids);
  const shortSession = 'apv#show widget summary\nStatus: active\napv#\n';

  const shortEv = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: {
      schema: 'device-returns@1',
      run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
      jobs: [{ job: 'e'.repeat(64), verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'dut0.txt': 'dut0.txt' } }] }],
    },
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: shortSession }]]),
    logText: null,
    logPath: null,
    priorPlan: plan,
  })!;
  const earlyMissing = shortEv.stepExcerpts.find((s) => s.commandText === 'widget setup-early')!;
  assert.equal(earlyMissing.found, false);
  assert.equal(earlyMissing.missingNotice, MISSING_STEP_NOT_FOUND_MSG);

  // Near-12,000 byte normalized transcript (e.g. ~11,400 chars from CRLF/control normalization) still qualifies as gateway tail truncation!
  const near12kBody = Array.from({ length: 505 }, (_, i) => `apv#noise line ${String(i).padStart(3, '0')} ok`).join('\n')
    + '\napv#show widget summary\nStatus: fail\napv#\n';
  assert.ok(near12kBody.length >= 11_000 && near12kBody.length < 12_000);
  const nearEv = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: {
      schema: 'device-returns@1',
      run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
      jobs: [{ job: 'e'.repeat(64), verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'dut0.txt': 'dut0.txt' } }] }],
    },
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: near12kBody }]]),
    logText: null,
    logPath: null,
    priorPlan: plan,
  })!;
  const nearMissing = nearEv.stepExcerpts.find((s) => s.commandText === 'widget setup-early')!;
  assert.equal(nearMissing.missingNotice, MISSING_STEP_TRUNCATION_MSG);

  // Mismatched run or un-truncated session executing unrelated commands refuses brief generation!
  assert.throws(() => extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: {
      schema: 'device-returns@1',
      run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
      jobs: [{ job: 'e'.repeat(64), verification_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'dut0.txt': 'dut0.txt' } }] }],
    },
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: 'apv#unrelated cmd\nok\napv#\n' }]]),
    logText: null,
    logPath: null,
    priorPlan: plan,
  }), /不属于同一次运行/);
});

test('D5 & D6: NOERROR/free-text never triggers false streak, normalized framework/contract failures match across rounds, and unrecorded notes never forge round 1', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const plan = parsePriorPlanSnapshot(makePlan(CASE_ID, 'widget on', 'show dns query', 'NOERROR'), ids);

  const mkReturns = (runId: string) => ({
    schema: 'device-returns@1',
    run: runId,
    jobs: [{ job: 'f'.repeat(64), verification_run: runId, rows: [{ item: CASE_ID, verdict: 'fail', sessions: { 'dut0.txt': 'dut0.txt' }, log: 'log.txt' }] }],
  });

  // Benign DNS `NOERROR` output produces 0 false error signatures / anomalies and generic `device_verdict:fail` never triggers a false consecutive streak!
  const benignEv = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: mkReturns('run_01aaaaaaaaaaaaaaaaaaaaaaaa'),
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: 'apv#show dns query\n;; status: NOERROR, id: 1001\napv#\n' }]]),
    logText: 'dispatched show dns query\n;; ->>HEADER<<- opcode: QUERY, status: NOERROR, id: 49684, no error found\n',
    logPath: 'log.txt',
    priorPlan: plan,
  })!;
  assert.deepEqual(benignEv.anomalyLines, []);
  assert.deepEqual(benignEv.errorSignatures, ['device_verdict:fail']);
  const falseStreakCheck = analyzeRoundHistory({
    currentRound: 3,
    rounds: [
      { round: 1, plan, deviceEvidence: benignEv, gateRefusals: [], attribution: null, errorSignatures: benignEv.errorSignatures },
      { round: 2, plan, deviceEvidence: benignEv, gateRefusals: [], attribution: null, errorSignatures: benignEv.errorSignatures },
    ],
  });
  assert.equal(falseStreakCheck.consecutiveSameError, 1);
  assert.equal(falseStreakCheck.varyFormRequired, false);

  // Framework `#### Fail Num <n>:` + dynamic DNS id + timestamp normalize identically across Round 1 and Round 2!
  const evR1 = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex: mkReturns('run_01aaaaaaaaaaaaaaaaaaaaaaaa'),
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: 'apv#show dns query\nfailed\napv#\n' }]]),
    logText: '#### Fail Num 1: assert expect failed at Mon Nov 14 15:00:01 2026 id: 49684 rc=0x1a2b\n',
    logPath: 'log.txt',
    priorPlan: plan,
  })!;
  const evR2 = extractCaseDeviceEvidence({
    round: 2,
    returnsIndex: mkReturns('run_01bbbbbbbbbbbbbbbbbbbbbbbb'),
    caseIds: ids,
    sessionTexts: new Map([['dut0.txt', { path: 'dut0.txt', text: 'apv#show dns query\nfailed\napv#\n' }]]),
    logText: '#### Fail Num 2: assert expect failed at Mon Nov 14 15:08:19 2026 id: 51209 rc=0x1a2b\n',
    logPath: 'log.txt',
    priorPlan: plan,
  })!;
  assert.equal(evR1.errorSignatures.length, 1);
  assert.deepEqual(evR1.errorSignatures, evR2.errorSignatures);

  const streak = analyzeRoundHistory({
    currentRound: 3,
    rounds: [
      { round: 1, plan, deviceEvidence: evR1, gateRefusals: [], attribution: null, errorSignatures: evR1.errorSignatures },
      { round: 2, plan, deviceEvidence: evR2, gateRefusals: [], attribution: null, errorSignatures: evR2.errorSignatures },
    ],
  });
  assert.equal(streak.consecutiveSameError, 2);
  // InfoTest `briefs.py:2792-2820` & `remedies.py:39-42`: plain device error streak reports consecutiveSameError without auto varyFormRequired.
  assert.equal(streak.varyFormRequired, false);

  const streakFrozen = analyzeRoundHistory({
    currentRound: 3,
    rounds: [
      { round: 1, plan, deviceEvidence: evR1, gateRefusals: [], attribution: null, errorSignatures: evR1.errorSignatures },
      {
        round: 2,
        plan,
        deviceEvidence: evR2,
        gateRefusals: [],
        attribution: {
          round: 2,
          roundRecorded: true,
          sourceFile: 'attr-r2.json',
          disposition: 'frozen',
          confidence: 'hypothesis',
          judged: '归因已冻结，需更换做法',
          remedy: '更换命令形态',
          evidenceQuotes: [],
        },
        errorSignatures: evR2.errorSignatures,
      },
    ],
  });
  assert.equal(streakFrozen.varyFormRequired, true);

  // D6: Unrecorded attribution rendered alone never fabricates `第 1 轮`
  const mdUnrecorded = renderPriorRoundsMarkdown({
    caseRef: CASE_ID,
    currentRound: 2,
    rounds: [],
    streak: analyzeRoundHistory({ currentRound: 2, rounds: [] }),
    unrecordedAttribution: {
      round: null,
      roundRecorded: false,
      sourceFile: 'notes.json',
      confidence: 'hypothesis',
      judged: '未记录轮次的分析',
      remedy: '补查接口状态',
      evidenceQuotes: [],
    },
  });
  assert.ok(mdUnrecorded.includes('最近一次失败分析（轮次未记录）'));
  assert.ok(!mdUnrecorded.includes('第 1 轮失败分析'));
  assert.ok(!mdUnrecorded.includes('上一轮（第 1 轮）'));
});

function buildApvScrollLine(prompt: string, fullCmd: string, viewportCols = 60): string {
  // Simulates real APV horizontal-scroll redraws (`BS*W + $<W-1 chars>` frames, ending on a `<vis><spaces> + BS*pad + tail` chunk).
  const firstSlice = fullCmd.slice(0, viewportCols);
  let out = `${prompt}${firstSlice}`;
  let cursor = firstSlice.length;
  // Scroll 1 char at a time for the middle window, then finish with a space-padded scroll frame + trailing chunk.
  const tailChunkLen = Math.min(24, Math.max(0, fullCmd.length - viewportCols - 5));
  const scrollUntil = fullCmd.length - tailChunkLen;
  while (cursor < scrollUntil) {
    const vis = fullCmd.slice(cursor - (viewportCols - 2), cursor + 1);
    out += '\b'.repeat(viewportCols) + '$' + vis;
    cursor += 1;
  }
  if (tailChunkLen > 0) {
    const frameBody = fullCmd.slice(cursor - (viewportCols - 9), cursor + 1);
    const pad = viewportCols - 1 - frameBody.length;
    out += '\b'.repeat(viewportCols) + '$' + frameBody + ' '.repeat(pad) + '\b'.repeat(pad) + fullCmd.slice(cursor + 1);
  }
  return out;
}

test('N1: APV horizontal-scroll \\x08/$ redraws match >=220-char commands and keep readable error excerpts', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const prefix = 'set synthetic param alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ';
  const cmdKsk = `${prefix}token-one token-two mode KSK tail-check`;
  const cmdZsk = `${prefix}token-one token-two mode ZSK tail-check`;
  assert.ok(cmdKsk.length > 220);

  const rawLineKsk = buildApvScrollLine('Dut0(config)#', cmdKsk);
  assert.ok(rawLineKsk.length > 1000, 'raw terminal redraw stream exceeds naive excerpt cap');
  const decoded = decodeHorizontalScrollRedraw(rawLineKsk);
  assert.equal(decoded, `Dut0(config)#${cmdKsk}`);
  const tsLogLine = buildApvScrollLine('2026-11-14 09:52:52 ', cmdKsk, 75);
  assert.equal(decodeHorizontalScrollRedraw(tsLogLine), `2026-11-14 09:52:52 ${cmdKsk}`);

  const session = [
    'Dut0(config)#echo start',
    rawLineKsk,
    '% Error: Unrecognized parameter near token tail-check',
    buildApvScrollLine('Dut0(config)#', cmdZsk),
    '% Info: Applied ZSK variant',
  ].join('\n');

  const plan = parsePriorPlanSnapshot(makePlan(CASE_ID, cmdKsk, cmdZsk, 'ZSK succeeded'), ids);
  assert.ok(plan);

  const returnsIndex = {
    schema: 'device-returns@1',
    run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
    jobs: [
      {
        job: 'd'.repeat(64),
        verification_run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
        rows: [
          {
            item: CASE_ID,
            verdict: 'fail',
            runner_verdict: 'fail',
            sessions: { 'dut0.log': 'd'.repeat(12) + `/cases/${CASE_ID}/dut0.log` },
          },
        ],
      },
    ],
  };

  const evidence = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex,
    caseIds: ids,
    sessionTexts: new Map([['dut0.log', { path: 'dut0.log', text: session }]]),
    priorPlan: plan,
  })!;

  assert.ok(evidence);
  assert.equal(evidence.stepExcerpts.length, 2);
  assert.equal(evidence.stepExcerpts[0].found, true);
  assert.equal(evidence.stepExcerpts[1].found, true);
  assert.ok(evidence.stepExcerpts[0].excerpt?.includes('mode KSK tail-check'));
  assert.ok(evidence.stepExcerpts[0].excerpt?.includes('% Error: Unrecognized parameter'));
  assert.ok(!evidence.stepExcerpts[0].excerpt?.includes('mode ZSK tail-check'));
  assert.ok(!evidence.stepExcerpts[0].excerpt?.includes('\b'));
  assert.ok(!evidence.inlineTail.includes('\b'), 'inlineTail must decode scroll redraws without raw BS bytes');
  assert.ok(evidence.inlineTail.includes(cmdKsk), 'inlineTail preserves decoded long APV command');
  assert.ok(evidence.stepExcerpts[1].excerpt?.includes('% Info: Applied ZSK variant'));
});

test('N2: MISSING_STEP_TRUNCATION_MSG only triggers before first retained anchor in >=11k session when cmd absent', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const cmd1 = 'configure missing-pre-anchor step alpha';
  const cmd2 = 'show retained-middle status';
  const cmd3 = 'show missing-post-anchor status';
  const plan = {
    item: CASE_ID,
    handling: 'handled',
    slots: {
      plan: [
        {
          text: 'N2 test',
          quotes: [{ reference: 'src:' + '2'.repeat(64) + '/kityminder@1/n/e1', text: 'synth' }],
          data: {
            bucket: 'bed-a',
            blocks: [],
            replacements: [],
            steps: [
              { object: 'dut0', method: 'exec', args: [cmd1], keywords: {} },
              { object: 'dut0', method: 'exec', args: [cmd2], keywords: {} },
              { object: 'dut0', method: 'exec', args: [cmd3], keywords: {} },
            ],
            expects: [{ text: 'ok', after: 3 }],
          },
        },
      ],
    },
  };
  const snapshot = parsePriorPlanSnapshot(plan, ids);
  assert.ok(snapshot);

  const filler = 'R'.repeat(11_400);
  const longSession = `${filler}\nDut0#${cmd2}\nok-middle\nDut0#`;
  const returnsIndex = {
    schema: 'device-returns@1',
    run: 'run_01cccccccccccccccccccccccc',
    jobs: [
      {
        job: 'e'.repeat(64),
        verification_run: 'run_01cccccccccccccccccccccccc',
        rows: [
          {
            item: CASE_ID,
            verdict: 'fail',
            runner_verdict: 'fail',
            sessions: { 'dut0.log': 'e'.repeat(12) + `/cases/${CASE_ID}/dut0.log` },
          },
        ],
      },
    ],
  };

  const ev = extractCaseDeviceEvidence({
    round: 1,
    returnsIndex,
    caseIds: ids,
    sessionTexts: new Map([['dut0.log', { path: 'dut0.log', text: longSession }]]),
    priorPlan: snapshot,
  })!;

  assert.ok(ev);
  assert.ok((ev.sessionLengths['dut0.log'] ?? 0) >= 11_000);
  assert.equal(ev.stepExcerpts[0].found, false);
  assert.equal(ev.stepExcerpts[0].missingNotice, MISSING_STEP_TRUNCATION_MSG);
  assert.equal(ev.stepExcerpts[1].found, true);
  assert.equal(ev.stepExcerpts[2].found, false);
  assert.equal(ev.stepExcerpts[2].missingNotice, MISSING_STEP_NOT_FOUND_MSG);
});

test('N3 & N4: accepted missing_input splits from gate refusals, strips internal IDs, and avoids duplication', () => {
  const ids = buildCaseIdSet(CASE_ID);
  const fullMissingMsg = '尚未取得本检查所需的事实：缺少自动化用例 Excel（含规则；细节）。';
  const acceptedRaw = JSON.stringify({
    acceptance: 'accepted',
    errors: [
      {
        code: 'missing_input',
        item: CASE_ID,
        path: '/items/0',
        message: fullMissingMsg,
        fix:
          `补齐点名的事实后重交；缺失事实：${fullMissingMsg}；请补充具体 Mbps 数值，请求 rec:`
          + 'f'.repeat(64)
          + '，受众 usr_worker01，期限 2026-11-14T07:12:34.567Z：运行者用 upload_file 补齐',
        requirement: 'workbook_verified',
      },
    ],
  });

  const notAcceptedRaw = JSON.stringify({
    acceptance: 'not_accepted',
    gate: 'plan_schema',
    code: 'missing_field',
    pointer: `plans/${CASE_ID}.json#/slots/plan/0/steps/0`,
    message: '缺少必需字段 ref usr_admin02 2026-11-14T08:00:00.123Z rec:' + 'a'.repeat(64),
    fix: '补充真实引用节点路径',
  });

  const parsedAccepted = parseHubAnswerNotices(acceptedRaw, ids, 1);
  assert.equal(parsedAccepted.acceptanceParsed, true);
  assert.equal(parsedAccepted.acceptance, 'accepted');
  assert.equal(parsedAccepted.refusals.length, 0);
  assert.equal(parsedAccepted.acceptedNotices.length, 1);
  assert.equal(parseGateRefusalsFromAnswer(acceptedRaw, ids, 1).length, 0);

  const parsedEmpty = parseHubAnswerNotices('', ids, 1);
  assert.deepEqual(parsedEmpty, { acceptanceParsed: false, acceptance: null, refusals: [], acceptedNotices: [] });
  const parsedPlainMissingAcc = parseHubAnswerNotices(`${CASE_ID} BAD_INPUT 缺少关键字段`, ids, 1);
  assert.equal(parsedPlainMissingAcc.acceptanceParsed, false);
  assert.equal(parsedPlainMissingAcc.acceptance, null);
  assert.equal(parsedPlainMissingAcc.refusals.length, 1);

  const sanitizedFix = parsedAccepted.acceptedNotices[0].fix ?? '';
  assert.ok(!/rec:[0-9a-f]{16,64}/i.test(sanitizedFix));
  assert.ok(!/\busr_[A-Za-z0-9_-]+/.test(sanitizedFix));
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/.test(sanitizedFix));
  assert.ok(sanitizedFix.includes('2026-11-14 07:12 UTC'), 'ms timestamp rounded to minute UTC');
  assert.ok(!sanitizedFix.includes('缺失事实：'), 'duplicate middle 缺失事实：<message> stripped whole from fix');
  assert.ok(!sanitizedFix.includes('（含规则；细节）'), 'multi-clause duplicate message stripped without leaving fragments');
  assert.ok(sanitizedFix.includes('请补充具体 Mbps 数值'));

  assert.equal(
    sanitizeHubAnswerField('hello usr_abc rec:' + 'b'.repeat(64) + ' at 2026-11-14T07:00:00.000Z'),
    'hello at 2026-11-14 07:00 UTC',
  );

  const plan = parsePriorPlanSnapshot(makePlan(CASE_ID, 'cmd1', 'cmd2', 'expect ok'), ids);
  assert.ok(plan);

  const r1AcceptedRaw = JSON.stringify({
    acceptance: 'accepted',
    errors: [
      {
        code: 'missing_input',
        item: CASE_ID,
        path: '/items/0',
        message: '缺失第一轮前置材料。',
        fix: '请补充第一轮旧缺失参数',
      },
    ],
  });
  const parsedR1Acc = parseHubAnswerNotices(r1AcceptedRaw, ids, 1);

  const r1Accepted: PriorRoundRecordLike = {
    round: 1,
    plan,
    gateRefusals: [],
    acceptedNotices: parsedR1Acc.acceptedNotices,
    errorSignatures: [],
  };
  const r2Accepted: PriorRoundRecordLike = {
    round: 2,
    plan,
    gateRefusals: [],
    acceptedNotices: parsedAccepted.acceptedNotices,
    errorSignatures: [],
  };

  const streakAcc = analyzeRoundHistory({ currentRound: 3, rounds: [r1Accepted, r2Accepted] });
  assert.equal(streakAcc.varyFormRequired, false);
  assert.equal(consecutiveRepeatedGateCodes([r1Accepted, r2Accepted]).length, 0);

  const mdAccepted = renderPriorRoundsMarkdown({
    caseRef: CASE_ID,
    currentRound: 3,
    rounds: [r1Accepted, r2Accepted],
    streak: streakAcc,
  });
  assert.ok(mdAccepted.includes('Hub 已受理，还缺'));
  assert.ok(!mdAccepted.includes('Hub 门禁拒绝'));
  assert.ok(!mdAccepted.includes('Hub 没有受理'));
  assert.ok(!mdAccepted.includes('vary_form_required'));
  assert.ok(!/rec:[0-9a-f]{16,64}/i.test(mdAccepted));
  // Earlier round shows in 历轮摘要, while latest round's notice renders only in 上一轮 block (never repeated twice verbatim).
  assert.ok(mdAccepted.includes('请补充第一轮旧缺失参数'));
  const occurrences = mdAccepted.split('请补充具体 Mbps 数值').length - 1;
  assert.equal(occurrences, 1, 'latest round Hub notice should not repeat verbatim in both summary and 上一轮 section');

  const item = {
    id: CASE_ID,
    autoid: 'autoid-n3',
    reference: 'src:' + '3'.repeat(64) + '/kityminder@1/n/case1',
    fields: {
      title: '合成 N3 案例',
      recomposition: {
        record: {
          kept: [],
          dropped: [],
          moved: [],
          added: [],
          notes: '',
        },
      },
    },
    text: '合成 N3 案例',
    handling: 'handled',
    slots: { plan: [{ reference: 'src:' + '3'.repeat(64) + '/kityminder@1/n/e1', text: '合成规则', quotes: [] }] },
  };
  const emptyKnowledge = { root: 'root', nodes: new Map(), lines: new Map() };

  const briefAccepted = buildCompileBrief({
    item,
    index: CASE_ID,
    knowledge: emptyKnowledge,
    policy: null,
    round: 3,
    priorRounds: [r1Accepted, r2Accepted],
    createdAt: '2026-11-14T16:00:00Z',
  });
  assert.ok(briefAccepted);
  assert.deepEqual(briefAccepted.round_history.repeated_gate_codes, []);
  assert.equal(briefAccepted.task.vary_form_required, false);
  assert.ok(!briefAccepted.task.directives.some((d) => d.includes('机械规则错码')));
  assert.equal(validateCompileBrief(briefAccepted, item).ok, true);
  const mdBriefAcc = renderCompileBriefMd(briefAccepted);
  assert.ok(mdBriefAcc.includes('Hub 已受理，还缺'));
  assert.ok(!mdBriefAcc.includes('vary_form_required'));

  // Contrast: 2 consecutive unaccepted refusals (both flat wrapper and standard `errors: [...]` envelope)
  const parsedNotAcc = parseHubAnswerNotices(notAcceptedRaw, ids, 1);
  assert.equal(parsedNotAcc.acceptanceParsed, true);
  assert.equal(parsedNotAcc.acceptance, 'not_accepted');
  assert.equal(parsedNotAcc.refusals.length, 1);
  assert.equal(parsedNotAcc.acceptedNotices.length, 0);

  const notAcceptedEnvelope = JSON.stringify({
    call_result: 'error',
    acceptance: 'not_accepted',
    errors: [
      {
        code: 'RUN_SUPERSEDED',
        path: '/run',
        message: '运行已被新修订取代 usr_admin02 rec:' + 'c'.repeat(64),
        fix: '对新运行提交',
      },
    ],
  });
  const parsedEnvelope = parseHubAnswerNotices(notAcceptedEnvelope, ids, 2);
  assert.equal(parsedEnvelope.acceptanceParsed, true);
  assert.equal(parsedEnvelope.acceptance, 'not_accepted');
  assert.equal(parsedEnvelope.refusals.length, 1);
  assert.equal(parsedEnvelope.refusals[0].code, 'RUN_SUPERSEDED');
  assert.ok(!/usr_|rec:/.test(parsedEnvelope.refusals[0].message));

  const r1Ref: PriorRoundRecordLike = { round: 1, plan, gateRefusals: parsedNotAcc.refusals, errorSignatures: ['gate:missing_field'] };
  const r2Ref: PriorRoundRecordLike = { round: 2, plan, gateRefusals: parsedNotAcc.refusals, errorSignatures: ['gate:missing_field'] };
  const briefRefused = buildCompileBrief({
    item,
    index: CASE_ID,
    knowledge: emptyKnowledge,
    policy: null,
    round: 3,
    priorRounds: [r1Ref, r2Ref],
    createdAt: '2026-11-14T16:00:00Z',
  });
  assert.ok(briefRefused);
  assert.deepEqual(briefRefused.round_history.repeated_gate_codes, ['missing_field']);
  assert.equal(briefRefused.task.vary_form_required, true);
  const gateDirective = briefRefused.task.directives.find((d) => d.includes('机械规则错码 missing_field'));
  assert.ok(gateDirective?.includes('路径与字段要求'));
  assert.equal(validateCompileBrief(briefRefused, item).ok, true);
  const mdRefused = renderCompileBriefMd(briefRefused);
  assert.ok(mdRefused.includes('Hub 没有受理，原因'));
  assert.ok(!mdRefused.includes('Hub 门禁拒绝'));
});

type PriorRoundRecordLike = Parameters<typeof analyzeRoundHistory>[0]['rounds'][number];
