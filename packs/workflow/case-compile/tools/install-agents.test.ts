import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { stage } from '../pack-files.ts';
import { installAgents, main } from './install-agents.ts';

const AGENT_FILES = [
  'compile-attributor.md',
  'compile-fidelity.md',
  'compile-recomposer.md',
  'compile-writer.md',
];

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test('install-agents installs verified agents, skips matching ones, and updates stale ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-agents-'));
  try {
    const packDir = await stage(join(root, 'skill'));
    const workDir = join(root, 'work');
    await mkdir(workDir);

    const first = await installAgents({ packRoot: packDir, cwd: workDir });
    assert.equal(first.pack, 'case-compile');
    assert.equal(first.version, '3.21.0');
    assert.equal(first.target, '.circle/agents');
    assert.deepEqual(first.installed, AGENT_FILES);
    assert.deepEqual(first.updated, []);
    assert.deepEqual(first.unchanged, []);

    const fixedTime = new Date(1_700_000_000_000);
    for (const name of AGENT_FILES) {
      const dest = join(workDir, '.circle/agents', name);
      const src = Buffer.from((await readFile(join(packDir, 'agents', name), 'utf8')).split('<技能目录>').join(realpathSync(packDir)));
      assert.deepEqual(await readFile(dest), src);
      await utimes(dest, fixedTime, fixedTime);
    }

    // Second run: every matching file stays untouched (same mtimeMs, no write).
    const second = await installAgents({ packRoot: packDir, cwd: workDir });
    assert.deepEqual(second.installed, []);
    assert.deepEqual(second.updated, []);
    assert.deepEqual(second.unchanged, AGENT_FILES);
    for (const name of AGENT_FILES) {
      const st = await stat(join(workDir, '.circle/agents', name));
      assert.equal(st.mtimeMs, fixedTime.getTime());
    }

    // Mutate one target file -> only that file is updated; others remain untouched.
    await writeFile(join(workDir, '.circle/agents/compile-writer.md'), 'stale content\n');
    await assert.rejects(installAgents({ packRoot: packDir, cwd: workDir }), /用户修改或不属于本包/);
    assert.equal(await readFile(join(workDir, '.circle/agents/compile-writer.md'), 'utf8'), 'stale content\n');

  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install-agents verifies pack.json digest before creating or writing target files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-digest-'));
  try {
    const packDir = await stage(join(root, 'skill'));
    const workDir = join(root, 'work');
    await mkdir(workDir);

    // Tamper agent file without updating pack.json -> must refuse and not create .circle/agents.
    const tamperedPack = join(root, 'tampered-skill');
    await cp(packDir, tamperedPack, { recursive: true });
    await writeFile(join(tamperedPack, 'agents/compile-fidelity.md'), 'tampered bytes\n');
    await assert.rejects(
      installAgents({ packRoot: tamperedPack, cwd: workDir }),
      /摘要或字节数不一致/,
    );
    await assert.rejects(stat(join(workDir, '.circle/agents')));

    // Missing agent file fails cleanly before touching .circle/agents.
    const missingAgentPack = join(root, 'missing-agent-skill');
    await cp(packDir, missingAgentPack, { recursive: true });
    await rm(join(missingAgentPack, 'agents/compile-attributor.md'));
    await assert.rejects(
      installAgents({ packRoot: missingAgentPack, cwd: workDir }),
      /缺少声明的子代理定义/,
    );
    await assert.rejects(stat(join(workDir, '.circle/agents')));

    const manifest = JSON.parse(await readFile(join(packDir, 'pack.json'), 'utf8'));
    const writerEntry = manifest.files.find((f: { path: string }) => f.path === 'agents/compile-writer.md');
    assert.equal(writerEntry.sha256, sha256Hex(await readFile(join(packDir, 'agents/compile-writer.md'))));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install-agents blocks path escapes and symlink escapes outside cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-escape-'));
  try {
    const packDir = await stage(join(root, 'skill'));
    const workDir = join(root, 'work');
    const outsideDir = join(root, 'outside');
    await mkdir(workDir);
    await mkdir(outsideDir);

    await assert.rejects(
      installAgents({ packRoot: packDir, cwd: workDir, out: '../outside' }),
      /超出当前工作目录/,
    );
    await assert.rejects(
      installAgents({ packRoot: packDir, cwd: workDir, out: outsideDir }),
      /超出当前工作目录/,
    );

    await mkdir(join(workDir, '.circle'));
    await symlink(outsideDir, join(workDir, '.circle/agents'));
    await assert.rejects(
      installAgents({ packRoot: packDir, cwd: workDir, out: '.circle/agents' }),
      /超出当前工作目录/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('staged CLI executes in workDir without leaking absolute paths and rejects bad option syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-cli-'));
  try {
    const packDir = await stage(join(root, 'skill'));
    const workDir = join(root, 'work');
    await mkdir(workDir);

    const run = spawnSync(
      process.execPath,
      [join(packDir, 'tools/install-agents.ts'), '--out', '.circle/agents'],
      { cwd: workDir, encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.target, '.circle/agents');
    assert.deepEqual(parsed.installed, AGENT_FILES);
    assert.ok(!run.stdout.includes(root));

    const repeat = spawnSync(process.execPath, [join(packDir, 'tools/install-agents.ts')], {
      cwd: workDir,
      encoding: 'utf8',
    });
    assert.equal(repeat.status, 0, repeat.stderr);
    const repeatOut = JSON.parse(repeat.stdout);
    assert.deepEqual(repeatOut.installed, []);
    assert.deepEqual(repeatOut.updated, []);
    assert.deepEqual(repeatOut.unchanged, AGENT_FILES);

    const errChunks: string[] = [];
    const stderrWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      errChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      for (const argv of [['--out=.circle/agents'], ['--unknown', 'x'], ['bare-arg']]) {
        errChunks.length = 0;
        const code = await main(argv);
        assert.equal(code, 1);
        assert.match(errChunks.join(''), /^参数无效：.+\n$/);
      }
    } finally {
      process.stderr.write = stderrWrite;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install-agents upgrades only receipted bytes and removes only unchanged obsolete definitions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-upgrade-'));
  try {
    const packDir = await stage(join(root, 'skill with spaces'));
    const workDir = join(root, 'work'); await mkdir(workDir);
    await installAgents({ packRoot: packDir, cwd: workDir });
    const target = join(workDir, '.circle/agents');
    await writeFile(join(target, 'user-role.md'), 'user-owned definition');
    const obsolete = Buffer.from('old packaged role');
    await writeFile(join(target, 'old-role.md'), obsolete);
    const receiptPath = join(target, '.case-compile.agents.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.files['old-role.md'] = sha256Hex(obsolete);
    await writeFile(receiptPath, JSON.stringify(receipt));
    const manifestPath = join(packDir, 'pack.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const definitionPath = join(packDir, 'agents/compile-writer.md');
    const upgraded = Buffer.from((await readFile(definitionPath, 'utf8')) + '\nSynthetic role upgrade\n');
    await writeFile(definitionPath, upgraded);
    const entry = manifest.files.find((entry: { path: string }) => entry.path === 'agents/compile-writer.md');
    entry.sha256 = sha256Hex(upgraded); entry.size = upgraded.length;
    await writeFile(manifestPath, JSON.stringify(manifest));
    const result = await installAgents({ packRoot: packDir, cwd: workDir });
    assert.deepEqual(result.updated, ['compile-writer.md']);
    assert.match(await readFile(join(target, 'compile-writer.md'), 'utf8'), /Synthetic role upgrade/);
    await assert.rejects(stat(join(target, 'old-role.md')));
    assert.equal(await readFile(join(target, 'user-role.md'), 'utf8'), 'user-owned definition');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('install-agents preserves edited obsolete definitions and refuses before any definition write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-install-user-'));
  try {
    const packDir = await stage(join(root, 'skill'));
    const workDir = join(root, 'work'); await mkdir(workDir);
    await installAgents({ packRoot: packDir, cwd: workDir });
    const target = join(workDir, '.circle/agents');
    const receiptPath = join(target, '.case-compile.agents.json');
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
    receipt.files['old-role.md'] = sha256Hex(Buffer.from('old packaged role'));
    await writeFile(receiptPath, JSON.stringify(receipt));
    await writeFile(join(target, 'old-role.md'), 'user edited old role');
    const before = await readFile(join(target, 'compile-writer.md'));
    await assert.rejects(installAgents({ packRoot: packDir, cwd: workDir }), /用户修改或不属于本包/);
    assert.equal(await readFile(join(target, 'old-role.md'), 'utf8'), 'user edited old role');
    assert.deepEqual(await readFile(join(target, 'compile-writer.md')), before);
    await writeFile(receiptPath, '{');
    await assert.rejects(installAgents({ packRoot: packDir, cwd: workDir }), /安装回执不是完整 JSON/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
