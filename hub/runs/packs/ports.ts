// The ports runs-packs provides (hub/ports.ts) over the registry: PacksPort (packs and the active product lines),
// WorkflowStore (what a run needs of a workflow pack) and PackCatalogPort (the console listing). Absent, unassigned,
// withdrawn and unknown give the same null or empty answer; the account is re-read on every call.
import type { PackSummary } from '../../../contracts/src/run.ts';
import type { LoadedWorkflow, PackCatalogPort, PackHandle, PackListing, PacksPort, ProductHandle, WorkflowAbsence, WorkflowStore } from '../../ports.ts';
import type { Principal } from '../../records/api.ts';
import type { ActiveProduct, PackRegistry } from './registry.ts';
import type { PackVersionInfo, WorkflowDeclarations } from './types.ts';
import { parsePackRef } from './versions.ts';
import { dispatchCountOf, repetitionSummary } from '../engine/repetition.ts';

/**
 * Product lines a workflow binds (W03 R[5]): the one its product.id names, else every active product pack whose catalogs
 * include every catalog the workflow requires (workflow.product.catalogs and knowledge.json); none when it names no product
 * and requires no catalog.
 */
export function boundProducts(declarations: WorkflowDeclarations, active: readonly ActiveProduct[]): ActiveProduct[] {
  const id = declarations.workflow.product.id;
  if (id !== undefined) return active.filter((a) => a.product.id === id);
  const required = new Set([...declarations.workflow.product.catalogs, ...(declarations.knowledge?.requires ?? []).map((r) => r.catalog)]);
  // A workflow that names no product and requires no catalog serves no product line: it is not bound to every active one,
  // which would also let anyone assigned it read the knowledge of every product (readableProducts).
  if (required.size === 0) return [];
  return active.filter((a) => {
    const offered = new Set(a.product.catalogs.map((c) => c.id));
    return [...required].every((catalog) => offered.has(catalog));
  });
}

/** The list_task_packs entry of a workflow version. */
export function packSummary(info: PackVersionInfo, declarations: WorkflowDeclarations, bound: readonly ActiveProduct[]): PackSummary {
  const names: string[] = [];
  for (const b of bound) for (const name of b.product.names) if (!names.includes(name)) names.push(name);
  return {
    pack: `${info.id}@${info.version}`,
    id: info.id,
    version: info.version,
    kind: info.kind,
    title: info.title,
    description: info.description,
    products: names,
    inputs: declarations.workflow.inputs.map((i) => ({ slot: i.slot, role: i.role, description: i.description, accepts: [...i.accepts], required: i.required, many: i.many, ...(i.default_from_predecessor?{default_from_predecessor:{...i.default_from_predecessor}}:{}), ...(i.from_runs?{from_runs:{...i.from_runs}}:{}), ...(i.index_default?{index_default:structuredClone(i.index_default)}:{}) })),
    parameters: declarations.workflow.parameters.map((p) => ({ name: p.name, description: p.description, required: p.required, ...(p.schema !== undefined ? { schema: p.schema } : {}) })),
    requirements: declarations.requirements.requirements.map((r) => ({
      // V07 R[5]: the policy in force, from the same projection start_run freezes into the run record.
      repetition: repetitionSummary({
        workClass: declarations.workflow.work_class,
        layers: r.layers,
        declared: r.repetition,
        dispatchCount: dispatchCountOf(declarations.requirements.effects ?? [], r.key),
        fresh_context: r.repetition?.fresh_context,
        baseline_first: r.repetition?.baseline_first,
        window_seconds: r.repetition?.window_seconds,
      }),
      key: r.key,
      name: r.name,
      description: r.description,
      layers: [...r.layers],
      done_rule: r.done_rule,
      accepted_producer: r.accepted_producer,
      rules: r.checks.flatMap(id=>{const c=declarations.checks.checks.find(check=>check.id===id);return c ? [c.interpreter ?? `${info.id}.${c.id}@${info.version}`] : [];}),
      run_interpreters: r.run_table ? (declarations.ledger?.shapes.filter(row=>row.requirement===r.key).map(row=>row.interpreter) ?? []) : [],
      // The most rounds any repair row of the requirement allows (W02 F[7]); 0 without repair rows.
      repair_rounds: Math.max(0, ...r.error_handling.map((row) => row.max_rounds ?? 0)),
    })),
  };
}

