import { constants } from 'node:fs';
import { lstat, mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './generated/skills/run-tools/hub-client/index.ts';

const ownedByUser = (uid: number) => uid === process.getuid!();
const regularDirectory = async (path: string): Promise<boolean> => {
  const info = await lstat(path).catch(() => null);
  return !!info && info.isDirectory() && !info.isSymbolicLink() && ownedByUser(info.uid) && (info.mode & 0o077) === 0;
};
async function createDirectory(path: string): Promise<boolean> {
  try { await mkdir(path, { mode: 0o700 }); } catch { }
  return regularDirectory(path);
}
async function readRegular(path: string, limit: number): Promise<Buffer | null> {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || !ownedByUser(info.uid) || (info.mode & 0o077) !== 0 || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) return null;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > limit || actual.nlink !== 1 || actual.dev !== info.dev || actual.ino !== info.ino) return null;
    const output = Buffer.alloc(Math.min(actual.size, limit) + 1);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return offset <= limit ? output.subarray(0, offset) : null;
  } finally { await handle.close(); }
}

export interface LocalSourceCache {
  digest: string;
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
}
export function localSourceCache(url: string, bearer: string, limit: number, directory?: string | false): LocalSourceCache | null {
  if (!directory) return null;
  const parsed = new URL(url);
  const match = /^\/run-export\/run_[a-z0-9]{26}\/sources\/([a-f0-9]{64})$/.exec(parsed.pathname);
  if (!match || parsed.search || parsed.hash) return null;
  const digest = match[1];
  const root = resolve(directory), version = join(root, 'sources-v1');
  const scope = join(version, sha256(Buffer.from(parsed.origin + '\0' + bearer)));
  const file = join(scope, `${digest}.bytes`), receipt = join(scope, `${digest}.json`);
  const parents = async () => await regularDirectory(root) && await regularDirectory(version) && await regularDirectory(scope);
  const owned = async () => {
    const bytes = await readRegular(receipt, 256);
    if (!bytes) return false;
    try { const value = JSON.parse(bytes.toString('utf8')); return value.schema === 'case-source-cache@1' && value.sha256 === digest; } catch { return false; }
  };
  return {
    digest,
    async load() {
      try {
        if (!await parents()) return null;
        const bytes = await readRegular(file, limit);
        return bytes && sha256(bytes) === digest ? bytes : null;
      } catch { return null; }
    },
    async save(bytes) {
      if (bytes.byteLength > limit || sha256(bytes) !== digest) return;
      try {
        if (!await createDirectory(root) || !await createDirectory(version) || !await createDirectory(scope)) return;
        const info = await lstat(file).catch(() => null);
        if (info) {
          if (!info.isFile() || !ownedByUser(info.uid) || (info.mode & 0o077) !== 0 || info.isSymbolicLink() || info.nlink !== 1) return;
          const existing = await readRegular(file, limit);
          if (existing && sha256(existing) === digest) return;
          if (!await owned()) return;
          const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW);
          try {
            const actual = await handle.stat();
            if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== info.dev || actual.ino !== info.ino) return;
            await handle.truncate(0);
            await handle.writeFile(bytes);
          } finally { await handle.close(); }
        } else {
          await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
          await writeFile(receipt, JSON.stringify({ schema: 'case-source-cache@1', sha256: digest }) + '\n', { flag: 'wx', mode: 0o600 });
        }
      } catch { }
    },
  };
}
