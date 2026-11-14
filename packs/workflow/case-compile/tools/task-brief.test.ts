import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  CIRCLE_GENERAL_PURPOSE_NOTICE,
  renderAgentDefinition,
  resolveSubagentRole,
  SUBAGENT_ROLES,
} from '../functions/subagent-roles.ts';
import { CONTRACT_DOC } from '../functions/test-support.ts';
import { stage } from '../pack-files.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import { buildTaskBrief, main } from './task-brief.ts';

test('single-source roles drive both bundled agents/*.md and rendered task briefs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-roles-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const scopeVerbatim = '只做 101、102 两条核心转发用例；103 先不做。\n补充：保持主接口地址不变。';
    await writeFile(join(workDir, 'scope.md'), scopeVerbatim, 'utf8');

    const writerRole = SUBAGENT_ROLES.find((r) => r.key === 'plan')!;
    const writerBrief = await buildTaskBrief({
      role: '脚本编写',
      caseRef: 'case-101',
      briefPath: 'briefs/01.md',
      outPath: 'plans/01.json',
      cwd: workDir,
      packRoot: packDir,
      note: '先查前置配置',
    });
    assert.ok(writerBrief.startsWith(`${CIRCLE_GENERAL_PURPOSE_NOTICE}\n\n`));
    assert.ok(writerBrief.includes('subagent_type="general-purpose"'));
    assert.ok(writerBrief.includes('compile-writer'));
    assert.ok(writerBrief.includes(scopeVerbatim));
    assert.ok(writerBrief.includes('使用者原话，由主会话记录'));
    assert.ok(writerBrief.includes(`技能目录：${packDir}`));
    assert.ok(writerBrief.includes(`node "${packDir}/tools/check-plan.ts" --file`));
    assert.ok(!writerBrief.includes('<技能目录>'));
    assert.ok(writerBrief.includes('按测试环境改写、前置与清理'));
    assert.ok(writerBrief.includes('本轮补充：先查前置配置'));

    // Also accepts English keys and agent names identically.
    const writerByKey = await buildTaskBrief({
      role: 'plan',
      caseRef: 'case-101',
      briefPath: 'briefs/01.md',
      outPath: 'plans/01.json',
      cwd: workDir,
      packRoot: packDir,
      note: '先查前置配置',
    });
    assert.equal(writerByKey, writerBrief);
    // Legacy alias `写计划` is rejected; callers must use `脚本编写` (or `plan` / `compile-writer`).
    assert.equal(resolveSubagentRole('写计划'), null);
    assert.equal(resolveSubagentRole('脚本编写')?.stageLabel, '脚本编写');
    assert.ok(!writerBrief.includes('写计划'));
    assert.equal(renderAgentDefinition(writerRole).includes('<技能目录>'), true);

    // Attributor brief points to index.json, session transcripts, and log.txt.
    const attrBrief = await buildTaskBrief({
      role: '失败分析',
      caseRef: 'case-102',
      briefPath: 'returns/index.json',
      outPath: 'analysis/case-102.md',
      cwd: workDir,
      packRoot: packDir,
    });
    assert.ok(attrBrief.includes('compile-attributor'));
    assert.ok(attrBrief.includes('index.json'));
    assert.ok(attrBrief.includes('apv_*.txt'));
    assert.ok(attrBrief.includes('log.txt'));
    assert.ok(attrBrief.includes('本轮严禁工具与动作：execute'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task-brief rejects missing, header-only, oversized, binary, or escaping scope files and bad paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-guard-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    const outsideDir = join(root, 'outside');
    await mkdir(workDir);
    await mkdir(outsideDir);

    // Missing default scope.md
    await assert.rejects(
      buildTaskBrief({
        role: 'recompose',
        caseRef: 'all',
        briefPath: 'inputs/mindmap.json',
        outPath: 'recomposed.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /不存在：找不到 --scope 文件 scope\.md/,
    );

    // Empty / header-only scope.md
    await writeFile(join(workDir, 'scope.md'), '# 本轮范围\n\n## 备注\n   \n', 'utf8');
    await assert.rejects(
      buildTaskBrief({
        role: 'recompose',
        caseRef: 'all',
        briefPath: 'inputs/mindmap.json',
        outPath: 'recomposed.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /为空或只有标题/,
    );

    // Oversized (> 16384 bytes) scope.md
    await writeFile(join(workDir, 'scope.md'), 'a'.repeat(16_385), 'utf8');
    await assert.rejects(
      buildTaskBrief({
        role: 'plan',
        caseRef: 'c1',
        briefPath: 'briefs/1.md',
        outPath: 'plans/1.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /超过 16384 字节上限/,
    );

    // NUL byte in scope
    await writeFile(join(workDir, 'bad-scope.md'), Buffer.from('scope\0text', 'utf8'));
    await assert.rejects(
      buildTaskBrief({
        role: 'plan',
        caseRef: 'c1',
        briefPath: 'briefs/1.md',
        outPath: 'plans/1.json',
        scopePath: 'bad-scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /包含空字节/,
    );

    // Symlink scope file rejected even inside cwd
    await writeFile(join(workDir, 'real-scope.md'), '全部 3 条用例', 'utf8');
    await symlink(join(workDir, 'real-scope.md'), join(workDir, 'link-scope.md'));
    await assert.rejects(
      buildTaskBrief({
        role: 'fidelity',
        caseRef: 'c1',
        briefPath: 'audit/c1.brief.json',
        outPath: 'audit/c1.verdict.json',
        scopePath: 'link-scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /不能是符号链接/,
    );

    // Path escapes rejected on --scope, --brief, --out
    await writeFile(join(outsideDir, 'outside-scope.md'), 'x', 'utf8');
    await assert.rejects(
      buildTaskBrief({
        role: 'fidelity',
        caseRef: 'c1',
        briefPath: '../outside/b.json',
        outPath: 'audit/c1.verdict.json',
        scopePath: 'real-scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /超出当前工作目录/,
    );
    await assert.rejects(
      buildTaskBrief({
        role: 'fidelity',
        caseRef: 'c1',
        briefPath: 'audit/c1.brief.json',
        outPath: outsideDir,
        scopePath: 'real-scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /超出当前工作目录/,
    );
    await assert.rejects(
      buildTaskBrief({
        role: 'unknown-role',
        caseRef: 'c1',
        briefPath: 'briefs/1.md',
        outPath: 'plans/1.json',
        scopePath: 'real-scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /未知子代理角色/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staged task-brief CLI resolves installed skill dir from import.meta.url and emits verbatim prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-cli-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'installed-skill')));
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const scope = '只重跑 batch2 新增的两条用例；不要修改已完成用例。';
    await writeFile(join(workDir, 'scope.md'), scope, 'utf8');

    const run = spawnSync(
      process.execPath,
      [
        join(packDir, 'tools/task-brief.ts'),
        '--role',
        '保真核对',
        '--case',
        'case-201',
        '--brief',
        'audit/case-201.abcdef12.brief.json',
        '--out',
        'audit/case-201.abcdef12.verdict.json',
      ],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('compile-fidelity'));
    assert.ok(run.stdout.includes(scope));
    assert.ok(run.stdout.includes(`技能目录：${packDir}`));
    assert.ok(!run.stdout.includes('<技能目录>'));
    assert.ok(run.stdout.includes('node "' + packDir + '/tools/check-plan.ts" --file <verdict相对路径> --brief <brief相对路径>'));

    // Invalid option format exits non-zero with formatted stderr.
    const errChunks: string[] = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      const code = await main(['--role=plan']);
      assert.equal(code, 1);
      assert.match(errChunks.join(''), /^参数无效：.+\n$/);
    } finally {
      process.stderr.write = stderrWrite;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('task-brief round 2+ embeds single-case prior plan, device output or 12,000-char missing disclosure, attribution hypothesis, and streak diffs while isolating fidelity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-round2-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    await mkdir(workDir);
    await writeFile(join(workDir, 'scope.md'), '只测试 301 这一条合成用例。', 'utf8');

    const CASE = '990000000000000301';
    const OTHER = '990000000000000302';
    const planDoc = (cmd1: string, cmd2: string) => ({
      item: `case-${CASE}`,
      handling: 'handled',
      slots: {
        plan: [
          {
            text: '合成自动化用例',
            quotes: [{ reference: `src:${'2'.repeat(64)}/kityminder@1/n/e1`, text: '期望命中' }],
            data: {
              bucket: 'bed-a',
              blocks: [],
              replacements: [],
              steps: [
                { object: 'dut0', method: 'exec', args: [cmd1], keywords: {}, description: '设置前置' },
                { object: 'dut0', method: 'exec', args: [cmd2], keywords: {}, description: '执行查询' },
              ],
              expects: [{ text: '期望命中', quote: { reference: `src:${'2'.repeat(64)}/kityminder@1/n/e1`, text: '期望命中' }, after: 2 }],
            },
          },
        ],
      },
    });

    await mkdir(join(workDir, 'run', 'items'), { recursive: true });
    await mkdir(join(workDir, 'run', 'briefs'), { recursive: true });
    await writeFile(join(workDir, 'run', 'briefs', '00.md'), '# 编写简报 00\n', 'utf8');
    await writeFile(
      join(workDir, 'run', 'items', '00.json'),
      JSON.stringify({ id: `case-${CASE}`, fields: { autoid: CASE, title: '合成 301' } }),
    );

    await mkdir(join(workDir, 'plans-r1'));
    await mkdir(join(workDir, 'plans-r2'));
    await writeFile(join(workDir, 'plans-r1', '00.json'), JSON.stringify(planDoc('widget init-alpha', 'show widget v1')));
    await writeFile(join(workDir, 'plans-r2', '00.json'), JSON.stringify(planDoc('widget init-beta', 'show widget v1')));

    // Round 1 returns: truncated session missing step 1 (`widget init-alpha`) while retaining step 2 refusal;
    // Round 2 returns: same `show widget v1` execution refusal so consecutive streak = 2 on Round 3.
    const makeReturns = async (dirName: string, runId: string, omitStep1: boolean) => {
      const base = join(workDir, dirName);
      const caseDir = join(base, 'd'.repeat(12), 'cases', CASE);
      await mkdir(caseDir, { recursive: true });
      const tailCmd = 'seat#show widget v1\nError: object missing\nseat#\n';
      const rawSession = omitStep1
        ? Array.from({ length: 750 }, (_, i) => `seat#noise filler ${String(i).padStart(3, '0')}`).join('\n') + '\n' + tailCmd
        : 'seat#widget init-beta\nok\n' + tailCmd;
      const body = rawSession.length > 12_000 ? rawSession.slice(-12_000) : rawSession;
      await writeFile(join(caseDir, 'dut0.txt'), body, 'utf8');
      await writeFile(join(caseDir, 'log.txt'), `dispatched show widget v1\nError: object missing\n`, 'utf8');
      await writeFile(
        join(base, 'index.json'),
        JSON.stringify({
          schema: 'device-returns@1',
          run: runId,
          jobs: [
            {
              job: 'd'.repeat(64),
              verification_run: runId,
              rows: [
                {
                  item: OTHER,
                  verdict: 'fail',
                  execution_refused: [{ session: 'dut0.txt', prompt: 'seat#', command: 'forbidden other cmd', reply: ['other err'] }],
                },
                {
                  item: CASE,
                  verdict: 'fail',
                  log: join('d'.repeat(12), 'cases', CASE, 'log.txt'),
                  sessions: { 'dut0.txt': join('d'.repeat(12), 'cases', CASE, 'dut0.txt') },
                  execution_refused: [{ session: 'dut0.txt', prompt: 'seat#', command: 'show widget v1', reply: ['Error: object missing'] }],
                },
              ],
            },
          ],
        }),
      );
    };

    await makeReturns('ret-r1', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', true);
    await makeReturns('ret-r2', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', false);
    await writeFile(join(workDir, 'ans-r1.txt'), `用例 ${OTHER} OTHER_CODE\n用例 ${CASE} SOME_GATE /slots/plan/0：门禁提示\n`, 'utf8');
    await writeFile(
      join(workDir, 'notes-r2.json'),
      JSON.stringify({
        cases: {
          [OTHER]: { judged: '另一个用例的归因', remedy: '不要泄露' },
          [CASE]: { judged: '疑似缺少前置创建对象', remedy: '先建对象再查询', evidence: 'Error: object missing' },
        },
      }),
    );

    // Round 2 checks missing truncated step disclosure
    const r2Brief = await buildTaskBrief({
      role: '脚本编写',
      caseRef: CASE,
      briefPath: 'run/briefs/00.md',
      outPath: 'plans-r2/00.json',
      round: 2,
      priorPlans: 'plans-r1/00.json',
      priorReturns: 'ret-r1',
      priorAnswers: 'ans-r1.txt',
      cwd: workDir,
      packRoot: packDir,
    });
    assert.ok(r2Brief.includes('当前轮次：第 2 轮'));
    assert.ok(r2Brief.includes('widget init-alpha'));
    assert.ok(r2Brief.includes('这一步的设备输出不在保留的末尾 12,000 个字符内'));
    assert.ok(r2Brief.includes('Error: object missing'));
    assert.ok(r2Brief.includes('SOME_GATE'));
    assert.ok(!r2Brief.includes('forbidden other cmd') && !r2Brief.includes('OTHER_CODE'));

    // Round 3 staged CLI run checks consecutive same-error streak, R1->R2 diff, and hypothesis marker
    const r3Cli = spawnSync(
      process.execPath,
      [
        join(packDir, 'tools/task-brief.ts'),
        '--role',
        '脚本编写',
        '--case',
        CASE,
        '--brief',
        'run/briefs/00.md',
        '--out',
        'plans-r3/00.json',
        '--round',
        '3',
        '--prior-plans',
        'plans-r1/00.json,plans-r2/00.json',
        '--prior-returns',
        'ret-r1,ret-r2',
        '--prior-answers',
        'ans-r1.txt,-',
        '--prior-notes',
        '-,notes-r2.json',
      ],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(r3Cli.status, 0, r3Cli.stderr);
    assert.ok(r3Cli.stdout.includes('当前轮次：第 3 轮'));
    assert.ok(r3Cli.stdout.includes('最后一次机会'));
    assert.ok(!r3Cli.stdout.includes('FINAL attempt'));
    assert.ok(r3Cli.stdout.includes('连续 2 轮命中同类错误'));
    assert.ok(r3Cli.stdout.includes('widget init-alpha') && r3Cli.stdout.includes('widget init-beta'));
    assert.ok(r3Cli.stdout.includes('最近一次失败分析（轮次未记录）'));
    assert.ok(!r3Cli.stdout.includes('上一轮（第 2 轮）失败分析'));
    assert.ok(r3Cli.stdout.includes('confidence: "hypothesis"'));
    assert.ok(r3Cli.stdout.includes('先建对象再查询'));
    assert.ok(!r3Cli.stdout.includes('另一个用例的归因'));

    // Round 2 without prior history fails closed
    await assert.rejects(
      buildTaskBrief({
        role: '脚本编写',
        caseRef: CASE,
        briefPath: 'run/briefs/00.md',
        outPath: 'plans-r2/00.json',
        round: 2,
        cwd: workDir,
        packRoot: packDir,
      }),
      /禁止无历史重派/,
    );

    // Blind fidelity role rejects history flags & --run
    await assert.rejects(
      buildTaskBrief({
        role: '保真核对',
        caseRef: CASE,
        briefPath: 'audit/00.brief.json',
        outPath: 'audit/00.verdict.json',
        round: 2,
        priorReturns: 'ret-r1',
        cwd: workDir,
        packRoot: packDir,
      }),
      /严格盲审/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dry-run fixes: D1 multi-line answer, D3 submission rejection, D6 unrecorded notes, D8 unified task-brief with failureMarkers, D9 scope partition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-dryrun-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    const CASE_A = '990000000000000401';
    const CASE_B = '990000000000000402';
    const ROOT = 'c'.repeat(64);
    const REF_K = `tree:${ROOT}/commands/widget@${'d'.repeat(64)}`;
    const REF_Q = `src:${'e'.repeat(64)}/kityminder@1/n/1`;

    await mkdir(join(workDir, 'run', 'items'), { recursive: true });
    await mkdir(join(workDir, 'run', 'briefs'), { recursive: true });
    await mkdir(join(workDir, 'run', 'knowledge'), { recursive: true });
    await mkdir(join(workDir, 'run', 'sources'), { recursive: true });

    // D9: scope.md with global text + CASE_A section (with subheading) + CASE_B section
    await writeFile(
      join(workDir, 'scope.md'),
      [
        '# 使用者原话，由主会话记录',
        '',
        '## 全局说明',
        '所有用例均须从同构建手册查清语法。',
        '',
        `## ${CASE_A}（只测 A）`,
        '### A 专属细节',
        'A 要求校验 RSA 状态。',
        '',
        `## ${CASE_B}（只测 B）`,
        'B 专属秘密：切勿在 A 中泄漏 B 的 ECDSA。',
      ].join('\n'),
      'utf8',
    );

    // Unified single-case run setup (ONLY case 00 exists cleanly; sibling 01 has NO prior plan at all)
    const itemA = {
      id: 'doc-4:c-1',
      fields: {
        autoid: CASE_A,
        title: '用例A',
        recomposition: {
          record: {
            schema: 'recompose-record@1',
            case: { id: 'doc-4:c-1', title: '用例A' },
            atoms: [{ atom_id: 'a1', kind: 'expect', text: '返回正确结果', quote_ref: REF_Q }],
            commands: [],
            states: [],
            references: { cited: [] },
          },
        },
      },
    };
    const itemB = {
      id: 'doc-4:c-2',
      fields: { autoid: CASE_B, title: '用例B' },
    };
    await writeFile(join(workDir, 'run', 'items', '00.json'), JSON.stringify(itemA));
    await writeFile(join(workDir, 'run', 'items', '01.json'), JSON.stringify(itemB));
    await writeFile(join(workDir, 'run', 'briefs', '00.md'), '# 静态编写简报 00\n');
    await writeFile(join(workDir, 'run', 'knowledge', 'nodes.jsonl'), JSON.stringify({
      schema: 'run-knowledge@1',
      root: ROOT,
      composition: null,
      nodes: 1,
      entries: 1,
    }) + '\n' + JSON.stringify({
      path: '/commands/widget',
      children: [],
      entries: [{ reference: REF_K, statement: 'widget <mode:string>', data: { parameter: { name: 'mode', commands: ['widget'] } } }],
    }) + '\n');
    await writeFile(join(workDir, 'run', 'knowledge', 'commands.txt'), '');
    await writeFile(join(workDir, 'run', 'knowledge', 'manual.txt'), '');
    await writeFile(join(workDir, 'run', 'run.json'), JSON.stringify({
      run: 'run_01cccccccccccccccccccccccc',
      product: 'synth-apv',
      version: '1.0.0',
      build: '1.0.0-b1',
      groups: [{ kind: 'case-compile', profile: { bed: 'bed-a' } }],
    }));
    // Contract declares custom failure marker `CUSTOM_MARKER_FAIL` -> forwarded by task-brief.ts without authoring-brief --round!
    const contractWithMarker = structuredClone(CONTRACT_DOC) as Record<string, unknown>;
    contractWithMarker.exec_failure_markers = {
      source: 'runner-exec-markers.py',
      sha256: 'e'.repeat(64),
      lines: ['CUSTOM_MARKER_FAIL'],
    };
    await writeFile(join(workDir, 'run', 'sources', 'contract.json'), JSON.stringify(signTypedRuntime(contractWithMarker)));
    await writeFile(join(workDir, 'run', 'sources.json'), JSON.stringify([
      { slot: 'contract', file: 'sources/contract.json' },
    ]));

    // D3: reject whole-batch submission.json and wrong-shape answer/notes files
    await writeFile(join(workDir, 'submission.json'), JSON.stringify({ items: [{ item: CASE_A }] }));
    await writeFile(
      join(workDir, 'ans-multiline.txt'),
      [
        `受理报告：用例 ${CASE_A} INVALID_PARAM /slots/plan/0/data/steps/0`,
        '供模型引用',
        JSON.stringify({
          call_result: 'partial',
          original_cases: [
            { id: 'doc-4:c-1', autoid: CASE_A, raw: 'P'.repeat(600_000) },
            { id: 'doc-4:c-2', autoid: CASE_B, raw: 'P'.repeat(600_000) },
          ],
          errors: [
            { item: CASE_B, code: 'B_ERR', message: '不应泄露的B错误', fix: 'none' },
            { item: CASE_A, code: 'INVALID_PARAM', pointer: '/slots/plan/0/data/steps/0', message: '参数非法', fix: '修正参数' },
          ],
        }),
      ].join('\n'),
    );
    await writeFile(
      join(workDir, 'notes-unrecorded.json'),
      JSON.stringify({ cases: { [CASE_A]: { judged: '仅有未记录轮次归因', remedy: '按参数说明重改' } } }),
    );

    await assert.rejects(
      buildTaskBrief({
        role: '脚本编写',
        caseRef: CASE_A,
        briefPath: 'run/briefs/00.md',
        outPath: 'plans/00.json',
        round: 2,
        priorPlans: 'submission.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /submission\.json/,
    );
    await assert.rejects(
      buildTaskBrief({
        role: '脚本编写',
        caseRef: CASE_A,
        briefPath: 'run/briefs/00.md',
        outPath: 'plans/00.json',
        round: 2,
        priorAnswers: 'submission.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /submission\.json/,
    );

    // D6: --round 2 with ONLY unrecorded notes works without fabricating `第 1 轮`
    const r2OnlyNote = await buildTaskBrief({
      role: '脚本编写',
      caseRef: CASE_A,
      briefPath: 'run/briefs/00.md',
      outPath: 'plans/00.json',
      round: 2,
      priorNotes: 'notes-unrecorded.json',
      cwd: workDir,
      packRoot: packDir,
    });
    assert.ok(r2OnlyNote.includes('最近一次失败分析（轮次未记录）'));
    assert.ok(!r2OnlyNote.includes('### 上一轮（第 1 轮）'));
    // D9: scope isolated strictly to CASE_A + global
    assert.ok(r2OnlyNote.includes('所有用例均须从同构建手册查清语法'));
    assert.ok(r2OnlyNote.includes('A 要求校验 RSA 状态'));
    assert.ok(!r2OnlyNote.includes('B 专属秘密'));
    // D8: single-case in-memory compile-brief@1 automatically injected even without authoring-brief --round!
    assert.ok(r2OnlyNote.includes('本轮结构化简报摘要与前置披露（来自 compile-brief@1）'));

    // D1 & D8: round 3 via unified task-brief.ts with multi-line 1.2MB answer & contract failure marker across r1+r2
    const mkPlanFile = (rel: string, arg: string) => writeFile(join(workDir, rel), JSON.stringify({
      item: CASE_A,
      handling: 'handled',
      slots: { plan: [{ text: 'p', quotes: [], data: { bucket: 'bed-a', blocks: [], replacements: [], steps: [{ object: 'dut0', method: 'exec', args: [`widget ${arg}`], keywords: {} }], expects: [] } }] },
    }));
    await mkPlanFile('p1.json', 'a');
    await mkPlanFile('p2.json', 'b');
    const mkCustomMarkerRet = async (dir: string, runId: string, cmd: string) => {
      await mkdir(join(workDir, dir, 'cases', CASE_A), { recursive: true });
      await writeFile(join(workDir, dir, 'cases', CASE_A, 'dut0.txt'), `apv#${cmd}\nok\napv#\n`);
      await writeFile(join(workDir, dir, 'cases', CASE_A, 'log.txt'), `${cmd} done\nCUSTOM_MARKER_FAIL id: 901\n`);
      await writeFile(join(workDir, dir, 'index.json'), JSON.stringify({
        schema: 'device-returns@1',
        run: runId,
        jobs: [{
          job: 'a'.repeat(64),
          verification_run: runId,
          rows: [{
            item: CASE_A,
            verdict: 'fail',
            log: join('cases', CASE_A, 'log.txt'),
            sessions: { 'dut0.txt': join('cases', CASE_A, 'dut0.txt') },
          }],
        }],
      }));
    };
    await mkCustomMarkerRet('r1', 'run_01aaaaaaaaaaaaaaaaaaaaaaaa', 'widget a');
    await mkCustomMarkerRet('r2', 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', 'widget b');

    const r3Unified = await buildTaskBrief({
      role: '脚本编写',
      caseRef: CASE_A,
      briefPath: 'run/briefs/00.md',
      outPath: 'plans-r3/00.json',
      round: 3,
      runDir: 'run',
      itemPath: 'run/items/00.json',
      priorPlans: 'p1.json,p2.json',
      priorReturns: 'r1,r2',
      priorAnswers: 'ans-multiline.txt,-',
      cwd: workDir,
      packRoot: packDir,
    });
    assert.ok(r3Unified.length < 80_000, `D1: multi-line 1.2MB answer must not bloat brief (got ${r3Unified.length})`);
    assert.ok(r3Unified.includes('INVALID_PARAM'));
    assert.ok(!r3Unified.includes('B_ERR') && !r3Unified.includes('PPPPPP'));
    assert.ok(r3Unified.includes('连续 2 轮命中同类错误'), 'D8: contract failure_markers loaded via task-brief.ts drove streak detection');
    assert.ok(r3Unified.includes('最后一次机会') && !r3Unified.includes('FINAL attempt'));

    // D9: recompose with `--case all` keeps all sections
    const recAll = await buildTaskBrief({
      role: '用例重组',
      caseRef: 'all',
      briefPath: 'run/items/00.json',
      outPath: 'rec.json',
      cwd: workDir,
      packRoot: packDir,
    });
    assert.ok(recAll.includes('A 要求校验 RSA 状态') && recAll.includes('B 专属秘密'));

    // D9: reject scope file containing only other cases' sections and zero global content
    await writeFile(join(workDir, 'scope-other-only.md'), `# 使用者原话\n\n## ${CASE_B}（仅B）\n只写B的内容\n`, 'utf8');
    await assert.rejects(
      buildTaskBrief({
        role: '脚本编写',
        caseRef: CASE_A,
        briefPath: 'run/briefs/00.md',
        outPath: 'plans/00.json',
        scopePath: 'scope-other-only.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /未找到当前用例/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
