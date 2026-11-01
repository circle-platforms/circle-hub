// What the run context of the listed packs would hold right now (decision 113), for list_task_packs: the lease view of every
// declared lease prefix and the newest device observations, read from the Hub's own records. The core does not read any
// inventory: names come only from lease prefixes and observation labels. Who holds a key is not said (R02 R[3]); an
// observation holds for its moment only (A05 R[3]) and the stored probe output is not referenced.
import type { PackSummary } from '../../../contracts/src/run.ts';
import type { PackContextView } from '../../../contracts/src/tools.ts';
import type { Principal } from '../../records/api.ts';
import type { EngineContext } from './deps.ts';

export type ContextOfPack = Pick<PackSummary, 'pack' | 'run_context'>;

export async function packContext(ctx: EngineContext, user: Principal, packs: readonly ContextOfPack[]): Promise<PackContextView | null> {
  const prefixes = new Map<string, string[]>();
  const observing: string[] = [];
  for (const pack of packs) {
    const declared = pack.run_context;
    if (declared === undefined) continue;
    if (declared.parts.includes('leases') && declared.lease_prefix !== undefined) prefixes.set(declared.lease_prefix, [...(prefixes.get(declared.lease_prefix) ?? []), pack.pack]);
    if (declared.parts.includes('observations')) observing.push(pack.pack);
  }
  if (prefixes.size === 0 && observing.length === 0) return null;
  const leases: PackContextView['leases'] = [];
  const service = ctx.deps.leases;
  if (service !== undefined) {
    for (const [prefix, users] of prefixes) {
      const registered = await service.registrations(prefix);
      const rows = (await service.view(prefix, true)).entries;
      const jobs = ctx.deps.leaseJobs !== undefined && rows.length > 0 ? await ctx.deps.leaseJobs(rows.map((row) => row.key)) : [];
      leases.push({
        prefix,
        packs: users,
        registrations: registered.map((row) => ({ prefix: row.prefix, mine: row.owner === user.id })),
        held: rows.map((row) => ({ key: row.key, since: row.since, until: row.until, run: row.run, jobs: jobs.filter((job) => job.key === row.key).map((job) => job.job), mine: row.user === user.id })),
      });
    }
  }
  const observations = observing.length > 0 && ctx.deps.observations !== undefined
    ? (await ctx.deps.observations.latest()).map((o) => ({ label: o.label, build: o.build, base: o.base, observed_at: o.observed_at, packs: observing }))
    : [];
  return { leases, observations };
}
