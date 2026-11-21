import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { DEFAULT_LIMITS } from '../../../hub/config/index.ts';
import type { DatabaseConfig, HubConfig, Limits } from '../../../hub/config/index.ts';
import { FileKeyProvider, openRecords } from '../../../hub/records/index.ts';
import type { Principal, RecordsKit } from '../../../hub/records/api.ts';
import { recordDigest, canonicalize, normalizeTime } from '../../../hub/records/api.ts';
import { runById } from '../../../hub/runs/api.ts';
import { removeTree } from '../../../hub/server/assemble/files.ts';
import { assembleHub, type AssembledHub } from '../../../hub/server/assemble/hub.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { RecordLoader, loadStatic, withLoadSession, type Bundle, type BundleRow, type LoadReport } from './submissions-bundle.ts';
import type { Json } from './submissions-compare.ts';

const REPLAY_POSITIONS_FROM = 4_000_000_000;

export interface ValidationFacts {
  result: string;
  run: string;
  submission: string;
  session: string | null | undefined;
  model: string | null | undefined;
  reevaluation: boolean | undefined;
  at: string;
}

export async function validationFacts(bundle: Bundle): Promise<Map<number, ValidationFacts>> {
  const bySeq = new Map<number, ValidationFacts>();
  const byResult = new Map<string, ValidationFacts>();
  for await (const row of bundle.rows('records')) {
    const kind = String(row.kind);
    if (kind === 'validation_result') {
      const body = JSON.parse(String(row.body)) as { run?: string; submission?: string };
      const facts: ValidationFacts = { result: String(row.digest), run: body.run ?? '', submission: body.submission ?? '', session: undefined, model: undefined, reevaluation: undefined, at: new Date(String(row.created_at)).toISOString() };
      bySeq.set(Number(row.seq), facts);
      byResult.set(facts.result, facts);
    } else if (kind === 'action') {
      const text = String(row.body);
      if (!text.includes('"action":"validate"')) continue;
      const body = JSON.parse(text) as { action?: string; detail?: { result?: unknown; session?: unknown; model?: unknown; reevaluation?: unknown } };
      const detail = body.detail;
      if (body.action !== 'validate' || detail === undefined || typeof detail.result !== 'string') continue;
      const facts = byResult.get(detail.result);
      if (facts === undefined || facts.session !== undefined) continue;
      facts.session = typeof detail.session === 'string' ? detail.session : null;
      facts.model = typeof detail.model === 'string' ? detail.model : null;
      facts.reevaluation = detail.reevaluation === true;
    }
  }
  return bySeq;
}

export interface SessionOptions {
  bundle: Bundle;
  limits?: Partial<Limits>;
  requireOsIsolation?: boolean;
  rebind?: ReadonlyMap<string, { pack: string; pack_digest: string }>;
  prepare?: (hub: AssembledHub, admin: Principal) => Promise<void>;
  log?: (line: string) => void;
  postgres?: TemporaryPostgres;
}

export interface ReplayCall {
  seq: number;
  args: Record<string, unknown>;
  facts: ValidationFacts;
}

export interface ReplayOutcome {
  status: 'replayed' | 'not_replayable';
  reason?: { code: string; message: string };
  result?: Json;
  answer?: { call_result: string; acceptance: string | undefined; errors: Array<{ code: string; message: string }> };
  cached?: boolean;
  notes: string[];
  misses: { records: string[]; objects: string[] };
  load?: { records: number; digestMismatches: number };
  ms: number;
}

const databaseName = (prefix: string): string => `${prefix}_${randomBytes(4).toString('hex')}`;

function connection(config: DatabaseConfig): pg.ClientConfig {
  const password = config.password;
  return { host: config.host, port: config.port, user: config.user, database: config.database, ssl: false, password: async () => { if (password === undefined) throw new Error('no password'); return password; } };
}

export class ReplaySession {
  readonly #options: SessionOptions;
  readonly #postgres: TemporaryPostgres;
  readonly #ownsPostgres: boolean;
  readonly #dataDir: string;
  readonly #keys: FileKeyProvider;
  readonly #base: DatabaseConfig;
  readonly #limits: Limits;
  #loaded = 0;
  readonly #loader: RecordLoader;
  #closed = false;
  #damaged: Array<{ seq: number; kind: string; digest: string }> = [];
  readonly log: (line: string) => void;

