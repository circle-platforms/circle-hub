// Source material names are presentation; references and SHA-256 remain their identities.
import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { sha256 } from './generated/skills/run-tools/hub-client/index.ts';
import { isRecord, failCall } from './text.ts';

export interface SourceMaterial {
  slot: string | null;
  role: string | null;
  reference: string;
  label: string | null;
  media_type: string | null;
  file: string | null;
  sha256: string | null;
  withheld?: string;
}
const SOURCE_REFERENCE = /^src:([a-f0-9]{64})(?:\/|$)/;

/** A stable per-slot name; dots cannot occur in slot names, so numeric suffixes cannot collide with another slot. */
export function sourceFileName(slot: string, mediaType: unknown, ordinal = 0): string {
  if (!/^[a-z][a-z0-9_-]*$/.test(slot) || !Number.isSafeInteger(ordinal) || ordinal < 0) failCall('invalid_parameters', '来源槽名或序号不能作为安全文件名', '核对冻结工作流的来源槽声明，使用合法槽名和非负整数序号后重试');
  const extension = mediaType === 'application/json' ? '.json' : mediaType === 'text/plain' ? '.txt' : mediaType === 'text/markdown' ? '.md' : mediaType === 'application/xml' || mediaType === 'text/xml' ? '.xml' : '';
  return `${slot}${ordinal ? '.' + (ordinal + 1) : ''}${extension}`;
}

export function sourceMaterialNames(bindings: readonly Record<string, unknown>[]): Array<string | null> {
  const counts = new Map<string, number>();
  const objects = new Map<string, string>();
  return bindings.map(binding => {
    const digest = typeof binding.reference === 'string' ? SOURCE_REFERENCE.exec(binding.reference)?.[1] : null;
    if (!digest) return null;
    const existing = objects.get(digest);
    if (existing) return existing;
    const slot = typeof binding.slot === 'string' ? binding.slot : 'source';
    const ordinal = counts.get(slot) ?? 0;
    counts.set(slot, ordinal + 1);
    const name = join('sources', sourceFileName(slot, binding.media_type, ordinal));
    objects.set(digest, name);
    return name;
  });
}

/** Reads only ordinary files below the named directory; the manifest cannot grant filesystem access outside it. */
async function materialBytes(directory: string, file: string): Promise<Buffer> {
  if (isAbsolute(file) || file.includes('\\') || file.split('/').some(part => !part || part === '.' || part === '..')) failCall('invalid_parameters', '来源清单中的文件路径越界或不合法', '重新下载原始资料，使用清单中的工作目录内相对文件指针');
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink()) failCall('invalid_parameters', '来源目录不是普通目录', '使用工作目录内的真实来源目录后重试');
  let path = directory;
  for (const part of file.split('/')) {
    path = join(path, part);
    const info = await lstat(path);
    if (info.isSymbolicLink()) failCall('invalid_parameters', '来源清单不能指向符号链接', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) failCall('invalid_parameters', '来源清单指向的不是普通文件', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
    return await handle.readFile();
  } finally { await handle.close(); }
}

/** Both new names and historical SHA filenames are consumed through the recorded pointer, never guessed from labels. */
export async function readSourceManifest(directory: string): Promise<SourceMaterial[]> {
  const bytes = await materialBytes(directory, 'sources.json');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { failCall('invalid_parameters', '来源清单不是完整的 UTF-8 JSON', '重新下载并核验 sources.json，不从损坏文本推断文件名'); }
  if (!Array.isArray(value)) failCall('invalid_parameters', '来源清单格式不完整', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
  const materials: SourceMaterial[] = [];
  for (const row of value) {
    if (!isRecord(row) || typeof row.reference !== 'string' || row.slot !== null && typeof row.slot !== 'string' || row.file !== null && typeof row.file !== 'string') failCall('invalid_parameters', '来源清单的身份或文件指针不完整', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
    const digest = SOURCE_REFERENCE.exec(row.reference)?.[1] ?? null;
    if (typeof row.file === 'string' && (digest === null || sha256(await materialBytes(directory, row.file)) !== digest)) failCall('invalid_parameters', '来源文件与清单摘要不一致', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
    materials.push({ slot: row.slot, role: typeof row.role === 'string' ? row.role : null, reference: row.reference, label: typeof row.label === 'string' ? row.label : null, media_type: typeof row.media_type === 'string' ? row.media_type : null, file: row.file, sha256: digest, ...(typeof row.withheld === 'string' ? { withheld: row.withheld } : {}) });
  }
  return materials;
}

/** Old fetch-run directories have no manifest and use root-level JSON files; a present but invalid manifest is never bypassed. */
export async function readSourceBytes(directory: string, slot: string): Promise<Uint8Array> {
  const info = await lstat(join(directory, 'sources.json')).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info === null) return materialBytes(directory, sourceFileName(slot, 'application/json'));
  const materials = await readSourceManifest(directory);
  const own = materials.filter(row => row.slot === slot);
  if (own.length !== 1 || own[0].file === null) failCall('invalid_parameters', '没有唯一可读的来源槽', '按本次来源清单补齐可读原件并重新下载核验，不猜测或替换文件名');
  const bytes = await materialBytes(directory, own[0].file);
  if (sha256(bytes) !== own[0].sha256) failCall('invalid_parameters', '来源文件在读取期间与声明摘要不符', '重新下载并核验原件后重试');
  return bytes;
}

/** Validate a new download target without creating or clearing anything. */
export async function assertEmptySourceOutput(directory: string): Promise<void> {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!info) return;
  if (!info.isDirectory() || info.isSymbolicLink()) failCall('occupied', '输出位置不是空的普通目录', '另选新的空目录下载，不覆盖已有资料', { path: directory, legal_form: '--out <新的空目录>' });
  const names = await readdir(directory);
  if (names.length > 0) failCall('occupied', `输出位置不是空的普通目录：目录内已有 ${names.slice(0, 20).join('、')}${names.length > 20 ? ` 等 ${names.length} 项` : ''}，不覆盖`, '另选新的空目录下载，不覆盖已有资料', { path: directory, legal_form: '--out <新的空目录>' });
}
