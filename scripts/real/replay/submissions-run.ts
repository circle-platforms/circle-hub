// A replay of recorded validations: which of them are replayed, with what, and what came of each. The recorded side is an
// export folder (submissions-recorded.ts), the state of the Hub is a data bundle (submissions-bundle.ts), the code under test
// is the tree this script runs in (its hub/ and packs/), and the comparison is submissions-compare.ts.
//
//   faithful   each validation is replayed with the pack version it was made with, as recorded in its run, and the Hub code of
//              the commit that stored it (the tree this runs in is that commit: --windows names which validations belong to it).
//              Every validation is expected to come out the same: that is what shows the replay itself is faithful.
//   candidate  every validation is replayed with the Hub code and the packs of the tree this runs in: the run is bound to the
//              tree's pack of the same id, and each validation is classified same or changed.
import { readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AssembledHub } from '../../../hub/server/assemble/hub.ts';
import type { Principal } from '../../../hub/records/api.ts';
import { openBundle, type Bundle } from './submissions-bundle.ts';
import { compareResults, type Comparison, type Json } from './submissions-compare.ts';
import { ReplaySession, validationFacts, type ReplayOutcome } from './submissions-hub.ts';
import { findPackDirectories, matchPacks, packIdentity, stagePack, type PackDirectory, type PackMatch, type RecordedPack } from './submissions-packs.ts';
import type { RecordedExport, ValidationTask } from './submissions-recorded.ts';

export type Mode = 'faithful' | 'candidate';

/** The Hub release that was running during a stretch of time (UTC). */
export interface Window {
  commit: string;
  from: string;
  /** Exclusive; null for the release that is still running. */
  to: string | null;
}

export function windowOf(windows: readonly Window[], at: string): Window | null {
  const time = Date.parse(at);
  return windows.find((w) => Date.parse(w.from) <= time && (w.to === null || time < Date.parse(w.to))) ?? null;
}

export type Status = 'same' | 'changed' | 'not_replayable';

export interface ValidationOutcome {
  seq: number;
  run: string;
  pack: string;
  at: string;
  ordinal: number;
  file: string;
  /** The Hub release (commit) that stored the recorded result, from the windows; null when none were given. */
  release: string | null;
  status: Status;
  reason?: { code: string; message: string };
  comparison?: Comparison;
  /** Candidate mode: the run was bound to another pack version than the one it was started with. */
  rebound?: { from: string; to: string };
  cached?: boolean;
  /** The replay's answer when it carried no validation result. */
  answer?: ReplayOutcome['answer'];
  notes: string[];
  misses: ReplayOutcome['misses'];
  ms: number;
}

export interface RunConfig {
  mode: Mode;
  /**
   * Candidate only. `commit` (the default): every run is bound to the commit's pack of the same id, so a changed pack is what is
   * tried. `recorded`: the runs keep the packs they were started with and only the Hub code is the commit's.
   */
  packs?: 'commit' | 'recorded';
  recorded: RecordedExport;
  /** Without a bundle nothing can be replayed: every validation is reported as such. */
  bundle: Bundle | null;
  /** The code tree under test (its hub/ is what runs; its packs/ are what a candidate is bound to). */
  repo: string;
  /** Its commit, for the report. */
  commit: string;
  /** Faithful: the releases, and with `commit` which validations belong to this tree. Others are left to the tree of their release. */
  windows?: readonly Window[];
  only?: { runs?: readonly string[]; seqs?: readonly number[]; limit?: number };
  limits?: Parameters<typeof ReplaySession.open>[0]['limits'];
  requireOsIsolation?: boolean;
  /** A scratch PostgreSQL cluster that is already running (tests); otherwise one is started and stopped. */
  postgres?: Parameters<typeof ReplaySession.open>[0]['postgres'];
  log?: (line: string) => void;
}

export interface RunReport {
  mode: Mode;
  commit: string;
  outcomes: ValidationOutcome[];
  /** Validations that belong to another release's tree (faithful) or were not selected. */
  skipped: number;
  /** Whether each pack a replayed run was started with is reproduced by this tree. */
  packs: PackMatch[];
  notes: string[];
}

