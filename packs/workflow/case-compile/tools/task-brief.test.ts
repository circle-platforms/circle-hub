import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  renderAgentDefinition,
  resolveSubagentRole,
  SUBAGENT_ROLES,
  subagentTypeFor,
} from '../functions/subagent-roles.ts';
import { CONTRACT_DOC } from '../functions/test-support.ts';
import { PROSE_WRAP_MAX_CHARS } from '../functions/text.ts';
import { stage } from '../pack-files.ts';
import { signTypedRuntime } from '../testing/typed-fixtures.ts';
import {
  buildTaskBrief,
  main,
  VERBATIM_LINE_DISCLOSURE_THRESHOLD,
  writeTaskBrief,
} from './task-brief.ts';

test('single-source roles drive both bundled agents/*.md and rendered task briefs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-roles-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    await mkdir(workDir);
    const scopeVerbatim = '只做 101、102 两条核心转发用例；103 先不做。\n补充：保持主接口地址不变。';
    await writeFile(join(workDir, 'scope.md'), scopeVerbatim, 'utf8');
    await mkdir(join(workDir, 'briefs'), { recursive: true });
    await writeFile(join(workDir, 'briefs', '01.md'), '# 合成编写简报\n', 'utf8');
    await mkdir(join(workDir, 'returns'), { recursive: true });
    await writeFile(join(workDir, 'returns', 'index.json'), '{"jobs":[]}', 'utf8');

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
    assert.ok(!writerBrief.includes('general-purpose'));
    assert.ok(!writerBrief.includes('Circle 1.17.0'));
    assert.ok(writerBrief.includes('subagent_type="case-compile:compile-writer"'));
    assert.ok(writerBrief.includes('compile-writer'));
    assert.ok(writerBrief.includes(scopeVerbatim));
    assert.ok(writerBrief.includes('使用者原话，由主会话记录'));
    assert.ok(writerBrief.includes(`技能目录（只读）：${packDir}`));
    assert.ok(writerBrief.includes(`${packDir}/slots.schema.json`));
    assert.ok(writerBrief.includes(`${packDir}/examples/submit-result.json`));
    assert.ok(writerBrief.includes(`${packDir}/tables/blocks-format.json`));
    assert.ok(writerBrief.includes(`${packDir}/tools/delivery.md`));
    assert.ok(writerBrief.includes(`node ${packDir}/tools/check-plan.ts --file`));
    assert.ok(!writerBrief.includes('<技能目录>'));
    assert.ok(writerBrief.includes('按测试环境改写、前置与清理'));
    assert.ok(writerBrief.includes('本轮补充：先查前置配置'));

    // Also accepts English keys, agent names, and pack-qualified names identically.
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
    assert.equal(resolveSubagentRole('case-compile:compile-writer')?.key, 'plan');
    assert.equal(subagentTypeFor(writerRole), 'case-compile:compile-writer');
    // Legacy alias `写计划` is rejected; callers must use `脚本编写` (or `plan` / `compile-writer`).
    assert.equal(resolveSubagentRole('写计划'), null);
    assert.equal(resolveSubagentRole('脚本编写')?.stageLabel, '脚本编写');
    assert.ok(!writerBrief.includes('写计划'));
    assert.equal(renderAgentDefinition(writerRole).includes('<技能目录>'), false);

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
    await mkdir(join(workDir, 'audit'), { recursive: true });
    await writeFile(join(workDir, 'audit', 'case-201.abcdef12.brief.json'), '{"schema":"fidelity-brief@1"}', 'utf8');

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
        '--task-file',
        'audit/case-201.abcdef12.task.md',
      ],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.ok(run.stdout.includes('subagent_type="case-compile:compile-fidelity"'));
    assert.ok(!run.stdout.includes('general-purpose'));
    assert.ok(!run.stdout.includes('Circle 1.17.0'));
    assert.ok(run.stdout.includes('audit/case-201.abcdef12.task.md'));
    assert.ok(!run.stdout.includes(scope));
    assert.ok(run.stdout.length <= 500);
    const taskContent = await readFile(join(workDir, 'audit/case-201.abcdef12.task.md'), 'utf8');
    assert.ok(taskContent.includes('case-compile:compile-fidelity'));
    assert.ok(taskContent.includes(scope));
    assert.ok(taskContent.includes(`技能目录（只读）：${packDir}`));
    assert.ok(!taskContent.includes('<技能目录>'));
    assert.ok(taskContent.includes('node ' + packDir + '/tools/check-plan.ts --file <verdict相对路径> --brief <brief相对路径>'));

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
        '--task-file',
        'briefs/r3-00.task.md',
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
    assert.ok(r3Cli.stdout.includes('briefs/r3-00.task.md'));
    assert.ok(r3Cli.stdout.includes('第 3 轮'));
    assert.ok(!r3Cli.stdout.includes('widget init-alpha') && !r3Cli.stdout.includes('先建对象再查询'));
    assert.ok(r3Cli.stdout.length <= 500);
    const r3TaskText = await readFile(join(workDir, 'briefs/r3-00.task.md'), 'utf8');
    assert.ok(r3TaskText.includes('当前轮次：第 3 轮'));
    assert.ok(r3TaskText.includes('最后一次机会'));
    assert.ok(!r3TaskText.includes('FINAL attempt'));
    assert.ok(r3TaskText.includes('连续 2 轮命中同类错误'));
    assert.ok(r3TaskText.includes('widget init-alpha') && r3TaskText.includes('widget init-beta'));
    assert.ok(r3TaskText.includes('最近一次失败分析（轮次未记录）'));
    assert.ok(!r3TaskText.includes('上一轮（第 2 轮）失败分析'));
    assert.ok(r3TaskText.includes('confidence: "hypothesis"'));
    assert.ok(r3TaskText.includes('先建对象再查询'));
    assert.ok(!r3TaskText.includes('另一个用例的归因'));

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

