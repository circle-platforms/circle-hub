// Local client commands: no database, keychain, MCP, or execution of downloaded code.
import { lstat, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
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
export const LOCAL_TOOLS_USAGE = 'local-tools install <包>@<版本> --digest <包号> --into <目录> [--hub <回环地址>] | local-tools verify <目录>';
class LocalToolsError extends Error { path: string; constructor(path: string) { super('本地工具核对未通过'); this.path = path; } }
function requireMatch(ok: unknown, path = 'pack.json'): asserts ok { if (!ok) throw new LocalToolsError(path); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } }
export function localHubAddress(value: string | undefined, env: NodeJS.ProcessEnv): URL {
  const address = value ?? `http://127.0.0.1:${env.CIRCLE_HUB_PORT ?? ''}`; let url: URL;
  if (value === undefined) requireMatch(/^\d+$/.test(env.CIRCLE_HUB_PORT ?? '') && Number(env.CIRCLE_HUB_PORT) > 0 && Number(env.CIRCLE_HUB_PORT) <= 65535, 'hub');
  try { url = new URL(address); } catch { throw new LocalToolsError('hub'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  requireMatch((url.protocol === 'http:' || url.protocol === 'https:') && (host === 'localhost' || isLoopbackAddress(host)) && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === '', 'hub');
  // Pin localhost to a literal loopback address; never delegate this boundary to DNS.
  if (host === 'localhost') url.hostname = '127.0.0.1'; return url;
}
async function download(url: URL, token: string, max: number, path: string): Promise<Buffer> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new LocalToolsError(path); }
  if (response.headers.has('content-length') && Number(response.headers.get('content-length')) > max) { await response.body.cancel(); throw new LocalToolsError(path); }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; requireMatch(size <= max, path); chunks.push(value); } } finally { await reader.cancel().catch(() => {}); }
  const bytes = Buffer.concat(chunks); const computed = sha256Hex(bytes);
  requireMatch(response.headers.get('content-digest') === `sha-256=:${Buffer.from(computed, 'hex').toString('base64')}:` && response.headers.get('etag') === `"${computed}"`, path);
  return bytes;
}
export interface Verification { ok: boolean; digest: string | null; version: string | null; files: number; bytes: number; first: string | null; extras: string[] }
export async function verifyLocalTools(directory: string): Promise<Verification> {
  const failed: Verification = { ok: false, digest: null, version: null, files: 0, bytes: 0, first: 'pack.json', extras: [] };
  const info = await lstat(directory).catch(() => null); if (!info?.isDirectory() || info.isSymbolicLink()) return failed;
  const read = await readPackDirectory(directory);
  if (!read.ok) {
    let metadata = failed;
    try {
      const path = join(directory, 'pack.json'); const stat = await lstat(path);
      if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= LIMITS.maxManifestBytes) {
        const manifest = PackManifest.parse(JSON.parse(await readFile(path, 'utf8')));
        metadata = { ...failed, digest: sha256Hex(canonicalBytes(manifest)), version: manifest.version, files: manifest.files.length, bytes: manifest.files.reduce((n, f) => n + f.size, 0) };
      }
    } catch { /* No valid identity is available; the first mismatch remains explicit. */ }
    const extras = read.problems.filter((p) => p.rule === 'manifest.unlisted_file').map((p) => p.file);
    return { ...metadata, first: read.problems[0]?.file ?? 'pack.json', extras };
  }
  return { ok: true, digest: read.pack.digest, version: read.pack.manifest.version, files: read.pack.files.length, bytes: read.pack.files.reduce((n, f) => n + f.size, 0), first: null, extras: [] };
}
export async function installLocalTools(ref: string, digest: string, into: string, hub: URL, token: string): Promise<{ verified: Verification; installed: boolean }> {
  const parsed = parsePackRef(ref); requireMatch(parsed?.version && /^[a-f0-9]{64}$/.test(digest), 'pack.json');
  requireMatch(token !== '' && !/[\r\n\u0000]/.test(token), 'authorization');
  const base = new URL(`/local-tools/${ref}`, hub); const bytes = await download(base, token, LIMITS.maxManifestBytes, 'pack.json');
  requireMatch(sha256Hex(bytes) === digest);
  let manifest: Manifest;
  try { manifest = PackManifest.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); } catch { throw new LocalToolsError('pack.json'); }
  requireMatch(Buffer.from(canonicalBytes(manifest)).equals(bytes) && manifest.id === parsed.id && manifest.version === parsed.version && manifest.files.some((f) => f.path.startsWith('tools/')));
  requireMatch(manifest.files.length <= LIMITS.maxFiles && manifest.files.every((f) => f.size <= LIMITS.maxFileBytes && f.path.split('/').length <= LIMITS.maxDepth + 1) && manifest.files.reduce((n, f) => n + f.size, 0) <= LIMITS.maxTotalBytes);
  const target = join(into, ref);
  const sameTarget = async () => {
    const verified = await verifyLocalTools(target);
    requireMatch(verified.ok && verified.digest === digest && Buffer.from(await readFile(join(target, 'pack.json'))).equals(bytes), verified.first ?? 'pack.json');
    return { verified, installed: true };
  };
  if (await exists(target)) return sameTarget();
  const createdParent = !(await exists(into)); let temporary: string | null = null; const lock = join(into, `.${ref}.install-lock`); let locked = false;
  try {
    await mkdir(into, { recursive: true, mode: 0o700 }); await mkdir(lock, { mode: 0o700 }); locked = true;
    if (await exists(target)) return await sameTarget();
    temporary = await mkdtemp(join(into, `.${ref}-`));
    await writeFile(join(temporary, 'pack.json'), bytes, { mode: 0o600, flag: 'wx' });
    for (const file of manifest.files) {
      const original = await download(new URL(`${base.pathname}/${file.path}`, hub), token, file.size, file.path);
      requireMatch(original.length === file.size && sha256Hex(original) === file.sha256, file.path);
      const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, original, { mode: 0o600, flag: 'wx' });
    }
    const verified = await verifyLocalTools(temporary); requireMatch(verified.ok && verified.digest === digest, verified.first ?? 'pack.json');
    requireMatch(!(await exists(target)), 'pack.json'); await rename(temporary, target); temporary = null;
    return { verified, installed: false };
  } finally {
    if (temporary !== null) await rm(temporary, { recursive: true, force: true });
    if (locked) await rmdir(lock);
    if (createdParent) await rmdir(into).catch(() => {});
  }
}
function resultLine(value: Verification): string { return `包号 ${value.digest ?? '-'}；版本 ${value.version ?? '-'}；文件数 ${value.files}；字节数 ${value.bytes}${value.first === null ? '' : `；第一处不符 ${value.first}`}`; }
export async function localToolsCommand(args: readonly string[], io: CliIo, secret: SecretInput = {}): Promise<number> {
  try {
    const action = args[0];
    if (action !== 'install' && action !== 'verify') { io.stderr(LOCAL_TOOLS_USAGE); return 2; }
    let parsed;
    try { parsed = parseArgs({ args: [...args.slice(1)], allowPositionals: true, strict: true, options: action === 'install' ? { digest: { type: 'string' }, into: { type: 'string' }, hub: { type: 'string' } } : {} }); } catch { io.stderr(LOCAL_TOOLS_USAGE); return 2; }
    if (parsed.positionals.length !== 1) { io.stderr(LOCAL_TOOLS_USAGE); return 2; }
    if (action === 'verify') {
      const verified = await verifyLocalTools(resolve(io.cwd, parsed.positionals[0]!)); io.stdout(terminalSafe(resultLine(verified)));
      for (const path of verified.extras) io.stdout(terminalSafe(`多出的文件 ${path}`)); return verified.ok ? 0 : 1;
    }
    requireMatch(typeof parsed.values.digest === 'string' && typeof parsed.values.into === 'string', 'pack.json');
    const hub = localHubAddress(parsed.values.hub as string | undefined, io.env);
    const token = await readSecret('Bearer 令牌', { ...secret, prompt: secret.prompt ?? io.stderr });
    const result = await installLocalTools(parsed.positionals[0]!, parsed.values.digest, resolve(io.cwd, parsed.values.into), hub, token);
    io.stdout(terminalSafe(`${result.installed ? '已安装；' : ''}${resultLine(result.verified)}`)); return 0;
  } catch (error) {
    io.stderr(terminalSafe(`本地工具核对未通过；第一处不符 ${error instanceof LocalToolsError ? error.path : 'pack.json'}；重新核对来源和本地目录后重试`)); return 1;
  }
}