interface RunFacts {
  pack: string;
  pack_digest: string;
  skills: Array<{ pack: string; version: string; digest: string }>;
}

async function runFacts(recorded: RecordedExport, run: string): Promise<RunFacts | null> {
  const entry = recorded.runs.get(run);
  if (entry === undefined) return null;
  const body = (await recorded.read(entry)) as { pack?: string; pack_digest?: string; skills?: Array<{ pack: string; version: string; digest: string }> };
  return body.pack === undefined || body.pack_digest === undefined ? null : { pack: body.pack, pack_digest: body.pack_digest, skills: body.skills ?? [] };
}

/** Publishes the packs of a tree that the registry does not have yet (by id and version), skills before the rest, as many passes as make progress. */
export async function publishMissing(hub: AssembledHub, admin: Principal, repo: string, directories: readonly PackDirectory[], log: (line: string) => void): Promise<Map<string, string>> {
  await hub.records.authorizations.grantPublishRight(admin, admin.id, '回放候选提交的任务包');
  const order = ['skill', 'system', 'product', 'workflow'];
  const sorted = [...directories].sort((a, b) => (order.indexOf(a.kind) < 0 ? 9 : order.indexOf(a.kind)) - (order.indexOf(b.kind) < 0 ? 9 : order.indexOf(b.kind)));
  const refused = new Map<string, string>();
  let pending = sorted;
  for (let pass = 0; pass < 4 && pending.length > 0; pass += 1) {
    const next: PackDirectory[] = [];
    for (const directory of pending) {
      if ((await hub.registry.getVersion(directory.id, directory.version)) !== null) continue;
      const staged = await stagePack(join(repo, directory.dir));
      try {
        const outcome = await hub.registry.publish(admin, staged);
        if (outcome.ok) log(`候选的 ${directory.id}@${directory.version} 已发布`);
        else {
          refused.set(`${directory.id}@${directory.version}`, outcome.problems.slice(0, 3).map((p) => p.message).join('；'));
          next.push(directory);
        }
      } finally {
        await rm(dirname(staged), { recursive: true, force: true });
      }
    }
    if (next.length === pending.length) break;
    pending = next;
    if (pending.length === 0) refused.clear();
  }
  return refused;
}