async function productHandle(registry: PackRegistry, active: ActiveProduct): Promise<ProductHandle | null> {
  const opened = await registry.open(active.info.digest);
  if (opened === null) return null;
  return { ...opened.handle, kind: 'product', product: structuredClone(active.product) };
}

export function createPacksPort(registry: PackRegistry): PacksPort {
  return {
    async pack(ref: string): Promise<PackHandle | null> {
      const info = await registry.resolve(ref);
      if (info === null) return null;
      if(info.kind==='skill'&&!(await registry.installedSkills()).some(p=>p.info.digest===info.digest))return null;
      if (info.kind === 'product' && !(await registry.isActive(info.id))) return null;
      return (await registry.open(info.digest))?.handle ?? null;
    },
    // Several active product packs claiming one name or line id is a state the registry refuses; should one slip past it,
    // the lookup answers null (and the registry reports it to the admin log) instead of picking one.
    async productByName(name: string): Promise<ProductHandle | null> {
      const hit = await registry.productNamed(name);
      return hit === null ? null : productHandle(registry, hit);
    },
    async productById(id: string): Promise<ProductHandle | null> {
      const hit = await registry.productWithId(id);
      return hit === null ? null : productHandle(registry, hit);
    },
    async products(): Promise<ProductHandle[]> {
      const handles = await Promise.all((await registry.activeProducts()).map((a) => productHandle(registry, a)));
      return handles.filter((h): h is ProductHandle => h !== null);
    },
    async readableProducts(user: Principal): Promise<ReadonlySet<string>> {
      const account = await registry.account(user);
      if (account === null) return new Set();
      const active = await registry.activeProducts();
      if (account.role === 'admin') return new Set(active.map((a) => a.product.id));
      const out = new Set<string>();
      for (const id of await registry.packsFor(account.id)) {
        const info = await registry.latestVersion(id);
        if (info === null || info.kind !== 'workflow') continue;
        const raw = await registry.declarations(info.digest);
        const declarations=raw?.kind==='skill'?raw.method:raw;
        if (declarations?.kind !== 'workflow') continue;
        for (const bound of boundProducts(declarations, active)) out.add(bound.product.id);
      }
      return out;
    },
  };
}