  private constructor(options: SessionOptions, postgres: TemporaryPostgres, owns: boolean, dataDir: string, keys: FileKeyProvider, base: DatabaseConfig) {
    this.#options = options;
    this.#postgres = postgres;
    this.#ownsPostgres = owns;
    this.#dataDir = dataDir;
    this.#keys = keys;
    this.#base = base;
    this.#limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.#loader = new RecordLoader(options.bundle);
    this.log = options.log ?? (() => {});
  }

  static async open(options: SessionOptions): Promise<ReplaySession> {
    const owns = options.postgres === undefined;
    const postgres = options.postgres ?? (await startPostgres({ private: true, sharedBuffers: '256MB', autovacuum: false }));
    const dataDir = await mkdtemp(join(tmpdir(), 'circle-hub-replay-'));
    try {
      const keys = new FileKeyProvider(join(dataDir, 'replay-vault.key'));
      await keys.initKey();
      const base = await postgres.createDatabase(databaseName('replay_base'));
      const session = new ReplaySession(options, postgres, owns, dataDir, keys, base);
      const kit = await session.#openKit(base);
      await kit.close();
      await withLoadSession(base, async (db) => {
        await db.query(`ALTER TABLE public.records ALTER COLUMN seq RESTART WITH ${REPLAY_POSITIONS_FROM}`);
        const loaded = await loadStatic(db, options.bundle, join(dataDir, 'objects'));
        session.log(`静态表和对象已载入：对象 ${loaded.objects} 个${loaded.missingBytes.length > 0 ? `，${loaded.missingBytes.length} 个没有字节` : ''}`);
      });
      if (options.prepare !== undefined) await session.#prepare(options.prepare);
      return session;
    } catch (error) {
      if (owns) await postgres.stop().catch(() => {});
      await removeTree(dataDir);
      throw error;
    }
  }

  #config(database: DatabaseConfig): HubConfig {
    return { dataDir: this.#dataDir, logDir: join(this.#dataDir, 'logs'), host: '127.0.0.1', port: 0, database, limits: { ...this.#limits } };
  }

