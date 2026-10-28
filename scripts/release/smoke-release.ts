// Executable file-install smoke; service/database/sandbox-negative acceptance remains a separate release gate.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activeVersion, command, installRelease, requireTarget, run, scratchEnvironment, sha256, type InstallOptions, type Runner } from './operations.ts';

type Identity = InstallOptions['expected'];
export async function smokeRelease(first: { root: string; expected: Identity }, next: { root: string; expected: Identity }, runner: Runner = run): Promise<{ installed: true; upgraded: true; relocated: true; tamperRejected: true; dataPreserved: true }> {
  requireTarget(first.expected.target);
  if (first.expected.target !== next.expected.target || first.expected.version === next.expected.version) throw new Error('升级冒烟需要同目标的两个不同版本');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'circle-hub-release-smoke-')));
  try {
    const moved = join(scratch, 'relocated release');
    cpSync(first.root, moved, { recursive: true, verbatimSymlinks: true });
    const prefix = join(scratch, 'install space'), dataRoot = join(scratch, 'data');
    mkdirSync(dataRoot);
    // Synthetic canaries cover each persisted home; no real configuration or secret is read.
    const persisted = ['db', 'objects', 'vault', 'config'].map((name) => {
      mkdirSync(join(dataRoot, name));
      const path = join(dataRoot, name, 'synthetic-receipt');
      writeFileSync(path, `synthetic ${name}`);
      return { path, sha256: sha256(readFileSync(path)) };
    });
    const env = scratchEnvironment(scratch);
    await installRelease(moved, { prefix, dataRoot, expected: first.expected, runner });
    if ((await command(runner, join(prefix, 'circle-hub'), ['--version'], env)).trim() !== first.expected.version) throw new Error('安装启动器版本冒烟失败');
    await installRelease(next.root, { prefix, dataRoot, expected: next.expected, runner });
    if ((await command(runner, join(prefix, 'circle-hub'), ['--version'], env)).trim() !== next.expected.version) throw new Error('升级启动器版本冒烟失败');
    const corrupt = join(scratch, 'corrupt'); cpSync(next.root, corrupt, { recursive: true, verbatimSymlinks: true });
    writeFileSync(join(corrupt, '__proto__'), 'synthetic extra file');
    let rejected = false;
    try { await installRelease(corrupt, { prefix, dataRoot, expected: next.expected, runner }); } catch (error) {
      if (!(error instanceof Error) || error.message !== '发行逐文件清单不一致') throw error;
      rejected = true;
    }
    if (!rejected || activeVersion(prefix) !== next.expected.version || (await command(runner, join(prefix, 'circle-hub'), ['--version'], env)).trim() !== next.expected.version) throw new Error('篡改拒绝冒烟失败');
    for (const item of persisted) if (sha256(readFileSync(item.path)) !== item.sha256) throw new Error('升级改变了持久数据');
    return { installed: true, upgraded: true, relocated: true, tamperRejected: true, dataPreserved: true };
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
