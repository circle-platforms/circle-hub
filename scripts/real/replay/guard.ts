import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePrivate } from './bundle.ts';
import type { Interpret } from './protocol.ts';
import { ReplayError, requireFact, sha } from './types.ts';

export type GuardFile = string | { base64: string };
export const guardFileBytes = (file: GuardFile): Buffer => typeof file === 'string' ? Buffer.from(file, 'utf8') : Buffer.from(file.base64, 'base64');
export function validGuardFile(file: unknown): file is GuardFile {
  return typeof file === 'string' || (typeof file === 'object' && file !== null && Object.keys(file).join() === 'base64' && typeof (file as { base64: unknown }).base64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test((file as { base64: string }).base64));
}
export const safeName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && !isAbsolute(name) && name.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.includes('\\') && !part.includes('\0'));

export interface Mirror {
  from: string;
  to: string;
}
const PLAIN_PREFIX = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const MIN_RANDOM = 8;
export function mirrorBase(requested?: string): string {
  const candidates = requested ? [requested] : ['/tmp', tmpdir()];
  for (const candidate of candidates) {
    try { return realpathSync(candidate); } catch { /* try the next candidate */ }
  }
  throw new ReplayError('没有可用的临时目录来建立等长镜像前缀', 2);
}
export function createMirror(from: string, requestedBase?: string): Mirror {
  requireFact(PLAIN_PREFIX.test(from) && !from.split('/').some(part => part === '.' || part === '..'), '镜像前缀必须是只含字母、数字、点、下划线和连字符的绝对目录路径');
  const base = mirrorBase(requestedBase);
  const room = from.length - base.length - 1;
  if (room < MIN_RANDOM)
    throw new ReplayError('镜像前缀太短，无法建立等长的私有前缀', 2, { fromLength: from.length, baseLength: base.length });
  for (let attempt = 0; attempt < 8; attempt++) {
    const to = `${base}/${randomBytes(Math.ceil(room / 2)).toString('hex').slice(0, room)}`;
    try {
      mkdirSync(to, { mode: 0o700 });
      return { from, to };
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new ReplayError('无法建立镜像前缀目录', 2);
    }
  }
  throw new ReplayError('无法为镜像前缀找到未被占用的目录名', 2);
}
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function toMirror<T>(value: T, mirror: Mirror): T {
  const pattern = new RegExp(`(?<![A-Za-z0-9._/-])${escapeRegExp(mirror.from)}(?![A-Za-z0-9._-])`, 'g');
  const walk = (item: unknown): unknown => typeof item === 'string' ? item.replace(pattern, () => mirror.to) : Array.isArray(item) ? item.map(walk) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, walk(entry)])) : item;
  return walk(value) as T;
}
export const fromMirror = (text: string, mirror: Mirror): string => text.split(mirror.to).join(mirror.from);

export interface SandboxOptions {
  files: Record<string, GuardFile>;
  replace?: { name: string; bytes: Uint8Array };
  mirror?: { from: string; base?: string };
  mapped?: string[];
}
export class GuardSandbox {
  readonly root: string;
  readonly mirror?: Mirror;
  constructor(options: SandboxOptions) {
    if (options.mirror) {
      this.mirror = createMirror(options.mirror.from, options.mirror.base);
      this.root = this.mirror.to;
    }
    else
      this.root = realpathSync(mkdtempSync(join(tmpdir(), 'circle-replay-guard-')));
    try {
      const names = new Set(Object.keys(options.files));
      if (options.replace)
        names.add(options.replace.name);
      for (const name of names) {
        requireFact(safeName(name), '守卫文件路径无效');
        let bytes = options.replace?.name === name ? options.replace.bytes : guardFileBytes(options.files[name]);
        if (this.mirror && options.mapped?.includes(name))
          bytes = Buffer.from(toMirror(Buffer.from(bytes).toString('utf8'), this.mirror), 'utf8');
        mkdirSync(dirname(join(this.root, name)), { recursive: true, mode: 0o700 });
        writeFileSync(join(this.root, name), bytes, { mode: 0o600 });
      }
      mkdirSync(join(this.root, 'work'), { recursive: true, mode: 0o700 });
    }
    catch (error) {
      this.dispose();
      throw error;
    }
  }
  input(input: Record<string, unknown>): Record<string, unknown> {
    if (!this.mirror)
      return { ...input, cwd: join(this.root, 'work') };
    const mapped = toMirror(input, this.mirror);
    if (typeof mapped.cwd === 'string' && mapped.cwd.startsWith(this.root + '/'))
      mkdirSync(mapped.cwd, { recursive: true, mode: 0o700 });
    else
      mapped.cwd = join(this.root, 'work');
    return mapped;
  }
  dispose(): void { rmSync(this.root, { recursive: true, force: true }); }
}

