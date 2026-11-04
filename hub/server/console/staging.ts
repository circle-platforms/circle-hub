// Task packs staged by the console's 发布任务包 (item 5 of the console interface doc, confirmed by the owner on 2026-11-01):
// an uploaded zip is unpacked into a private temporary directory and checked with `pack publish <dir> --stage --dry-run`;
// a directory that passed waits here until the administrator who staged it publishes it with `pack publish <dir> --stage`,
// at most STAGE_TTL_MS. A stage ends when it is published or discarded, when it expires and when the app closes, and its
// directory is removed then. Pages name a stage only by its random id and never show the directory; a stage is visible to
// the administrator who staged it alone, so an id of someone else's stage reads like an unknown or expired one.
import { randomBytes } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isPackKind, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import { MANIFEST_FILE, manifestDigest } from '../../runs/api.ts';
import { background } from '../../telemetry/api.ts';

export const STAGE_TTL_MS = 30 * 60 * 1000;
/** Stages kept at once over all administrators; a new one beyond it ends the oldest. */
export const MAX_STAGES = 10;

export interface StagedPack {
  /** Random id the pages carry. */
  id: string;
  /** User id of the administrator who staged it, the only one who may publish it. */
  by: string;
  space?:string;
  /** The pack's id and version as its pack.json names them. */
  pack: string;
  version: string;
  /** Presentation metadata only; the command remains responsible for all manifest validation. */
  kind?: PackKind;
  /** The pack digest that passed the check: a publication of the stage must still have it. */
  digest: string;
  created: number;
  expires: number;
}

interface Entry {
  stage: StagedPack;
  /** The private temporary directory to remove, and the directory inside it that holds pack.json. */
  root: string;
  dir: string;
  timer: NodeJS.Timeout;
}

/** The pack digest of the pack.json in `dir` (SHA-256 of its canonical JSON); null when it cannot be read. */
export async function stagedDigest(dir: string): Promise<{ digest: string; pack: string; version: string; kind?: PackKind } | null> {
  try {
    const manifest = JSON.parse(await readFile(join(dir, MANIFEST_FILE), 'utf8')) as { id?: unknown; version?: unknown; kind?: unknown };
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') return null;
    return { digest: manifestDigest(manifest), pack: manifest.id, version: manifest.version, ...(isPackKind(manifest.kind)?{kind:manifest.kind}:{}) };
  } catch {
    return null;
  }
}

export class PackStaging {
  readonly #entries = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #max: number;
  #closed = false;

  constructor(now: () => number = Date.now, options: { ttlMs?: number; max?: number } = {}) {
    this.#now = now;
    this.#ttlMs = options.ttlMs ?? STAGE_TTL_MS;
    this.#max = options.max ?? MAX_STAGES;
  }

  /**
   * Keeps a checked directory for the administrator `by`. Null, with the directory removed, when its pack.json cannot be
   * read or the store is closed.
   */
  async add(by: string, unpacked: { root: string; dir: string },space?:string): Promise<StagedPack | null> {
    const read = this.#closed ? null : await stagedDigest(unpacked.dir);
    if (read === null || this.#closed) {
      await rm(unpacked.root, { recursive: true, force: true });
      return null;
    }
    while (this.#entries.size >= this.#max) await this.remove(this.#entries.keys().next().value!);
    const created = this.#now();
    const stage: StagedPack = { ...(space?{space}:{}),id: randomBytes(18).toString('base64url'), by, ...read, created, expires: created + this.#ttlMs };
    const timer = setTimeout(() => void background('clean-staging', () => this.remove(stage.id)), this.#ttlMs);
    timer.unref();
    this.#entries.set(stage.id, { stage, root: unpacked.root, dir: unpacked.dir, timer });
    return stage;
  }

  /** The stage and its directory when it exists, has not expired and was staged by `by`; null otherwise. */
  async open(id: string, by: string): Promise<{ stage: StagedPack; dir: string } | null> {
    const entry = typeof id === 'string' ? this.#entries.get(id) : undefined;
    if (entry === undefined || entry.stage.by !== by) return null;
    if (this.#now() >= entry.stage.expires) {
      await this.remove(id);
      return null;
    }
    return { stage: entry.stage, dir: entry.dir };
  }

  /**
   * Ends the stage for its 发布 or 放弃 step and hands over its directory: a second request with the same id finds nothing.
   * The caller removes the directory with `done` when the step is over.
   */
  async take(id: string, by: string): Promise<{ stage: StagedPack; dir: string; done: () => Promise<void> } | null> {
    const opened = await this.open(id, by);
    const entry = opened === null ? undefined : this.#entries.get(id);
    if (entry === undefined) return null;
    this.#entries.delete(id);
    clearTimeout(entry.timer);
    return { stage: entry.stage, dir: entry.dir, done: () => rm(entry.root, { recursive: true, force: true }) };
  }

  /** The stages of `by` that have not expired, oldest first. */
  list(by: string): StagedPack[] {
    const now = this.#now();
    return [...this.#entries.values()].map((entry) => entry.stage).filter((stage) => stage.by === by && now < stage.expires);
  }

  /** Ends a stage and removes its directory; an unknown id is no error. */
  async remove(id: string): Promise<void> {
    const entry = this.#entries.get(id);
    if (entry === undefined) return;
    this.#entries.delete(id);
    clearTimeout(entry.timer);
    await rm(entry.root, { recursive: true, force: true });
  }

  /** Ends every stage (the app closes); a directory added later is removed at once. */
  async clear(): Promise<void> {
    this.#closed = true;
    await Promise.all([...this.#entries.keys()].map((id) => this.remove(id)));
  }
}
