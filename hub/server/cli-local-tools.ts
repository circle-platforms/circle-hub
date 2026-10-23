// Local client commands: no database, keychain, MCP, or execution of downloaded code.
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PackManifest, type PackManifest as Manifest } from '../../contracts/src/pack.ts';
import { canonicalBytes, sha256Hex } from '../records/api.ts';
import { isLoopbackAddress } from '../config/index.ts';
import { readPackDirectory } from '../runs/packs/directory.ts';
import { DEFAULT_PACK_LIMITS } from '../runs/packs/types.ts';
import { parsePackRef } from '../runs/packs/versions.ts';
import { readSecret, type SecretInput } from './assemble/secret-input.ts';
import { terminalSafe } from './assemble/terminal.ts';
import type { CliIo } from './api.ts';

const LIMITS = DEFAULT_PACK_LIMITS;
const LISTED_FILE = new Set(['manifest.digest_mismatch', 'manifest.size_mismatch', 'manifest.missing_file']);
const httpAgent = new HttpAgent({ keepAlive: false });
const httpsAgent = new HttpsAgent({ keepAlive: false });
export const LOCAL_TOOLS_USAGE = 'local-tools install <包>@<版本> --digest <包号> --into <目录> [--hub <回环地址>] | local-tools verify <目录> --digest <包号>';

/** Refusal decided at the throw site. The catch prints this text; it does not classify the error. */
export type LocalToolsReason =
  | { kind: 'mismatch'; path: string }
  | { kind: 'digest' }
  | { kind: 'into' }
  | { kind: 'address' }
  | { kind: 'unreachable'; address: string }
  | { kind: 'unauthorized' }
  | { kind: 'unavailable' }
  | { kind: 'integrity'; path: string }
  | { kind: 'redirect' }
  | { kind: 'filesystem'; path: string; code: string };

export class LocalToolsError extends Error {
  readonly reason: LocalToolsReason;
  constructor(reason: LocalToolsReason) {
    super(localToolsRefusal(reason));
    this.name = 'LocalToolsError';
    this.reason = reason;
  }
}

export function localToolsRefusal(reason: LocalToolsReason): string {
  switch (reason.kind) {
    case 'mismatch':
      return `本地工具核对未通过；第一处不符 ${reason.path}；重新核对来源和本地目录后重试`;
    case 'digest':
      return '必须给出 --digest <包号>；从控制台任务包页或运行摘要的 pack_digest 抄下包号后再试';
    case 'into':
      return '必须给出 --into <目录>；安装只写到这个目录里';
    case 'address':
      return '只接受回环地址；不要带路径、查询、账号，也不要指向别的机器';
    case 'unreachable':
      return `Hub 连不上 ${reason.address}；确认本机 Hub 已在这个回环地址监听后再试`;
    case 'unauthorized':
      return '令牌无效或已撤销；重新领取令牌后再试';
    case 'unavailable':
      return '这个版本没有分给你、已下架或不存在；向管理员确认分配后再试';
    case 'integrity':
      return `完整性核对未通过；第一处不符 ${reason.path}；重新取这一份后再试`;
    case 'redirect':
      return 'Hub 回答了重定向；只接受回环地址上的直接回答';
    case 'filesystem':
      return `本地目录无法写入 ${reason.path}（${reason.code}）；检查目录权限后重试`;
  }
}

function filesystem(path: string, error: unknown): LocalToolsError {
  const code = (error as NodeJS.ErrnoException).code;
  return new LocalToolsError({ kind: 'filesystem', path, code: typeof code === 'string' ? code : 'UNKNOWN' });
}