export function createWorkflowStore(registry: PackRegistry): WorkflowStore {
  const load = async (info: PackVersionInfo): Promise<LoadedWorkflow | null> => {
    if (info.kind !== 'workflow' && info.kind !== 'skill') return null;
    const opened = await registry.open(info.digest);
    if (opened === null) return null;
    const method=opened.declarations.kind==='skill'?opened.declarations.method:opened.declarations;
    if(method?.kind!=='workflow')return null;
    // Copies: the declarations are shared by every caller of this version.
    const d = structuredClone(method);
    return {
      pack: opened.handle,
      owner: info.owner,
      manifest: structuredClone(info.manifest),
      workflow: d.workflow,
      requirements: d.requirements.requirements,
      effects: d.requirements.effects ?? [],
      checks: d.checks.checks,
      slots: d.slots,
      knowledge: d.knowledge,
      ledger: d.ledger,
      instructions: d.instructions,
      instructionsDigest: d.instructionsDigest,
      readJson: opened.readJson,
    };
  };
  return {
    async forUser(user: Principal, ref: string): Promise<LoadedWorkflow | null> {
      const account = await registry.account(user);
      const parsed = parsePackRef(ref);
      if (account === null || parsed === null || !(await registry.canUse(account.id, parsed.id))) return null;
      const info = await registry.resolve(ref);
      return info === null || info.kind==='skill'&&!(await registry.installedSkills()).some(p=>p.info.digest===info.digest) ? null : load(info);
    },
    async absence(user: Principal, ref: string): Promise<WorkflowAbsence | null> {
      const account = await registry.account(user);
      if (account === null) return 'disabled';
      const parsed = parsePackRef(ref);
      if (parsed?.version == null) return 'unknown';
      const info = await registry.getVersion(parsed.id, parsed.version);
      if (info === null) return 'unknown';
      if (info.withdrawn) return 'withdrawn';
      if (!(await registry.canUse(account.id, parsed.id)) || info.kind==='skill'&&!(await registry.installedSkills()).some(p=>p.info.digest===info.digest)) return 'unassigned';
      return null;
    },
    async publicationOf(digest: string): Promise<string | null> {return (await registry.byDigest(digest))?.record??null;},
    async ownerOf(digest: string): Promise<string | null> {
      return (await registry.byDigest(digest))?.owner ?? null;
    },
    async byDigest(digest: string): Promise<LoadedWorkflow | null> {
      const info = await registry.byDigest(digest);
      return info === null ? null : load(info);
    },
    async summaries(user: Principal): Promise<PackSummary[]> {
      const account = await registry.account(user);
      if (account === null) return [];
      const active = await registry.activeProducts();
      const out: PackSummary[] = [];
      for (const id of [...new Set([...(await registry.packsFor(account.id)),...(await registry.installedSkills()).filter(p=>p.declarations.kind==='skill'&&p.declarations.method!==null).map(p=>p.info.id)])]) {
        const installed=(await registry.installedSkills()).find(p=>p.info.id===id);
        const info = installed?.info ?? await registry.latestVersion(id);
        if (info === null || info.kind !== 'workflow' && info.kind !== 'skill') continue;
        const raw = await registry.declarations(info.digest);
        const declarations=raw?.kind==='skill'?raw.method:raw;
        if (declarations?.kind !== 'workflow') continue;
        out.push(packSummary(info, declarations, boundProducts(declarations, active)));
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}

function listing(info: PackVersionInfo, active: boolean, assigned?: string[]): PackListing {
  const out: PackListing = {
    id: info.id,
    version: info.version,
    kind: info.kind,
    title: info.title,
    owner: info.owner,
    digest: info.digest,
    published_at: info.published_at,
    withdrawn: info.withdrawn,
    active,
    samples: { ...info.samples },
  };
  if (assigned !== undefined) out.assigned_to = assigned;
  return out;
}

export function createPackCatalog(registry: PackRegistry): PackCatalogPort {
  return {
    async list(user: Principal): Promise<PackListing[]> {
      const account = await registry.account(user);
      if (account === null) return [];
      if (account.role === 'admin') {
        const out: PackListing[] = [];
        for (const pack of await registry.listPacks()) {
          const assigned = pack.kind === 'workflow' ? await registry.usersOf(pack.id) : [];
          // A product pack is active in the version it is used in: the latest that is not withdrawn.
          for (const version of pack.versions) out.push(listing(version, pack.kind==='skill'?(await registry.installedSkills()).some(p=>p.info.digest===version.digest):pack.active && version.version === pack.latest, assigned));
        }
        return out;
      }
      const out: PackListing[] = [];
      for (const id of [...new Set([...(await registry.packsFor(account.id)),...(await registry.installedSkills()).filter(p=>p.declarations.kind==='skill'&&p.declarations.method!==null).map(p=>p.info.id)])]) {
        const installed=(await registry.installedSkills()).find(p=>p.info.id===id);
        const info = installed?.info ?? await registry.latestVersion(id);
        if (info !== null && (info.kind === 'workflow'||info.kind==='skill')) out.push(listing(info, info.kind==='skill'));
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
  };
}
