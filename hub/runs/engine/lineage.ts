import {ModelIdentitySchema} from '../../../contracts/generated/shared-interfaces.ts';
import {authorAccount,type AccountAuthors} from './independence.ts';
// The author of the work a run judges (A04; case-review method step 5: the drafter can never sign the conclusion). A run that is
// independent of its predecessor judges the work of its lineage, not its own earlier revisions. When the predecessor chain
// reaches another pack, that draft and its revisions are the author and this pack's earlier revisions are not. When the chain
// never leaves this pack, those runs are the author (A04: the predecessor run counts). Every run a Hub record bound as
// artifact under verification belongs to is taken with its revisions too. The author origin is the start session of each of
// those runs, the session and declared model of every submission they validated, and the model warrants inside the bound
// records (carried judgments keep their original producer there).
import type { RunRecord } from '../../../contracts/src/run.ts';
import type { RecordStore } from '../../records/api.ts';
import { parseReference, type Reference } from '../../refs/api.ts';
import type { EngineContext } from './deps.ts';
import type { AuthorOrigin } from './independence.ts';
import { runOfRecord } from './readers.ts';
import { actionsOf, runById, submissionByDigest } from './store.ts';
import { isObject } from './util.ts';

/** Longest predecessor chain the engine follows; a longer chain is cut, a cycle ends the walk. */
export const MAX_LINEAGE = 100;

/** Most nodes of a bound record walked for model warrants (a validation result holds a few per item and requirement). */
const MAX_WALK = 2_000_000;

export const packIdOf = (pack: string): string => pack.slice(0, pack.indexOf('@'));

/** The run and its predecessors, newest first, at most MAX_LINEAGE runs. */
export async function lineageOf(store: RecordStore, run: string): Promise<RunRecord[]> {
  const out: RunRecord[] = [];
  const seen = new Set<string>();
  let next: string | undefined = run;
  while (next !== undefined && !seen.has(next) && out.length < MAX_LINEAGE) {
    seen.add(next);
    const found = await runById(store, next);
    if (found === null) break;
    out.push(found.body);
    next = found.body.predecessor;
  }
  return out;
}

/** A run of a chain with its own earlier revisions: the runs of the same pack id right behind it. */
function withRevisions(chain: readonly RunRecord[], from: number): RunRecord[] {
  const out = [chain[from]];
  const pack = packIdOf(chain[from].pack);
  for (let i = from + 1; i < chain.length && packIdOf(chain[i].pack) === pack; i++) out.push(chain[i]);
  return out;
}

/**
 * Who an independent judgment is held against (A04). A predecessor of another pack is the draft, with its revisions.
 * A chain that never leaves this pack is still a predecessor, so those runs are the author. A revised verification
 * that does lead to another pack keeps judging that draft, not its own earlier revision.
 */
export async function judgedRunsOf(store: RecordStore, run: Pick<RunRecord, 'pack' | 'predecessor'>): Promise<RunRecord[]> {
  if (run.predecessor === undefined) return [];
  const chain = await lineageOf(store, run.predecessor);
  if (chain.length === 0) return [];
  const own = packIdOf(run.pack);
  const first = chain.findIndex((r) => packIdOf(r.pack) !== own);
  return withRevisions(chain, first < 0 ? 0 : first);
}

/** Declared models of the model-produced claims inside a record body (warrant producer model). */
function modelWarrants(body: unknown, into: Set<string>): void {
  const stack: unknown[] = [body];
  let walked = 0;
  while (stack.length > 0 && walked++ < MAX_WALK) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      for (const child of node) if (child !== null && typeof child === 'object') stack.push(child);
      continue;
    }
    if (!isObject(node)) continue;
    const warrant = node.warrant;
    if (isObject(warrant) && warrant.producer === 'model' && typeof warrant.id === 'string') into.add(warrant.id);
    for (const child of Object.values(node)) if (child !== null && typeof child === 'object') stack.push(child);
  }
}

/**
 * Who produced the work a run judges (null when nothing is known: no predecessor, A04 R[5]). Conflicts are collected from
 * every submission of the author runs; completeness asks that the producers of their accepted results are all known.
 */
