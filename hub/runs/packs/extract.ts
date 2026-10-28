// Extraction of published packs into read-only directories that pack functions run in (C03 R[0]): <root>/<pack digest>,
// files 0400 and directories 0500, created atomically (a temporary directory renamed into place) and verified against the
// object digests every time it is used. A tree that no longer matches is moved to <root>/.quarantine and built again from
// the verified objects. Concurrent extractions of one digest share one build in a process and race safely across processes.
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, rename } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { PackManifest } from '../../../contracts/src/pack.ts';
import { canonicalBytes, IntegrityError, isSha256, sha256Hex } from '../../records/api.ts';
import { MANIFEST_FILE } from './directory.ts';
import { DIRECTORY_MODE, removeTree, verifyTree, writeReadOnlyTree, type ExpectedFile, type TreeFile } from './tree.ts';

/** Where the files of one pack version come from: its manifest and a reader of verified bytes by SHA-256. */
export interface ExtractionSource {
  manifest: PackManifest;
  read(sha256: string): Promise<Uint8Array | null>;
}

export interface TamperEvent {
  digest: string;
  directory: string;
  /** What did not match, in Chinese. */
  problems: string[];
  /** Where the tree that did not match was moved, or null when it could not be moved (it was removed). */
  quarantine: string | null;
}

export interface Extraction {
  directory: string;
  /** Every file's verified bytes by pack path, pack.json included. */
  bytes: Map<string, Uint8Array>;
}

/** A tree built for the publish check before the version is published. */
export interface StagedTree {
  directory: string;
  /** Moves the tree to its digest's place (keeping one already there) and returns that place. */
  promote(): Promise<string>;
  discard(): Promise<void>;
}

export interface ExtractorOptions {
  root: string;
  /** Called when a tree did not match its digests (admin log). */
  onTamper?: (event: TamperEvent) => void;
}


export function expectedFiles(manifest: PackManifest, digest: string, manifestSize: number): ExpectedFile[] {
  return [...manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, size: f.size })), { path: MANIFEST_FILE, sha256: digest, size: manifestSize }];
}

export class Extractor {
  readonly root: string;
  readonly #onTamper?: (event: TamperEvent) => void;
  readonly #inflight = new Map<string, Promise<Extraction>>();
  #ready: Promise<void> | undefined;

  constructor(options: ExtractorOptions) {
    if (typeof options.root !== 'string' || !isAbsolute(options.root)) throw new TypeError('the extraction directory must be an absolute path');
    this.root = options.root;
    this.#onTamper = options.onTamper;
  }

  directoryOf(digest: string): string {
    if (!isSha256(digest)) throw new TypeError('a pack digest is a lowercase hex SHA-256');
    return join(this.root, digest);
  }

