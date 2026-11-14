import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderAgentDefinition, SUBAGENT_ROLES } from '../functions/subagent-roles.ts';
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