function requireMatch(ok: unknown, path = 'pack.json'): asserts ok {
  if (!ok) throw new LocalToolsError({ kind: 'mismatch', path });
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw filesystem(path, error);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Positive process id, or null when the text is not one. */
function ownerPid(text: string): number | null {
  const value = text.trim();
  if (!/^[1-9][0-9]*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

/** Staging directories are `.${ref}-<pid>-<random>`, so the pid is part of the name from the moment the directory exists. */
function pidInName(name: string, ref: string): number | null {
  const prefix = `.${ref}-`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const dash = rest.indexOf('-');
  return dash > 0 ? ownerPid(rest.slice(0, dash)) : null;
}

/** Drops a previous install's lock and any staging directory whose owner is gone. A live owner's directory stays, including one whose owner file is not written yet or was removed before verification. */
async function reclaim(into: string, ref: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(into);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw filesystem(into, error);
  }
  const prefix = `.${ref}-`;
  const lock = `.${ref}.install-lock`;
  for (const name of names) {
    if (name !== lock && !name.startsWith(prefix)) continue;
    const path = join(into, name);
    if (name === lock) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    // The name is the claim that exists for the whole life of the directory. The owner file covers directories created before that naming.
    const named = pidInName(name, ref);
    const recorded = named === null ? ownerPid(await readFile(join(path, '.install-owner'), 'utf8').catch(() => '')) : named;
    const live = recorded !== null && (recorded === process.pid || pidAlive(recorded));
    if (!live) await rm(path, { recursive: true, force: true });
  }
}

export function localHubAddress(value: string | undefined, env: NodeJS.ProcessEnv): URL {
  const address = value ?? `http://127.0.0.1:${env.CIRCLE_HUB_PORT ?? ''}`;
  if (value === undefined && !(/^\d+$/.test(env.CIRCLE_HUB_PORT ?? '') && Number(env.CIRCLE_HUB_PORT) > 0 && Number(env.CIRCLE_HUB_PORT) <= 65535)) {
    throw new LocalToolsError({ kind: 'address' });
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new LocalToolsError({ kind: 'address' });
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = (url.protocol === 'http:' || url.protocol === 'https:') && (host === 'localhost' || isLoopbackAddress(host)) && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '';
  if (!loopback) throw new LocalToolsError({ kind: 'address' });
  // Pin localhost to a literal loopback address; never delegate this boundary to DNS.
  if (host === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function download(url: URL, token: string, max: number, path: string): Promise<Buffer> {
  const secure = url.protocol === 'https:';
  const hostname = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const fail = (error: LocalToolsError): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const req = (secure ? httpsRequest : httpRequest)(
      {
        hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { authorization: `Bearer ${token}` },
        agent: secure ? httpsAgent : httpAgent,
        timeout: 30_000,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0;
        const refuse = (error: LocalToolsError): void => {
          res.resume();
          fail(error);
        };
        if (status === 401) return refuse(new LocalToolsError({ kind: 'unauthorized' }));
        if (status === 404) return refuse(new LocalToolsError({ kind: 'unavailable' }));
        if (status >= 300 && status < 400) return refuse(new LocalToolsError({ kind: 'redirect' }));
        if (status !== 200) return refuse(new LocalToolsError({ kind: 'integrity', path }));
        const declared = res.headers['content-length'];
        if (declared !== undefined && Number(declared) > max) return refuse(new LocalToolsError({ kind: 'integrity', path }));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > max) {
            req.destroy();
            refuse(new LocalToolsError({ kind: 'integrity', path }));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (settled) return;
          const bytes = Buffer.concat(chunks);
          const computed = sha256Hex(bytes);
          const digest = `sha-256=:${Buffer.from(computed, 'hex').toString('base64')}:`;
          if (res.headers['content-digest'] !== digest || res.headers.etag !== `"${computed}"`) {
            fail(new LocalToolsError({ kind: 'integrity', path }));
            return;
          }
          settled = true;
          resolvePromise(bytes);
        });
        res.on('error', () => fail(new LocalToolsError({ kind: 'unreachable', address: url.origin })));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      fail(new LocalToolsError({ kind: 'unreachable', address: url.origin }));
    });
    req.on('error', () => fail(new LocalToolsError({ kind: 'unreachable', address: url.origin })));
    req.end();
  });
}

export interface Verification {
  ok: boolean;
  digest: string | null;
  version: string | null;
  files: number;
  bytes: number;
  first: string | null;
  extras: string[];
}

/** JSON pointer `/files/<index>/...` names the manifest entry. The path is that entry, not the manifest file itself. */
function entryPath(field: string | undefined, manifest: { files: readonly { path: string }[] } | null): string | null {
  if (field === undefined || manifest === null) return null;
  const parts = field.split('/');
  if (parts.length < 3 || parts[0] !== '' || parts[1] !== 'files') return null;
  const index = Number(parts[2]);
  if (!Number.isInteger(index) || String(index) !== parts[2] || index < 0) return null;
  return manifest.files[index]?.path ?? null;
}

export async function verifyLocalTools(directory: string, pinned?: string): Promise<Verification> {
  const failed: Verification = { ok: false, digest: null, version: null, files: 0, bytes: 0, first: 'pack.json', extras: [] };
  const info = await lstat(directory).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) return failed;
  const read = await readPackDirectory(directory);
  if (!read.ok) {
    let manifest: Manifest | null = null;
    try {
      const path = join(directory, 'pack.json');
      const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= LIMITS.maxManifestBytes) {
        manifest = PackManifest.parse(JSON.parse(await readFile(path, 'utf8')));
      }
    } catch {
      manifest = null;
    }
    const firstProblem = read.problems[0];
    const listed = firstProblem !== undefined && LISTED_FILE.has(firstProblem.rule) ? entryPath(firstProblem.field, manifest) : null;
    const result: Verification = {
      ok: false,
      digest: manifest === null ? null : sha256Hex(canonicalBytes(manifest)),
      version: manifest?.version ?? null,
      files: manifest?.files.length ?? 0,
      bytes: manifest === null ? 0 : manifest.files.reduce((n, file) => n + file.size, 0),
      first: listed ?? firstProblem?.file ?? 'pack.json',
      extras: read.problems.filter((problem) => problem.rule === 'manifest.unlisted_file').map((problem) => problem.file),
    };
    if (pinned !== undefined && result.digest !== pinned) return { ...result, ok: false, first: 'pack.json' };
    return result;
  }
  const result: Verification = {
    ok: true,
    digest: read.pack.digest,
    version: read.pack.manifest.version,
    files: read.pack.files.length,
    bytes: read.pack.files.reduce((n, file) => n + file.size, 0),
    first: null,
    extras: [],
  };
  if (pinned !== undefined && result.digest !== pinned) return { ...result, ok: false, first: 'pack.json' };
  return result;
}

