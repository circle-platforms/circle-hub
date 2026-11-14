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
  SUBAGENT_ROLES,
} from '../functions/subagent-roles.ts';
import { stage } from '../pack-files.ts';
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
      role: '写计划',
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
      const lines = [
        ...(omitStep1 ? ['seat#noise filler\n'.repeat(100)] : ['seat#widget init-beta\nok\n']),
        'seat#show widget v1\nError: object missing\nseat#\n',
      ];
      await writeFile(join(caseDir, 'dut0.txt'), lines.join(''), 'utf8');
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
      role: '写计划',
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
        '写计划',
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
    assert.ok(r3Cli.stdout.includes('连续 2 轮命中同类错误'));
    assert.ok(r3Cli.stdout.includes('widget init-alpha') && r3Cli.stdout.includes('widget init-beta'));
    assert.ok(r3Cli.stdout.includes('confidence: "hypothesis"'));
    assert.ok(r3Cli.stdout.includes('先建对象再查询'));
    assert.ok(!r3Cli.stdout.includes('另一个用例的归因'));

    // Round 2 without prior history fails closed
    await assert.rejects(
      buildTaskBrief({
        role: '写计划',
        caseRef: CASE,
        briefPath: 'run/briefs/00.md',
        outPath: 'plans-r2/00.json',
        round: 2,
        cwd: workDir,
        packRoot: packDir,
      }),
      /禁止无历史重派/,
    );

    // Blind fidelity role rejects history flags
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
