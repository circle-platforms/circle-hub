import { CallFailure } from '../functions/text.ts';
// 按 pack.json 声明校验包内 agents/*.md 摘要与字节数后，写入当前工作目录下 Circle 扫描的子代理目录（默认 .circle/agents）；已存在且摘要一致的文件保持原样：
//   node <技能目录>/tools/install-agents.ts [--out <子代理目录>]
import { createHash } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile, rm } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import { isInsideRoot, resolveCwdRoots, resolveInsideCwd } from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = { out: false };
const USAGE = 'node <技能目录>/tools/install-agents.ts [--out <子代理目录>]';
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
  const manifestStat = await lstat(manifestPath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!manifestStat || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    throw new CallFailure('not_found', '不存在：找不到技能目录下的 pack.json 清单文件。请重新安装技能包后再运行', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CallFailure('invalid_parameters', '参数无效：pack.json 不是完整的 UTF-8 JSON。请重新安装技能包后再运行', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  }
  if (
    !isRecord(manifest) ||
    typeof manifest.id !== 'string' ||
    !manifest.id ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !Array.isArray(manifest.files)
  ) {
    throw new CallFailure('invalid_parameters', '参数无效：pack.json 缺少 id、version 或 files 清单。请重新安装技能包后再运行', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  }
  const entries = manifest.files.filter(
    (entry): entry is { path: string; sha256: string; size: number } =>
      isRecord(entry) && typeof entry.path === 'string' && entry.path.startsWith('agents/'),
  );
  if (!entries.length) {
    throw new CallFailure('not_found', '不存在：pack.json 清单中没有声明 agents/ 子代理定义文件。请确认技能版本是否为 3.20.0 及以上', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
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
      throw new CallFailure('invalid_parameters', `参数无效：pack.json 中条目 ${entry.path} 的路径、字节数或摘要格式不合法。请重新安装技能包后再运行`, "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    }
    const sourcePath = join(packReal, entry.path);
    const sourceDir = await lstat(join(packReal, 'agents'));
    if (!sourceDir.isDirectory() || sourceDir.isSymbolicLink()) throw new CallFailure('invalid_parameters', '包内 agents 不是普通目录', '重新安装完整技能包后重试', { path: 'agents' });
    if (agents.some(agent => agent.name === basename(entry.path))) throw new CallFailure('invalid_parameters', '包清单重复声明了同名子代理定义', '修正清单使每个角色定义只有一个来源后重试', { path: entry.path });
    const stat = await lstat(sourcePath).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      throw new CallFailure('not_found', `不存在：包内缺少声明的子代理定义 ${entry.path}。请重新安装技能包后再运行`, "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    }
    const bytes = await readFile(sourcePath);
    if (bytes.byteLength !== entry.size || sha256Hex(bytes) !== entry.sha256) {
      throw new CallFailure('invalid_parameters', `参数无效：${entry.path} 与 pack.json 声明的摘要或字节数不一致，已中止写入。请重新安装技能包后再运行`, "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    }
    const rendered = Buffer.from(bytes.toString('utf8').split('<技能目录>').join(packReal));
    agents.push({ name: basename(entry.path), bytes: rendered, sha256: sha256Hex(rendered), size: rendered.byteLength });
  }
  return { pack: manifest.id, version: manifest.version, agents };
}

async function writeVerifiedRegularFile(targetDir: string, name: string, bytes: Buffer, priorDigest?: string): Promise<void> {
  const destPath = join(targetDir, name);
  if (priorDigest === undefined) {
    await writeFile(destPath, bytes, { flag: 'wx', mode: 0o600 });
    return;
  }
  const handle = await open(destPath, constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!(await handle.stat()).isFile() || sha256Hex(await handle.readFile()) !== priorDigest) throw new CallFailure('occupied', '安装期间子代理定义已变化，未覆盖', '保留修改并检查目标文件后重新安装', { path: name });
    await handle.truncate(0);
    await handle.write(bytes, 0, bytes.length, 0);
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
    throw new CallFailure('permission_denied', '无权限：目标子代理目录解析后超出当前工作目录。请改用工作目录内的真实目录后重试', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  }

  const receiptFile = join(targetReal, '.case-compile.agents.json');
  const receiptStat = await lstat(receiptFile).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (receiptStat && (!receiptStat.isFile() || receiptStat.isSymbolicLink())) throw new CallFailure('occupied', '已被占用：子代理安装回执不是普通文件，请运行者检查', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  let prior: unknown = null;
  if (receiptStat) {
    try { prior = JSON.parse(await readFile(receiptFile, 'utf8')); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; throw new CallFailure('invalid_parameters', '子代理安装回执不是完整 JSON', '保留现有定义，请运行者检查回执后重试', { path: '.case-compile.agents.json' }); }
  }
  if (prior !== null && (!isRecord(prior) || prior.pack !== pack || !isRecord(prior.files))) throw new CallFailure('invalid_parameters', '参数无效：子代理安装回执格式或所属包不符', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
  const owned: Record<string, unknown> = isRecord(prior) && isRecord(prior.files) ? prior.files : {};
  // Inspect all existing and stale files before the first write, preserving user edits.
  const wanted = new Map(agents.map(agent => [agent.name, agent.sha256]));
  for (const name of new Set([...wanted.keys(), ...Object.keys(owned)])) {
    if (Object.hasOwn(owned, name) && (typeof owned[name] !== 'string' || !SHA256_RE.test(owned[name]))) throw new CallFailure('invalid_parameters', '安装回执中的摘要不合法', '保留现有定义，请运行者核对安装回执后重试', { path: name });
    if (!AGENT_PATH_RE.test('agents/' + name)) throw new CallFailure('invalid_parameters', '参数无效：安装回执中的定义文件名不合法', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    const path = join(targetReal, name), info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink()) throw new CallFailure('occupied', '已被占用：子代理定义不是普通文件', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    const digest = sha256Hex(await readFile(path));
    if (digest !== wanted.get(name) && digest !== owned[name]) throw new CallFailure('occupied', '已被占用：子代理定义已由用户修改或不属于本包，未覆盖', "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
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
      await writeVerifiedRegularFile(targetReal, agent.name, agent.bytes);
      installed.push(agent.name);
      continue;
    }
    if (!existingStat.isFile() || existingStat.isSymbolicLink()) {
      throw new CallFailure('occupied', `已被占用：目标位置 ${agent.name} 不是普通文件。请清理该路径后重试`, "请核对本包清单与安装回执，保留用户修改的定义，修正后重试 install-agents.ts");
    }
    const existingBytes = await readFile(destPath);
    if (existingBytes.byteLength === agent.size && sha256Hex(existingBytes) === agent.sha256) {
      unchanged.push(agent.name);
      continue;
    }
    await writeVerifiedRegularFile(targetReal, agent.name, agent.bytes, typeof owned[agent.name] === 'string' ? owned[agent.name] as string : agent.sha256);
    updated.push(agent.name);
  }

  for (const name of Object.keys(owned)) if (!wanted.has(name)) {
    const path = join(targetReal, name), info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
    if (!info) continue;
    if (!info.isFile() || info.isSymbolicLink() || sha256Hex(await readFile(path)) !== owned[name]) throw new CallFailure('occupied', '旧角色定义在安装期间变化，未删除', '保留修改，请运行者检查旧角色定义后重试', { path: name });
    await rm(path);
  }
  await writeFile(receiptFile, JSON.stringify({ pack, version, files: Object.fromEntries(wanted) }) + '\n', { mode: 0o600 });

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
