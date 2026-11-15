// 按 pack.json 声明校验包内 agents/*.md 摘要与字节数后，写入当前工作目录下 Circle 扫描的子代理目录（默认 .circle/agents）；已存在且摘要一致的文件保持原样：
//   node '<技能目录>/tools/install-agents.ts' [--out '<子代理目录>']
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertToolCliStdin, formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import cli from './install-agents.cli.json' with { type: 'json' };
import { isInsideRoot, resolveCwdRoots, resolveInsideCwd } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { out: false };
const USAGE = "node '<技能目录>/tools/install-agents.ts' [--out '<子代理目录>']";
const DEFAULT_OUT = '.circle/agents';
const AGENT_PATH_RE = /^agents\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_PACK_ROOT = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))));

export interface InstallAgentsResult {
  pack: string;
  version: string;
  target: string;
  installed: string[];
  updated: string[];
  unchanged: string[];
}

interface VerifiedAgent {
  name: string;
  bytes: Buffer;
  sha256: string;
  size: number;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function loadVerifiedAgents(packReal: string): Promise<{ pack: string; version: string; agents: VerifiedAgent[] }> {
  const manifestPath = join(packReal, 'pack.json');
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('不存在：找不到技能目录下的 pack.json 清单文件。请重新安装技能包后再运行');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('参数无效：pack.json 不是完整的 UTF-8 JSON。请重新安装技能包后再运行');
  }
  if (
    !isRecord(manifest) ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error('参数无效：pack.json 缺少 id、version 或 files 清单。请重新安装技能包后再运行');
  }
  const entries = manifest.files.filter(
    (entry): entry is { path: string; sha256: string; size: number } =>
      isRecord(entry) && typeof entry.path === 'string' && entry.path.startsWith('agents/'),
  );
  if (!entries.length) {
    throw new Error('不存在：pack.json 清单中没有声明 agents/ 子代理定义文件。请确认技能版本是否为 3.20.0 及以上');
  }
  const agents: VerifiedAgent[] = [];
  for (const entry of entries) {
    if (
      !AGENT_PATH_RE.test(entry.path) ||
      typeof entry.sha256 !== 'string' ||
      !SHA256_RE.test(entry.sha256) ||
      typeof entry.size !== 'number' ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0
    ) {
      throw new Error(`参数无效：pack.json 中条目 ${entry.path} 的路径、字节数或摘要格式不合法。请重新安装技能包后再运行`);
    }
    const sourcePath = join(packReal, entry.path);
    const stat = await lstat(sourcePath).catch(() => null);
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`不存在：包内缺少声明的子代理定义 ${entry.path}。请重新安装技能包后再运行`);
    }
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new Error(`参数无效：${entry.path} 与 pack.json 声明的摘要或字节数不一致，已中止写入。请重新安装技能包后再运行`);
    }
    agents.push({ name: basename(entry.path), bytes, sha256: entry.sha256, size: entry.size });
  }
  return { pack: manifest.id, version: manifest.version, agents };
}

async function writeVerifiedRegularFile(targetDir: string, name: string, bytes: Buffer, exists: boolean): Promise<void> {
  const destPath = join(targetDir, name);
  if (!exists) {
    await writeFile(destPath, bytes, { flag: 'wx', mode: 0o600 });
    return;
  }
  const handle = await open(destPath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

/**
 * Verifies every `agents/*.md` listed in `pack.json` and installs or updates
 * them under `cwd/<out>` (default `.circle/agents`), skipping matching files.
 */
export async function installAgents(options?: {
  out?: string;
  cwd?: string;
  packRoot?: string;
}): Promise<InstallAgentsResult> {
  const cwd = resolveCwdRoots(options?.cwd);
  const packReal = realpathSync(options?.packRoot ?? DEFAULT_PACK_ROOT);
  const { canonical } = resolveInsideCwd(cwd, options?.out ?? DEFAULT_OUT, '--out', '默认 .circle/agents');
  const { pack, version, agents } = await loadVerifiedAgents(packReal);

  await mkdir(canonical, { recursive: true });
  const targetReal = realpathSync(canonical);
  if (!isInsideRoot(targetReal, cwd.canonical)) {
    throw new Error('无权限：目标子代理目录解析后超出当前工作目录。请改用工作目录内的真实目录后重试');
  }

  const installed: string[] = [];
  const updated: string[] = [];
  const unchanged: string[] = [];

  for (const agent of agents) {
    const destPath = join(targetReal, agent.name);
    const existingStat = await lstat(destPath).catch((error: { code?: unknown }) => {
      if (error?.code === 'ENOENT') return null;
      throw error;
    });
    if (!existingStat) {
      await writeVerifiedRegularFile(targetReal, agent.name, agent.bytes, false);
      installed.push(agent.name);
      continue;
    }
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new Error(`已被占用：目标位置 ${agent.name} 不是普通文件。请清理该路径后重试`);
    }
    const existingBytes = await readFile(destPath);
    if (existingBytes.byteLength === agent.size && sha256Hex(existingBytes) === agent.sha256) {
      unchanged.push(agent.name);
      continue;
    }
    await writeVerifiedRegularFile(targetReal, agent.name, agent.bytes, true);
    updated.push(agent.name);
  }

  return {
    pack,
    version,
    target: relative(cwd.canonical, targetReal) || '.',
    installed,
    updated,
    unchanged,
  };
}

export async function main(argv: string[]): Promise<number> {
  try {
    assertToolCliStdin(cli, []);
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    const result = await installAgents(args.out !== undefined ? { out: args.out } : undefined);
    process.stdout.write(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