  #prepare(): Promise<void> {
    this.#ready ??= mkdir(this.root, { recursive: true, mode: 0o700 }).then(() => undefined);
    return this.#ready;
  }

  #temporary(digest: string): string {
    return join(this.root, `.tmp-${digest}-${randomBytes(6).toString('hex')}`);
  }

  /** The verified read-only directory of a pack version, built from its source when absent or when it did not match. */
  extract(digest: string, source: () => Promise<ExtractionSource>): Promise<Extraction> {
    const target = this.directoryOf(digest);
    let running = this.#inflight.get(digest);
    if (running === undefined) {
      running = this.#extract(digest, target, source).finally(() => this.#inflight.delete(digest));
      this.#inflight.set(digest, running);
    }
    return running;
  }

  async #extract(digest: string, target: string, load: () => Promise<ExtractionSource>): Promise<Extraction> {
    await this.#prepare();
    const source = await load();
    const manifestBytes = canonicalBytes(source.manifest);
    if (sha256Hex(manifestBytes) !== digest) throw new IntegrityError('包版本记录里的清单与包摘要不符', { detail: { digest } });
    const expected = expectedFiles(source.manifest, digest, manifestBytes.byteLength);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await exists(target)) {
        const check = await verifyTree(target, expected);
        if (check.problems.length === 0) return { directory: target, bytes: check.bytes };
        await this.#quarantine(digest, target, check.problems);
      }
      const files: TreeFile[] = [{ path: MANIFEST_FILE, bytes: manifestBytes }];
      for (const entry of source.manifest.files) {
        const bytes = await source.read(entry.sha256);
        if (bytes === null || sha256Hex(bytes) !== entry.sha256) throw new IntegrityError(`包文件 ${entry.path} 的原件缺失或与摘要不符；请从备份恢复`, { detail: { digest, path: entry.path } });
        files.push({ path: entry.path, bytes });
      }
      const temporary = this.#temporary(digest);
      try {
        await writeReadOnlyTree(temporary, files);
        await moveReadOnlyDirectory(temporary, target);
      } catch (error) {
        await removeTree(temporary);
        // Another process put a tree in place first (rename onto it fails: ENOTEMPTY, EEXIST, or EACCES on macOS for a
        // read-only directory): verify that one on the next round.
        if (!(await exists(target))) throw error;
      }
    }
    const check = await verifyTree(target, expected);
    if (check.problems.length > 0) throw new IntegrityError('解包目录与包摘要不符，重建后仍然不符', { detail: { digest, problems: check.problems } });
    return { directory: target, bytes: check.bytes };
  }

  async #quarantine(digest: string, target: string, problems: string[]): Promise<void> {
    const place = join(this.root, '.quarantine');
    let moved: string | null = join(place, `${digest}-${Date.now()}-${randomBytes(4).toString('hex')}`);
    try {
      await mkdir(place, { recursive: true, mode: 0o700 });
      // Moving a directory to another parent rewrites its `..` entry, which needs write permission on it; a link or a file
      // in the directory's place is moved as it is (chmod would follow a link).
      if ((await lstat(target)).isDirectory()) await chmod(target, 0o700);
      await rename(target, moved);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; // someone else moved it already
      moved = null;
      await removeTree(target);
    }
    try {
      this.#onTamper?.({ digest, directory: target, problems, quarantine: moved });
    } catch {
      // The log must not change what happens.
    }
  }

  /** Builds the tree of a pack that is not published yet under a temporary name (for the publish check). */
  async stage(digest: string, manifestBytes: Uint8Array, files: readonly TreeFile[]): Promise<StagedTree> {
    await this.#prepare();
    if (sha256Hex(manifestBytes) !== digest) throw new TypeError('the manifest bytes do not hash to the pack digest');
    const directory = this.#temporary(digest);
    await writeReadOnlyTree(directory, [{ path: MANIFEST_FILE, bytes: manifestBytes }, ...files]);
    const target = this.directoryOf(digest);
    let done = false;
    return {
      directory,
      promote: async () => {
        if (done) return target;
        done = true;
        try {
          await moveReadOnlyDirectory(directory, target);
        } catch (error) {
          await removeTree(directory);
          if (!(await exists(target))) throw error;
        }
        return target;
      },
      discard: async () => {
        if (done) return;
        done = true;
        await removeTree(directory);
      },
    };
  }
}

/**
 * Renames a read-only (0500) directory within one parent. macOS 15 refuses that rename with EACCES while Linux and macOS 26
 * allow it, so when the plain rename is refused and nothing is in the target's place yet, the directory is made writable
 * for the move and read-only again at its new name. EACCES with a tree already in place is the lost race and is rethrown.
 */
export async function moveReadOnlyDirectory(from: string, to: string, move: (from: string, to: string) => Promise<void> = rename): Promise<void> {
  try {
    await move(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EACCES' || (await exists(to))) throw error;
  }
  await chmod(from, 0o700);
  try {
    await move(from, to);
  } catch (error) {
    await chmod(from, DIRECTORY_MODE).catch(() => {});
    throw error;
  }
  await chmod(to, DIRECTORY_MODE);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
