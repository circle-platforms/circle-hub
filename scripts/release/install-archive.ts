// Explicit-version download/install entry. Same-origin SHA sidecars are integrity evidence, not signatures.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { extractArchive } from './archive.ts';
import { assetName, Manifest, targetFor } from './integrity.ts';
import { installRelease, requireTarget, sha256, type InstallOptions } from './operations.ts';

export type AssetDownload = (url: string, maxBytes: number) => Promise<Uint8Array>;
const REDIRECT_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

export function createAssetDownloader(fetcher: typeof fetch = fetch): AssetDownload { return async (url, maxBytes) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('发行下载大小上限不合法');
  let current = new URL(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== 'https:' || current.port || current.username || current.password || current.hash || !REDIRECT_HOSTS.has(current.hostname)) throw new Error('发行下载地址不在允许的 HTTPS 来源内');
    const response = await fetcher(current, { redirect: 'manual', signal: AbortSignal.timeout(120_000), credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('发行下载重定向缺少地址');
      current = new URL(location, current); continue;
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('发行下载失败'); }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); throw new Error('发行下载超过大小上限'); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        const item = await reader.read(); if (item.done) break;
        total += item.value.length;
        if (total > maxBytes) throw new Error('发行下载超过大小上限');
        chunks.push(item.value);
      }
      return Buffer.concat(chunks);
    } finally { await reader.cancel().catch(() => {}); }
  }
  throw new Error('发行下载重定向次数超限');
}; }
export const downloadAsset: AssetDownload = createAssetDownloader();

export interface ArchiveInstallOptions extends InstallOptions {
  repository: string;
  /** Supplied through an authenticated release selection, never inferred from the bytes being installed. */
  sha256: string;
  download?: AssetDownload;
}

export async function downloadAndInstall(options: ArchiveInstallOptions): Promise<Manifest> {
  requireTarget(options.expected.target);
  const repository = options.repository.split('/');
  if (repository.length !== 2 || repository.some((part) => !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(part))) throw new Error('发行仓库标识不合法');
  Manifest.shape.version.parse(options.expected.version);
  Manifest.shape.commit.parse(options.expected.commit);
  if (!/^[a-f0-9]{64}$/.test(options.sha256)) throw new Error('必须给出可信来源的发行归档摘要');
  const name = assetName(options.expected.version, options.expected.target);
  const base = `https://github.com/${options.repository}/releases/download/v${options.expected.version}`;
  const download = options.download ?? downloadAsset;
  const checksumBytes = await download(`${base}/${name}.sha256`, 1024);
  if (checksumBytes.length > 1024 || new TextDecoder('utf-8', { fatal: true }).decode(checksumBytes) !== `${options.sha256}  ${name}\n`) throw new Error('发行摘要旁证不一致');
  const bytes = await download(`${base}/${name}`, 256 * 1024 * 1024);
  if (sha256(bytes) !== options.sha256) throw new Error('发行归档摘要不一致');
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'circle-hub-download-')));
  try {
    const root = extractArchive(bytes, options.sha256, join(scratch, 'unpacked'), options.expected.target);
    return await installRelease(root, options);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

export async function main(args: string[]): Promise<number> {
  if (args.length !== 6) { process.stderr.write('用法：node scripts/release/install-archive.ts <仓库> <版本> <提交> <归档摘要> <安装目录> <数据目录>\n'); return 1; }
  const [repository, version, commit, digest, prefix, dataRoot] = args as [string, string, string, string, string, string];
  try {
    const manifest = await downloadAndInstall({ repository, sha256: digest, prefix: resolve(prefix), dataRoot: resolve(dataRoot), expected: { version, commit, target: targetFor() } });
    process.stdout.write(`归档校验及应用文件安装完成：${manifest.version}；服务尚需独立验收\n`);
    return 0;
  } catch {
    process.stderr.write('错误：归档下载或安装失败；未确认服务部署成功\n');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