export const interpretGuardOutput: Interpret = (exitCode, stdout, stderr) => {
  const text = stdout.trim();
  let parsed: Record<string, unknown> | undefined;
  let invalid = false;
  if (text) {
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value))
        parsed = value as Record<string, unknown>;
      else
        invalid = true;
    }
    catch { invalid = true; }
  }
  const field = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  const named = field(parsed?.decision);
  const decision = (['allow', 'deny', 'ask'] as const).find(item => item === named);
  const reason = field(parsed?.reason) || stderr.trim().slice(0, 2000);
  const message = reason || (parsed ? '' : text.slice(0, 100000));
  if (exitCode === 2)
    return { decision: 'deny', reason: message || 'hook denied', failed: false };
  if (exitCode !== 0)
    return { decision: 'deny', reason: message || `hook exited ${exitCode ?? 'unknown'}`, failed: true };
  if (invalid)
    return { decision: 'deny', reason: 'hook output is not JSON', failed: true };
  if (decision)
    return { decision, reason: reason || (decision === 'deny' ? 'hook denied' : ''), failed: false };
  return { decision: 'none', reason: '', failed: false };
};

export interface GuardRun {
  decision: 'allow' | 'deny' | 'ask' | 'none';
  reason: string;
  failed: boolean;
  exitCode: number | null;
  stdoutSha256: string;
  stderrSha256: string;
  outsideReads: string[];
  rewritten?: boolean;
  legacy?: boolean;
}
export interface RunGuardOptions {
  env?: Record<string, string>;
  interpret?: Interpret;
}
const PRELOAD = fileURLToPath(new URL('./guard-preload.mjs', import.meta.url));
const OUTPUT_LIMIT = 1048576;
export function runGuard(sandbox: GuardSandbox, entry: string, input: Record<string, unknown>, timeoutMs: number, evidence: string, options: RunGuardOptions = {}): Promise<GuardRun> {
  requireFact(safeName(entry), '守卫入口路径无效');
  const stdin = JSON.stringify(input);
  writePrivate(evidence, 'input.json', stdin);
  return new Promise((resolve, reject) => {
    const env: Record<string, string> = { CIRCLE_NO_UPDATE_CHECK: '1', CIRCLE_NO_MODELS_REFRESH: '1', ...options.env };
    if (!sandbox.mirror)
      env.CIRCLE_HOME = sandbox.root;
    const cwd = sandbox.mirror && typeof input.cwd === 'string' ? input.cwd : join(sandbox.root, 'work');
    const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${sandbox.root}`, `--allow-fs-read=${dirname(PRELOAD)}`, '--import', PRELOAD, join(sandbox.root, entry)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [], side: Buffer[] = [];
    let size = 0, failed: string | undefined;
    const stop = (cause: string) => { failed ??= cause; child.kill('SIGKILL'); };
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const collect = (into: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > OUTPUT_LIMIT)
        stop('output-limit');
      else
        into.push(data);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.stdio[3]?.on('data', collect(side));
    child.once('error', () => { clearTimeout(timer); reject(new ReplayError('候选守卫无法启动', 2, { cause: 'spawn' })); });
    child.stdin.on('error', () => { });
    child.stdin.end(stdin);
    child.once('close', code => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString();
      let outside: string[] = [];
      try {
        const value = JSON.parse(Buffer.concat(side).toString() || '[]');
        outside = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
      }
      catch { /* a report that did not arrive whole counts as none */ }
      const forbidden = err.includes('REPLAY_NETWORK_BLOCKED') || /ERR_ACCESS_DENIED[\s\S]*(?:FileSystemWrite|ChildProcess|WorkerThreads)/.test(err);
      writePrivate(evidence, 'stdout.txt', out);
      writePrivate(evidence, 'stderr.txt', err);
      writePrivate(evidence, 'receipt.json', JSON.stringify({ exitCode: code, failure: failed ?? (forbidden ? 'forbidden-operation' : null), inputSha256: sha(stdin), stdoutSha256: sha(out), stderrSha256: sha(err), outsideReads: outside }));
      if (failed || forbidden)
        return reject(new ReplayError(failed ? '候选守卫达到注入限额或输出上限，没有给出决定' : '候选守卫尝试了不允许的网络、进程或文件写入操作', 2, { cause: failed ?? 'forbidden-operation' }));
      const outcome = (options.interpret ?? interpretGuardOutput)(code, out, err);
      resolve({ decision: outcome.decision, reason: outcome.reason, failed: outcome.failed, exitCode: code, stdoutSha256: sha(out), stderrSha256: sha(err), outsideReads: outside, ...(outcome.rewritten ? { rewritten: true } : {}), ...(outcome.legacy ? { legacy: true } : {}) });
    });
  });
}