/** Replays the selected validations of the recorded export and compares each with its record. */
export async function runReplay(config: RunConfig): Promise<RunReport> {
  const log = config.log ?? (() => {});
  const notes: string[] = [];
  const outcomes: ValidationOutcome[] = [];
  let skipped = 0;
  const selected: ValidationTask[] = [];
  for (const task of config.recorded.tasks) {
    const window = config.mode === 'faithful' && config.windows !== undefined ? windowOf(config.windows, task.at) : null;
    const foreign = config.mode === 'faithful' && config.windows !== undefined && (window === null || !(window.commit.startsWith(config.commit) || config.commit.startsWith(window.commit)));
    const chosen = (config.only?.runs === undefined || config.only.runs.includes(task.run)) && (config.only?.seqs === undefined || config.only.seqs.includes(task.seq));
    if (foreign || !chosen) skipped += 1;
    else selected.push(task);
  }
  // Submissions stored and never validated have no result to replay; they are named once, with the tree of their release.
  for (const entry of config.recorded.unvalidated) {
    const window = config.mode === 'faithful' && config.windows !== undefined ? windowOf(config.windows, entry.at) : null;
    const ours = config.mode === 'candidate' || config.windows === undefined || (window !== null && (window.commit.startsWith(config.commit) || config.commit.startsWith(window.commit)));
    if (ours && (config.only?.runs === undefined || config.only.runs.includes(entry.run))) notes.push(`提交 ${entry.file}（${entry.at}）没有对应的核对结果：存了，没有核验；回放不覆盖`);
  }
  const limited = config.only?.limit === undefined ? selected : selected.slice(0, config.only.limit);
  skipped += selected.length - limited.length;
  const releaseOf = (task: ValidationTask): string | null => (config.windows === undefined ? null : windowOf(config.windows, task.at)?.commit ?? null);

  const make = (task: ValidationTask, extra: Pick<ValidationOutcome, 'status'> & Partial<ValidationOutcome>): ValidationOutcome => ({
    seq: task.seq, run: task.run, pack: task.pack, at: task.at, ordinal: task.ordinal, file: task.file, release: releaseOf(task), notes: [], misses: { records: [], objects: [] }, ms: 0, ...extra,
  });
  const refuse = (task: ValidationTask, code: string, message: string): ValidationOutcome => make(task, { status: 'not_replayable', reason: { code, message } });

  // Which packs each replayed run was started with, and whether this tree reproduces them.
  const facts = new Map<string, RunFacts>();
  for (const run of new Set(limited.map((t) => t.run))) {
    const found = await runFacts(config.recorded, run);
    if (found !== null) facts.set(run, found);
  }
  const wanted = new Map<string, RecordedPack>();
  for (const f of facts.values()) wanted.set(`${f.pack}\0${f.pack_digest}`, { pack: f.pack, digest: f.pack_digest });
  const packs = await matchPacks(config.repo, [...wanted.values()]);
  for (const match of packs) {
    if (match.status === 'same') log(`${match.pack} ${match.digest.slice(0, 12)}：这棵代码树重算出同一个摘要`);
    else notes.push(`${match.pack}：这棵代码树${match.status === 'absent' ? '没有这个版本' : `里这个版本的摘要是 ${String(match.found).slice(0, 12)}，不是记录的 ${match.digest.slice(0, 12)}`}`);
  }

  // A candidate binds each run to the tree's pack of the same id.
  const binds = config.mode === 'candidate' && config.packs !== 'recorded';
  const directories = binds ? await findPackDirectories(config.repo) : [];
  const rebind = new Map<string, { pack: string; pack_digest: string }>();
  const bindings = new Map<string, { from: string; to: string }>();
  const unbound = new Map<string, { code: string; message: string }>();
  if (binds) {
    const identities = new Map<string, Awaited<ReturnType<typeof packIdentity>>>();
    for (const [run, f] of facts) {
      const id = f.pack.split('@')[0];
      const directory = directories.find((d) => d.id === id);
      if (directory === undefined) {
        unbound.set(run, { code: 'pack_not_in_commit', message: `这棵代码树里没有任务包 ${id}，运行 ${run} 不能改绑` });
        continue;
      }
      let identity = identities.get(directory.dir);
      if (identity === undefined) identities.set(directory.dir, (identity = await packIdentity(config.repo, directory)));
      if (identity.digest === null) {
        unbound.set(run, { code: 'pack_refused', message: `候选的 ${id}@${directory.version} 打不成发布目录：${identity.problem ?? ''}` });
        continue;
      }
      if (identity.digest !== f.pack_digest) {
        rebind.set(run, { pack: `${id}@${directory.version}`, pack_digest: identity.digest });
        bindings.set(run, { from: f.pack, to: `${id}@${directory.version}` });
      }
    }
  }

  if (config.bundle === null) {
    for (const task of limited) {
      const binding = bindings.get(task.run);
      outcomes.push(task.submission === null
        ? refuse(task, 'no_submission', '这条核对结果不是对某次提交的核对（导出里没有它对应的提交）：它是运行自己产生的结果，不经 submit_result，本回放不覆盖')
        : unbound.has(task.run)
        ? refuse(task, unbound.get(task.run)!.code, unbound.get(task.run)!.message)
        : make(task, { status: 'not_replayable', reason: { code: 'no_bundle', message: '没有给 Hub 数据包（--bundle）：验证要读知识树、来源原件、记录和任务包，这些在 Hub 的数据库里，导出里没有；清单见 needs-export.md' }, ...(binding === undefined ? {} : { rebound: binding }) }));
    }
    return { mode: config.mode, commit: config.commit, outcomes, skipped, packs, notes };
  }

  const known = await validationFacts(config.bundle);
  const replayable = limited.filter((t) => t.submission !== null && known.has(t.seq) && !unbound.has(t.run));
  let session: ReplaySession | null = null;
  let refusedPacks = new Map<string, string>();
  try {
    if (replayable.length > 0) {
      const needPublishing = binds && rebind.size > 0;
      session = await ReplaySession.open({
        bundle: config.bundle,
        ...(config.limits === undefined ? {} : { limits: config.limits }),
        ...(config.requireOsIsolation === undefined ? {} : { requireOsIsolation: config.requireOsIsolation }),
        ...(config.postgres === undefined ? {} : { postgres: config.postgres }),
        ...(rebind.size === 0 ? {} : { rebind }),
        ...(needPublishing ? { prepare: async (hub: AssembledHub, admin: Principal) => { refusedPacks = await publishMissing(hub, admin, config.repo, directories, log); } } : {}),
        log,
      });
    }
    for (const task of limited) {
      if (task.submission === null) {
        outcomes.push(refuse(task, 'no_submission', '这条核对结果不是对某次提交的核对（导出里没有它对应的提交）：它是运行自己产生的结果，不经 submit_result，本回放不覆盖'));
        continue;
      }
      const unboundReason = unbound.get(task.run);
      if (unboundReason !== undefined) {
        outcomes.push(refuse(task, unboundReason.code, unboundReason.message));
        continue;
      }
      const fact = known.get(task.seq);
      if (fact === undefined) {
        outcomes.push(refuse(task, 'not_in_bundle', `数据包里没有位置 ${task.seq} 的 validation_result 记录（数据包的截止位置 ${config.bundle.manifest.cutoff_seq}）`));
        continue;
      }
      const binding = bindings.get(task.run);
      const refused = binding === undefined ? undefined : refusedPacks.get(binding.to);
      if (refused !== undefined) {
        outcomes.push(refuse(task, 'candidate_pack_refused', `候选的 ${binding!.to} 发布被拒：${refused}`));
        continue;
      }
      const args = (await config.recorded.read(task.submission.entry)) as Record<string, unknown>;
      const recordedValidation = (await config.recorded.read(task.entry)) as Json;
      const outcome = await session!.replay({ seq: task.seq, args, facts: fact });
      log(`${task.run} 位置 ${task.seq}：${outcome.status === 'not_replayable' ? `未回放（${outcome.reason?.code}）` : '已回放'}`);
      if (outcome.status === 'not_replayable') {
        outcomes.push(make(task, { status: 'not_replayable', reason: outcome.reason, notes: outcome.notes, misses: outcome.misses, ms: outcome.ms }));
        continue;
      }
      if (outcome.cached === true) {
        outcomes.push(make(task, { status: 'not_replayable', reason: { code: 'served_from_record', message: '回放时 Hub 把当时已存的同一份提交的结果原样答了回来，没有重新核对；这条核对原是强制重验（维护轮）产生的，本回放不能强制重验' }, notes: outcome.notes, misses: outcome.misses, ms: outcome.ms }));
        continue;
      }
      if (outcome.result === undefined && task.ordinal >= 2) {
        outcomes.push(make(task, { status: 'not_replayable', reason: { code: 'recheck_not_reproduced', message: '这条核对原是同一份提交之后的强制重验（维护轮，第 ' + task.ordinal + ' 次），回放调用提交函数时 Hub 没有再产生核对结果；本回放不能强制重验' }, ...(outcome.answer === undefined ? {} : { answer: outcome.answer }), notes: outcome.notes, misses: outcome.misses, ms: outcome.ms }));
        continue;
      }
      const comparison = compareResults(recordedValidation, outcome.result ?? null, { rebound: binding !== undefined });
      outcomes.push(make(task, {
        status: comparison.same ? 'same' : 'changed',
        comparison,
        ...(binding === undefined ? {} : { rebound: binding }),
        ...(outcome.result === undefined ? { answer: outcome.answer } : {}),
        notes: outcome.notes,
        misses: outcome.misses,
        ms: outcome.ms,
      }));
    }
  } finally {
    await session?.close();
  }
  return { mode: config.mode, commit: config.commit, outcomes, skipped, packs, notes };
}

/** Opens the bundle given on the command line; a folder that is not a bundle is an error, an absent argument is none. */
export async function openOptionalBundle(dir: string | undefined): Promise<Bundle | null> {
  if (dir === undefined) return null;
  const present = await readdir(dir).then(() => true, () => false);
  if (!present) throw new Error(`数据包目录 ${dir} 不存在`);
  return openBundle(dir);
}