export async function authorOriginOf(ctx: EngineContext, run: RunRecord): Promise<(AuthorOrigin & { missingSessions: string[] }) | null> {
  if (run.predecessor === undefined) return null;
  const store = ctx.deps.records.store;
  const runs = new Map<string, RunRecord>();
  for (const r of await judgedRunsOf(store, run)) runs.set(r.run, r);
  const sessions = new Set<string>();
  const models = new Set<string>();
  const families = new Set<string>(),identifiedModels=new Set<string>();
  let declarationsComplete=true;
  const producer=(value:unknown):boolean=>{
    if(!isObject(value))return false;
    const identity=ModelIdentitySchema.safeParse(value.model_identity);
    if(identity.success){models.add(identity.data.model_id);identifiedModels.add(identity.data.model_id);families.add(identity.data.model_family_id);return true;}
    declarationsComplete=false;
    if(typeof value.model==='string')models.add(value.model);
    return false;
  };
  let complete = true;
  const missingSessions: string[] = [];
  for (const source of run.sources) {
    if (source.role !== 'artifact_under_verification') continue;
    let ref: Reference | null;
    try {
      ref = parseReference(source.reference);
    } catch {
      ref = null;
    }
    // An upload or an external object under verification has no producer the Hub knows.
    if (ref === null || ref.scheme !== 'rec') {
      complete = false;
      continue;
    }
    const record = await store.get(ref.record);
    if (record === null) {
      complete = false;
      continue;
    }
    if (record.kind === 'submission') producer(record.body);
    modelWarrants(record.body, models);
    const owner = runOfRecord(record);
    const chain = owner === null ? [] : await lineageOf(store, owner);
    if (chain.length === 0) {
      complete = false;
      continue;
    }
    for (const r of withRevisions(chain, 0)) runs.set(r.run, r);
  }
  if (runs.size === 0 && models.size === 0) return null;
  if (runs.size === 0) complete = false;
  for (const r of runs.values()) {
    if (r.session === undefined) { complete = false; missingSessions.push(`运行 ${r.run}（原运行者 ${r.runner??r.configurer??'记录未给出'}）`); }
    else sessions.add(r.session);
    for (const action of await actionsOf(store, r.run)) {
      const body = action.body;
      if (body.action !== 'validate' || !isObject(body.detail) || body.detail.production === true) continue;
      const accepted = body.acceptance === 'accepted';
      if (typeof body.detail.session === 'string') sessions.add(body.detail.session);
      else if (accepted) { complete = false; missingSessions.push(`已受理提交 ${String(body.detail.submission)}（运行 ${r.run}，原运行者 ${r.runner??r.configurer??'记录未给出'}）`); }
      const original=typeof body.detail.submission==='string'?await submissionByDigest(store,r.run,body.detail.submission):null;
      if(original!==null)producer(original.body);
      else if(typeof body.detail.model==='string'){models.add(body.detail.model);declarationsComplete=false;}
      else if(accepted)complete=false;
    }
  }
  if (models.size === 0) complete = false;
  return { sessions, models, families, familiesComplete:declarationsComplete&&models.size>0&&[...models].every(model=>identifiedModels.has(model)), complete, missingSessions };
}

/** A Hub record bound as artifact under verification whose run lies outside the predecessor's lineage. */
export interface ForeignArtifact {
  record: string;
  run: string;
}

/**
 * The bound records under verification whose run is not in the predecessor's lineage (the predecessor and its ancestors): the
 * predecessor then says nothing about who wrote what is verified, so a run that must be independent of it is refused.
 */
export async function foreignArtifacts(store: RecordStore, predecessor: string, records: readonly { record: string; run: string | null }[]): Promise<ForeignArtifact[]> {
  if (records.length === 0) return [];
  const lineage = new Set((await lineageOf(store, predecessor)).map((r) => r.run));
  return records.flatMap((r) => (r.run !== null && !lineage.has(r.run) ? [{ record: r.record, run: r.run }] : []));
}

/** Authenticated authors of the declaration run and its entire predecessor lineage. */
export async function authorAccountsOf(ctx:EngineContext,run:string|undefined):Promise<AccountAuthors|null>{
 if(!run)return null;
 const chain=await lineageOf(ctx.deps.records.store,run),accounts=new Set<string>();
 let complete=chain.length>0;
 for(const record of chain){const account=authorAccount(record);if(account)accounts.add(account);else complete=false;}
 if(chain.at(-1)?.predecessor)complete=false;
 return {accounts,complete};
}