test('task-brief --help and -h return 0 with complete usage, and missing --brief lists actual sibling files before dispatch', async () => {
  for (const flag of ['--help', '-h'] as const) {
    const out: string[] = [], err: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let code = -1;
    try { code = await main([flag]); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    assert.equal(code, 0, `${flag}: stderr=${err.join('')}`);
    assert.equal(err.join(''), '');
    const help = out.join('');
    assert.match(help, /--role/);
    assert.match(help, /--brief/);
    assert.match(help, /--out/);
    assert.match(help, /用例重组/);
    assert.match(help, /脚本编写/);
    assert.match(help, /保真核对/);
    assert.match(help, /失败分析/);
  }

  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-exists-'));
  try {
    await writeFile(join(root, 'scope.md'), '全部合成用例\n', 'utf8');
    await mkdir(join(root, 'plan_run', 'briefs'), { recursive: true });
    await writeFile(join(root, 'plan_run', 'briefs', '0.md'), '# 0\n', 'utf8');
    await writeFile(join(root, 'plan_run', 'briefs', '1.md'), '# 1\n', 'utf8');
    await mkdir(join(root, 'plans'), { recursive: true });

    await assert.rejects(
      () => buildTaskBrief({
        role: '脚本编写',
        caseRef: '990000000000000101',
        briefPath: 'plan_run/briefs/00.md',
        outPath: 'plans/00.json',
        cwd: root,
      }),
      (error: Error) => /^不存在：找不到.*--brief/.test(error.message) && /0\.md/.test(error.message) && /1\.md/.test(error.message),
    );

    await assert.rejects(
      () => buildTaskBrief({
        role: '脚本编写',
        caseRef: '990000000000000101',
        briefPath: 'plan_run/briefs/0.md',
        outPath: 'plans',
        cwd: root,
      }),
      (error: Error) => /--out/.test(error.message) && (/目录/.test(error.message) || /\.json/.test(error.message)),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('writeTaskBrief wraps explanatory prose below 1600 chars, preserves a 5000-char verbatim device line byte-for-byte with shifted 1-based line disclosure, and prints only a short stdout notice', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-file-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    await mkdir(workDir);

    const CASE = '990000000000000401';
    const longScopeLine = `原始范围逐字保留_${'S'.repeat(2100)}_结尾`;
    const secretScopeSnippet = '机密范围原文绝对禁止出现在标准输出短提示中';
    await writeFile(join(workDir, 'scope.md'), `${secretScopeSnippet}\n${longScopeLine}\n`, 'utf8');
    await mkdir(join(workDir, 'briefs'), { recursive: true });
    await writeFile(join(workDir, 'briefs', '0.md'), '# 合成编写简报\n', 'utf8');
    await mkdir(join(workDir, 'plans'), { recursive: true });

    const planDoc = {
      item: CASE,
      handling: 'handled',
      slots: {
        plan: [
          {
            text: '合成自动化用例',
            quotes: [{ reference: `src:${'3'.repeat(64)}/kityminder@1/n/e1`, text: '期望' }],
            data: {
              bucket: 'bed-a',
              blocks: [],
              replacements: [],
              steps: [
                { object: 'dut0', method: 'exec', args: ['show health status'], keywords: {}, description: '检查' },
              ],
              expects: [{ after: 0, text: '期望', mode: 'substring', pattern: 'status=ok' }],
            },
          },
        ],
      },
    };
    await writeFile(join(workDir, 'plan-r1.json'), JSON.stringify(planDoc), 'utf8');

    const exactDevice5000 = 'X'.repeat(5000);
    const r1CaseDir = join(workDir, 'r1-returns', 'e'.repeat(12), 'cases', CASE);
    await mkdir(r1CaseDir, { recursive: true });
    await writeFile(
      join(r1CaseDir, 'dut0.txt'),
      `seat#show health status\n${exactDevice5000}\nError: object missing\nseat#\n`,
      'utf8',
    );
    await writeFile(
      join(r1CaseDir, 'log.txt'),
      'dispatched show health status\nError: object missing\n',
      'utf8',
    );
    await writeFile(
      join(workDir, 'r1-returns', 'index.json'),
      JSON.stringify({
        schema: 'device-returns@1',
        run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
        jobs: [
          {
            job: 'e'.repeat(64),
            verification_run: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
            rows: [
              {
                item: CASE,
                verdict: 'fail',
                log: join('e'.repeat(12), 'cases', CASE, 'log.txt'),
                sessions: { 'dut0.txt': join('e'.repeat(12), 'cases', CASE, 'dut0.txt') },
                execution_refused: [{ session: 'dut0.txt', prompt: 'seat#', command: 'show health status', reply: ['Error: object missing'] }],
              },
            ],
          },
        ],
      }),
      'utf8',
    );

    const longEvidenceQuote = `Q_${'E'.repeat(1900)}_QUOTE`;
    const longJudged = `分析结论_${'解'.repeat(2400)}_结论末`;
    const longRemedy = `修复建议_${'建'.repeat(2300)}_建议末`;
    const longNote = `本轮说明_${'说'.repeat(2500)}_说明末`;
    await writeFile(
      join(workDir, 'notes-r1.json'),
      JSON.stringify({
        cases: {
          [CASE]: {
            round: 1,
            confidence: 'hypothesis',
            judged: longJudged,
            remedy: longRemedy,
            evidence: longEvidenceQuote,
          },
        },
      }),
      'utf8',
    );

    const written = await writeTaskBrief({
      role: '脚本编写',
      caseRef: CASE,
      briefPath: 'briefs/0.md',
      outPath: 'plans/0.json',
      taskFilePath: 'briefs/0.task.md',
      note: longNote,
      round: 2,
      priorPlans: 'plan-r1.json',
      priorReturns: 'r1-returns',
      priorNotes: 'notes-r1.json',
      cwd: workDir,
      packRoot: packDir,
    });

    const onDisk = await readFile(join(workDir, 'briefs', '0.task.md'), 'utf8');
    assert.equal(onDisk, written.brief);
    const diskLines = onDisk.slice(0, -1).split('\n');
    assert.equal(diskLines.length, written.lineCount);

    // Explanatory prose bullets were wrapped so every emitted prose segment stays <= PROSE_WRAP_MAX_CHARS.
    for (const prefix of ['- 本轮补充：', '- 失败分析结论（未确认）：', '- 建议下一步：']) {
      const idx = diskLines.findIndex((line) => line.startsWith(prefix));
      assert.ok(idx >= 0, `missing ${prefix}`);
      assert.ok(diskLines[idx]!.length <= PROSE_WRAP_MAX_CHARS, `${prefix} exceeded wrap cap`);
      assert.ok(diskLines[idx + 1]?.startsWith('  '), `${prefix} did not wrap onto continuation line`);
      assert.ok(diskLines[idx + 1]!.length <= PROSE_WRAP_MAX_CHARS);
    }

    // Verbatim lines (> 1800 chars) were NEVER split or mutated anywhere, and header line numbers match exact shifted 1-based lines.
    assert.ok(written.longLines.length >= 3, `longLines=${JSON.stringify(written.longLines)} briefLen=${written.brief.length}`);
    for (const [label, expectedVerbatim] of [
      ['scope', longScopeLine],
      ['device5000', exactDevice5000],
      ['evidenceQuote', `- 引用证据原句：${longEvidenceQuote}`],
    ] as const) {
      assert.ok(expectedVerbatim.length > VERBATIM_LINE_DISCLOSURE_THRESHOLD, label);
      const exactIdx = diskLines.indexOf(expectedVerbatim);
      assert.ok(exactIdx >= 0, `${label}: verbatim line of length ${expectedVerbatim.length} was altered or wrapped`);
      assert.ok(
        written.longLines.some((entry) => entry.line === exactIdx + 1 && entry.length === expectedVerbatim.length && diskLines[entry.line - 1] === expectedVerbatim),
        `${label}: disclosure header missed shifted 1-based line ${exactIdx + 1}`,
      );
      assert.ok(onDisk.includes(`- 第 ${exactIdx + 1} 行（${expectedVerbatim.length} 字符）`));
    }

    // Short stdout dispatch notice stays compact and leaks zero case content or long verbatim chunks.
    assert.ok(written.dispatchPrompt.length <= 500, `dispatchPrompt too long: ${written.dispatchPrompt.length}`);
    assert.ok(written.dispatchPrompt.includes('subagent_type="case-compile:compile-writer"'));
    assert.ok(!written.dispatchPrompt.includes('general-purpose'));
    assert.ok(!written.dispatchPrompt.includes('Circle 1.17.0'));
    assert.ok(written.dispatchPrompt.includes('briefs/0.task.md'));
    assert.ok(written.dispatchPrompt.includes(`共 ${written.lineCount} 行`));
    assert.ok(written.dispatchPrompt.includes('plans/0.json'));
    assert.ok(written.dispatchPrompt.includes('read_file'));
    assert.ok(!written.dispatchPrompt.includes(secretScopeSnippet));
    assert.ok(!written.dispatchPrompt.includes('机密'));
    assert.ok(!written.dispatchPrompt.includes('解解解'));
    assert.ok(!written.dispatchPrompt.includes('XXXX'));

    // Reject invalid --task-file arguments (.json extension, collision with input/out, symlink).
    await assert.rejects(
      () => writeTaskBrief({
        role: '脚本编写',
        caseRef: CASE,
        briefPath: 'briefs/0.md',
        outPath: 'plans/0.json',
        taskFilePath: 'plans/0.task.json',
        cwd: workDir,
        packRoot: packDir,
      }),
      /必须是 \.md 文件路径/,
    );
    await assert.rejects(
      () => writeTaskBrief({
        role: '脚本编写',
        caseRef: CASE,
        briefPath: 'briefs/0.md',
        outPath: 'plans/0.json',
        taskFilePath: 'scope.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /不能与输入、范围或目标输出文件相同/,
    );
    await symlink(join(workDir, 'briefs', '0.md'), join(workDir, 'briefs', 'link.md'));
    await assert.rejects(
      () => writeTaskBrief({
        role: '脚本编写',
        caseRef: CASE,
        briefPath: 'briefs/0.md',
        outPath: 'plans/0.json',
        taskFilePath: 'briefs/link.md',
        cwd: workDir,
        packRoot: packDir,
      }),
      /符号链接/,
    );

    // CLI subprocess with --task-file prints short notice on stdout and writes full file on disk.
    const toolPath = join(packDir, 'tools', 'task-brief.ts');
    const cli = spawnSync(
      process.execPath,
      [
        toolPath,
        '--role', '脚本编写',
        '--case', CASE,
        '--brief', 'briefs/0.md',
        '--out', 'plans/0.json',
        '--task-file', 'briefs/cli-task.md',
      ],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, '');
    assert.ok(cli.stdout.trim().length <= 500);
    assert.ok(cli.stdout.includes('briefs/cli-task.md'));
    assert.ok(!cli.stdout.includes(secretScopeSnippet));
    const cliWritten = await readFile(join(workDir, 'briefs', 'cli-task.md'), 'utf8');
    assert.ok(cliWritten.includes(secretScopeSnippet));
    assert.ok(cliWritten.includes(longScopeLine));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('P1.3: task-brief embeds resolved skillDir at head of dispatchPrompt and supports --batch generation for plans and fidelity briefs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-task-brief-batch-'));
  try {
    const packDir = realpathSync(await stage(join(root, 'skill')));
    const workDir = join(root, 'work');
    await mkdir(join(workDir, 'briefs'), { recursive: true });
    await mkdir(join(workDir, 'audit'), { recursive: true });
    await writeFile(join(workDir, 'scope.md'), '仅重测批内 00、01 两条用例。\n', 'utf8');
    await writeFile(join(workDir, 'briefs', '00.md'), '# 用例 00 编写简报\n', 'utf8');
    await writeFile(join(workDir, 'briefs', '01.md'), '# 用例 01 编写简报\n', 'utf8');
    await writeFile(join(workDir, 'audit', '00.aaaaaaaa.brief.json'), JSON.stringify({ schema: 'fidelity-brief@1', item: 'doc:0', brief_sha256: 'a'.repeat(64) }), 'utf8');
    await writeFile(join(workDir, 'audit', '01.bbbbbbbb.brief.json'), JSON.stringify({ schema: 'fidelity-brief@1', item: 'doc:1', brief_sha256: 'b'.repeat(64) }), 'utf8');
    await writeFile(
      join(workDir, 'batch-plan.json'),
      JSON.stringify([
        { case: '100000000000000000', brief: 'briefs/00.md', out: 'plans/00.json', task_file: 'briefs/00.task.md' },
        { case: '100000000000000001', brief: 'briefs/01.md', out: 'plans/01.json', task_file: 'briefs/01.task.md', note: '按新配置核对' },
      ]),
      'utf8',
    );

    const toolPath = join(packDir, 'tools', 'task-brief.ts');
    const singleRun = spawnSync(
      process.execPath,
      [toolPath, '--role', '脚本编写', '--case', '100000000000000000', '--brief', 'briefs/00.md', '--out', 'plans/00.json', '--task-file', 'briefs/single.task.md'],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(singleRun.status, 0, singleRun.stderr);
    assert.ok(singleRun.stdout.length <= 500);
    assert.ok(singleRun.stdout.includes(`技能目录：${packDir}`), 'dispatchPrompt must expose real skillDir');

    const batchPlan = spawnSync(
      process.execPath,
      [toolPath, '--role', '脚本编写', '--batch', 'batch-plan.json'],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(batchPlan.status, 0, batchPlan.stderr);
    const planSummary = JSON.parse(batchPlan.stdout);
    assert.equal(planSummary.schema, 'task-brief-batch@1');
    assert.equal(planSummary.written, 2);
    assert.equal(planSummary.tasks.length, 2);
    assert.ok((await readFile(join(workDir, 'briefs', '01.task.md'), 'utf8')).includes('按新配置核对'));

    const batchFidelity = spawnSync(
      process.execPath,
      [toolPath, '--role', '保真核对', '--batch', 'audit', '--task-dir', 'audit-tasks'],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(batchFidelity.status, 0, batchFidelity.stderr);
    const fidSummary = JSON.parse(batchFidelity.stdout);
    assert.equal(fidSummary.written, 2);
    assert.ok((await readFile(join(workDir, 'audit-tasks', '00.aaaaaaaa.task.md'), 'utf8')).includes('compile-fidelity'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('req1 & req2: authoring, recomposition, fidelity, and attribution rules align with InfoTest without unqualified blockers', async () => {
  const skill = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
  const recomposeSkill = await readFile(new URL('../recompose/SKILL.md', import.meta.url), 'utf8');
  const deliveryDoc = await readFile(new URL('./delivery.md', import.meta.url), 'utf8');
  const fidelityDoc = await readFile(new URL('./fidelity.md', import.meta.url), 'utf8');
  const roleByKey = (key: string) => renderAgentDefinition(SUBAGENT_ROLES.find((r) => r.key === key)!);
  const recomposer = roleByKey('recompose');
  const writer = roleByKey('plan');
  const fidelity = roleByKey('fidelity');
  const attributor = roleByKey('attribute');

  // Positive Req 1: adapted is not a whitelist; sourced prerequisites + inverse cleanups must be added without altering negative tests.
  assert.ok(skill.length <= 9630, `SKILL.md length ${skill.length} exceeds 9630`);
  assert.ok(writer.includes('adapted` 与原始步骤只是等价动作描述，不是步骤白名单') && writer.includes('precondition_source'));
  assert.ok(writer.includes('sources.states') && writer.includes('原始用例明确要测“前置不存在/未配置”的反向场景时保留该无配置前提'));
  assert.ok(recomposer.includes('不替换作者的被测对象、被测动作或边界条件') && recomposer.includes('配置示例'));
  assert.ok(recomposeSkill.includes('states`（`missing_prerequisite`') && recomposeSkill.includes('配置示例'));
  assert.ok(fidelity.includes('mechanical.exemptions') && fidelity.includes('added_precondition') && fidelity.includes('无 `mechanical.exemptions` 依据'));
  assert.ok(fidelityDoc.includes('added_precondition'));

  // Negative Req 1: unqualified legacy phrase must not reappear in authoring/recompose prompts or skills.
  for (const [label, text] of [['compile-writer', writer], ['compile-recomposer', recomposer], ['SKILL.md', skill], ['recompose/SKILL.md', recomposeSkill]] as const) {
    assert.equal(text.includes('作者没写的对象或动作不自己加'), false, `${label} still has unqualified blocker`);
    assert.equal(text.includes('不能加原始用例没写的对象或动作'), false, `${label} still has unqualified blocker`);
  }

  // Positive Req 2: repeated same error falsifies prior direction; device-named missing + manual/example hypothesis must be tried; 缺资料 only when no source supports any hypothesis.
  for (const [label, text] of [['compile-attributor', attributor], ['delivery.md', deliveryDoc], ['SKILL.md', skill]] as const) {
    assert.ok(text.includes('证伪上一轮假设') || text.includes('证伪上轮假设') || text.includes('假设已证伪'), `${label} missing falsification rule`);
    assert.ok(text.includes('缺资料'), `${label} missing 缺资料 narrow rule`);
  }
  assert.ok(attributor.includes('尚有轮次时，下一轮返工必须优先测试该假设，不得借“缺资料”或“剩一次机会”拦住不试'));
  assert.ok(attributor.includes('轮次已用完时不建议再开轮'));
  assert.ok(attributor.includes('尚有轮次时供下一轮先试；轮次用完时作为下一步交使用者决定'));
  assert.ok(attributor.includes('只有在锁定手册正文、示例、命令树与环境声明均没有任何来源支持任何未试假设时，才可归为“缺资料”'));
  assert.ok(skill.includes('尚有轮次就必须下一轮先试，不得以“缺资料”或“剩一次机会”为由不试；轮次用完不开第 4 轮'));
  assert.ok(skill.includes('完整读 `index.json`') && skill.includes('停止上机验证'));
  assert.ok(skill.includes('adapted` 不是步骤白名单'));
  assert.ok(!skill.includes('仅缺工作簿') && !skill.includes('工作簿一致'));
  assert.ok(deliveryDoc.includes('即使“剩一次机会”也必须继续修改重测'));
  assert.ok(deliveryDoc.includes('轮次已用完时不开第 4 轮'));
  assert.ok(!writer.includes('130 条') && !recomposeSkill.includes('130 条'));
  assert.ok(recomposeSkill.includes('运行器清配置并在收尾末尾执行 `write memory` 存盘') || recomposeSkill.includes('运行器清配置并在收尾末尾执行 \\`write memory\\` 存盘'));
});