export async function installLocalTools(ref: string, digest: string, into: string, hub: URL, token: string): Promise<{ verified: Verification; installed: boolean }> {
  const parsed = parsePackRef(ref);
  requireMatch(parsed?.version && /^[a-f0-9]{64}$/.test(digest), 'pack.json');
  requireMatch(token !== '' && !/[\r\n\u0000]/.test(token), 'authorization');
  const base = new URL(`/local-tools/${ref}`, hub);
  const bytes = await download(base, token, LIMITS.maxManifestBytes, 'pack.json');
  requireMatch(sha256Hex(bytes) === digest);
  let manifest: Manifest;
  try {
    manifest = PackManifest.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  } catch {
    throw new LocalToolsError({ kind: 'mismatch', path: 'pack.json' });
  }
  requireMatch(Buffer.from(canonicalBytes(manifest)).equals(bytes) && manifest.id === parsed.id && manifest.version === parsed.version && manifest.files.some((file) => file.path.startsWith('tools/')));
  requireMatch(manifest.files.length <= LIMITS.maxFiles && manifest.files.every((file) => file.size <= LIMITS.maxFileBytes && file.path.split('/').length <= LIMITS.maxDepth + 1) && manifest.files.reduce((n, file) => n + file.size, 0) <= LIMITS.maxTotalBytes);
  const target = join(into, ref);
  const sameTarget = async () => {
    const verified = await verifyLocalTools(target);
    requireMatch(verified.ok && verified.digest === digest && Buffer.from(await readFile(join(target, 'pack.json'))).equals(bytes), verified.first ?? 'pack.json');
    return { verified, installed: true };
  };
  if (await exists(target)) return sameTarget();
  const createdParent = !(await exists(into));
  let temporary: string | null = null;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    const path = temporary;
    const finish = (): void => process.exit(signal === 'SIGINT' ? 130 : 143);
    if (path === null) finish();
    else void rm(path, { recursive: true, force: true }).then(finish, finish);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    try {
      await mkdir(into, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw filesystem(into, error);
    }
    await reclaim(into, ref);
    if (await exists(target)) return await sameTarget();
    try {
      temporary = await mkdtemp(join(into, `.${ref}-${process.pid}-`));
      await writeFile(join(temporary, '.install-owner'), `${process.pid}\n`, { mode: 0o600 });
    } catch (error) {
      throw filesystem(into, error);
    }
    try {
      await writeFile(join(temporary, 'pack.json'), bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      throw filesystem(join(temporary, 'pack.json'), error);
    }
    for (const file of manifest.files) {
      const original = await download(new URL(`${base.pathname}/${file.path}`, hub), token, file.size, file.path);
      if (original.length !== file.size || sha256Hex(original) !== file.sha256) throw new LocalToolsError({ kind: 'integrity', path: file.path });
      const path = join(temporary, file.path);
      try {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, original, { mode: 0o600, flag: 'wx' });
      } catch (error) {
        throw filesystem(path, error);
      }
    }
    const staging = temporary;
    await rm(join(staging, '.install-owner'), { force: true });
    const verified = await verifyLocalTools(staging);
    requireMatch(verified.ok && verified.digest === digest, verified.first ?? 'pack.json');
    try {
      await rename(staging, target);
      temporary = null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'EEXIST' || code === 'ENOTEMPTY') && (await exists(target))) {
        await rm(staging, { recursive: true, force: true });
        temporary = null;
        return await sameTarget();
      }
      throw filesystem(target, error);
    }
    return { verified, installed: false };
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    if (temporary !== null) await rm(temporary, { recursive: true, force: true });
    if (createdParent) await rmdir(into).catch(() => {});
  }
}

