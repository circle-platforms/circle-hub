// Unit tests for single-case prior-round history extraction, 12,000-char truncation disclosure, and same-error streak analysis.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeRoundHistory,
  buildCaseIdSet,
  diffPlanSnapshots,
  extractCaseDeviceEvidence,
  MISSING_STEP_TRUNCATION_MSG,
  parseGateRefusalsFromAnswer,
  parsePriorAttribution,
  parsePriorPlanSnapshot,
  renderPriorRoundsMarkdown,
  SESSION_RETAINED_CHARS,
} from './rework-history.ts';

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
  const filler = Array.from({ length: 240 }, (_, i) => `seat# noise line ${String(i).padStart(3, '0')} ok`).join('\n');
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
  assert.equal(attr.judged, '未生效原因疑为参数字符非法');
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
  assert.equal(streak.varyFormRequired, true);
  assert.equal(streak.roundChanges.length, 1);

  const md = renderPriorRoundsMarkdown({ caseRef: CASE_ID, currentRound: 3, rounds, streak });
  assert.ok(md.includes('第 3 轮'));
  assert.ok(md.includes('连续 2 轮命中同类错误'));
  assert.ok(md.includes('不替代编写模型/分析模型的独立判断'));
  assert.ok(md.includes('widget mode a-1') && md.includes('widget mode a_2'));
  assert.ok(md.includes('confidence: "hypothesis"'));
});