  async #openKit(database: DatabaseConfig, now?: () => Date): Promise<RecordsKit> {
    return openRecords({ dataDir: this.#dataDir, logDir: join(this.#dataDir, 'logs'), database, limits: { ...this.#limits } }, { keyProvider: this.#keys, ...(now === undefined ? {} : { now }) });
  }

  async #prepare(prepare: NonNullable<SessionOptions['prepare']>): Promise<void> {
    const kit = await this.#openKit(this.#base);
    try {
      const hub = await assembleHub(this.#config(this.#base), kit, { requireVaultKey: false, requireOsIsolation: this.#options.requireOsIsolation ?? true, extractDir: join(this.#dataDir, 'packs'), resourceCacheMs: 0, log: this.log });
      try {
        const admin = (await kit.principals.list()).find((p) => p.role === 'admin' && !p.disabled);
        if (admin === undefined) throw new Error('数据包里没有可用的管理员账户，不能发布候选的任务包');
        await prepare(hub, { id: admin.id, name: admin.name, role: admin.role });
      } finally {
        await hub.deps.close?.();
      }
    } finally {
      await kit.close();
    }
  }

  async #advance(seq: number): Promise<LoadReport | null> {
    if (seq < this.#loaded) throw new Error('回放要按位置从小到大进行');
    if (seq === this.#loaded) return null;
    const rebind = this.#options.rebind;
    const report = await withLoadSession(this.#base, (db) => this.#loader.load(db, seq, rebind === undefined ? undefined : (row: BundleRow) => rebound(row, rebind)));
    this.#loaded = seq;
    return report;
  }

  async replay(call: ReplayCall): Promise<ReplayOutcome> {
    const started = Date.now();
    const notes: string[] = [];
    const misses = { records: new Set<string>(), objects: new Set<string>() };
    const done = (outcome: Omit<ReplayOutcome, 'notes' | 'misses' | 'ms'>): ReplayOutcome => ({ ...outcome, notes, misses: { records: [...misses.records].sort(), objects: [...misses.objects].sort() }, ms: Date.now() - started });
    if (this.#closed) throw new Error('回放会话已经关闭');
    if (call.facts.session === undefined) return done({ status: 'not_replayable', reason: { code: 'no_call_facts', message: `数据包里没有存下这条核对结果的 validate 动作，不知道当时调用的会话和模型（核对结果 ${call.facts.result}）` } });
    const report = await this.#advance(call.seq);
    if (report !== null) this.#damaged.push(...report.digestMismatches);
    if (this.#damaged.length > 0) {
      return done({ status: 'not_replayable', reason: { code: 'bundle_damaged', message: `数据包里有 ${this.#damaged.length} 条记录的摘要与内容对不上，例如位置 ${this.#damaged[0].seq}（${this.#damaged[0].kind}）` } });
    }
    const name = databaseName('replay_work');
    const admin = new pg.Client(connection(this.#postgres.config));
    admin.on('error', () => {});
    await admin.connect();
    let work: DatabaseConfig | null = null;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE "${this.#base.database}"`);
      work = { ...this.#base, database: name };
      let clock = Date.parse(call.facts.at);
      const now = (): Date => new Date(clock++);
      const kit = await this.#openKit(work, now);
      const traceId = randomBytes(16).toString('hex');
      try {
        const store = kit.store as { get: (digest: string, tx?: unknown) => Promise<unknown> };
        const originalGet = store.get.bind(store);
        store.get = async (digest, tx) => {
          const found = await originalGet(digest, tx);
          if (found === null) misses.records.add(digest);
          return found;
        };
        const objects = kit.objects as { get: (sha: string, tx?: unknown) => Promise<Uint8Array | null> };
        const originalObject = objects.get.bind(objects);
        objects.get = async (sha, tx) => {
          const found = await originalObject(sha, tx);
          if (found === null) misses.objects.add(sha);
          return found;
        };
        const hub = await assembleHub(this.#config(work), kit, {
          requireVaultKey: false,
          requireOsIsolation: this.#options.requireOsIsolation ?? true,
          extractDir: join(this.#dataDir, 'packs'),
          resourceCacheMs: 0,
          now,
          log: (line) => notes.push(line),
        });
        try {
          const principal = await runnerOf(kit, call.facts.run);
          if (principal === null) {
            return done({ status: 'not_replayable', reason: { code: 'no_principal', message: `运行 ${call.facts.run} 的运行者或管理员账户不在数据包里` } });
          }
          const answer = await hub.runs.submitResult(principal, call.args, { traceId, sessionId: call.facts.session, adminNote: (note: string) => notes.push(`管理员说明：${note}`) });
          const result = (answer as { result?: Json }).result;
          const shaped = { call_result: String((answer as { call_result?: unknown }).call_result), acceptance: (answer as { acceptance?: string }).acceptance, errors: ((answer as { errors?: Array<{ code: string; message: string }> }).errors ?? []).map((e) => ({ code: e.code, message: e.message })) };
          if (result === undefined) return done({ status: 'replayed', answer: shaped });
          const cached = (result as { trace?: unknown }).trace !== traceId;
          return done({ status: 'replayed', result, answer: shaped, ...(cached ? { cached: true } : {}), ...(report === null ? {} : { load: { records: report.records, digestMismatches: report.digestMismatches.length } }) });
        } finally {
          await hub.deps.close?.().catch(() => {});
        }
      } finally {
        await kit.close().catch(() => {});
      }
    } catch (error) {
      return done({ status: 'not_replayable', reason: { code: 'replay_error', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) } });
    } finally {
      if (work !== null) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await admin.end().catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      if (this.#ownsPostgres) await this.#postgres.stop();
      else await this.#postgres.dropDatabase(this.#base.database).catch(() => {});
    } finally {
      await removeTree(this.#dataDir);
    }
  }
}

async function runnerOf(kit: RecordsKit, run: string): Promise<Principal | null> {
  const body = (await runById(kit.store, run))?.body;
  const id = body?.runner ?? body?.configurer;
  if (id === undefined) return null;
  const user = await kit.principals.get(id);
  return user === null ? null : { id: user.id, name: user.name, role: user.role };
}

function rebound(row: BundleRow, bindings: ReadonlyMap<string, { pack: string; pack_digest: string }>): BundleRow | null {
  if (row.kind !== 'run') return null;
  const body = JSON.parse(String(row.body)) as { run?: string; pack?: string; pack_digest?: string };
  const binding = body.run === undefined ? undefined : bindings.get(body.run);
  if (binding === undefined) return null;
  const next = { ...body, pack: binding.pack, pack_digest: binding.pack_digest };
  const text = canonicalize(next);
  const created = normalizeTime(new Date(String(row.created_at)).toISOString(), 'created_at');
  return { ...row, body: text, size: Buffer.byteLength(text, 'utf8'), digest: recordDigest({ kind: 'run', schema: String(row.schema), provenance: String(row.provenance), created_at: created, body: next }) };
}
