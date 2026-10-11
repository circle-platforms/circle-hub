import { mkdir, readFile, writeFile, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Sha256, requireCondition, sha256 } from '../../contracts/src/index.ts';

export interface ObjectStore {
  putObject(input: { Bucket: 'evidence'; Key: string; Body: Buffer }): Promise<void>;
  getObject(input: { Bucket: 'evidence'; Key: string }): Promise<Buffer>;
}
export class LocalObjects implements ObjectStore {
  directory: string;
  constructor(directory: string) { this.directory = directory; }
  path(key: string): string { Sha256.parse(key); return join(this.directory, key.slice(0,2), key); }
  async putObject({ Key, Body }: { Bucket: 'evidence'; Key: string; Body: Buffer }): Promise<void> {
    requireCondition(sha256(Body) === Key, 'SOURCE_HASH_MISMATCH', 'Object bytes do not match their key');
    const path = this.path(Key); await mkdir(join(this.directory, Key.slice(0,2)), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, Body, { flag: 'wx', mode: 0o600 });
    try {
      try { await link(temp, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        requireCondition(sha256(await readFile(path)) === Key, 'SOURCE_HASH_MISMATCH', 'Existing object is corrupt'); }
    } finally { await unlink(temp); }
  }
  async getObject({ Key }: { Bucket: 'evidence'; Key: string }): Promise<Buffer> {
    const bytes = await readFile(this.path(Key));
    requireCondition(sha256(bytes) === Key, 'SOURCE_HASH_MISMATCH', 'Stored original bytes failed their SHA-256 check'); return bytes;
  }
}