function resultLine(value: Verification): string {
  return `包号 ${value.digest ?? '-'}；版本 ${value.version ?? '-'}；文件数 ${value.files}；字节数 ${value.bytes}${value.first === null ? '' : `；第一处不符 ${value.first}`}`;
}

function pinnedDigest(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new LocalToolsError({ kind: 'digest' });
  return value;
}

export async function localToolsCommand(args: readonly string[], io: CliIo, secret: SecretInput = {}): Promise<number> {
  try {
    const action = args[0];
    if (action !== 'install' && action !== 'verify') {
      io.stderr(LOCAL_TOOLS_USAGE);
      return 2;
    }
    let parsed;
    try {
      parsed = parseArgs({
        args: [...args.slice(1)],
        allowPositionals: true,
        strict: true,
        options: action === 'install' ? { digest: { type: 'string' }, into: { type: 'string' }, hub: { type: 'string' } } : { digest: { type: 'string' } },
      });
    } catch {
      io.stderr(LOCAL_TOOLS_USAGE);
      return 2;
    }
    if (parsed.positionals.length !== 1) {
      io.stderr(LOCAL_TOOLS_USAGE);
      return 2;
    }
    const digest = pinnedDigest(parsed.values.digest);
    if (action === 'verify') {
      const verified = await verifyLocalTools(resolve(io.cwd, parsed.positionals[0]!), digest);
      io.stdout(terminalSafe(resultLine(verified)));
      for (const path of verified.extras) io.stdout(terminalSafe(`多出的文件 ${path}`));
      return verified.ok ? 0 : 1;
    }
    if (typeof parsed.values.into !== 'string' || parsed.values.into === '') throw new LocalToolsError({ kind: 'into' });
    const hub = localHubAddress(parsed.values.hub as string | undefined, io.env);
    const token = await readSecret('Bearer 令牌', { ...secret, prompt: secret.prompt ?? io.stderr });
    const result = await installLocalTools(parsed.positionals[0]!, digest, resolve(io.cwd, parsed.values.into), hub, token);
    io.stdout(terminalSafe(`${result.installed ? '已安装；' : ''}${resultLine(result.verified)}`));
    return 0;
  } catch (error) {
    if (error instanceof LocalToolsError) {
      io.stderr(terminalSafe(error.message));
      return 1;
    }
    io.stderr(terminalSafe('本地工具核对未通过；出现了没有归类的错误；把这条输出交给管理员'));
    return 1;
  }
}
