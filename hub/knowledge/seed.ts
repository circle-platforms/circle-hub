// `circle-hub knowledge seed`: the administrator command that calls produceSeedling. The three sources are the ones the
// product pack already declares (a command-tree input, a CLI manual, an APP manual). The command tree is the named
// build's, else the newest released build of the line. A manual whose producer declares a meta input or a list input
// reads each main file's own directory, at one revision and without a batch cut, when its root parameter is set. A null
// root keeps the external manual templates. An SVN read's revision is what the seedling record and the composition keep.
// A missing source is reported as itself, with the next command, and does not produce a partial tree.
import { expandTemplate, type KnownBuild, type Producer, type ProducerSource, type ProductDeclaration } from '../../contracts/src/product.ts';
import type { PacksPort, ProductHandle, ResourceCatalogPort } from '../ports.ts';
import { EXTERNAL_ARTIFACT } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { KnowledgeError, describeError } from './errors.ts';
import type { Knowledge } from './service.ts';
import { DEFAULT_SANDBOX, type KnowledgeContext } from './context.ts';
import { knowledgeSourceLoader } from './credential-policy.ts';
import { bindDirectorySources, declaredDirectory } from './directory-sources.ts';
import { produceSeedling, seedlingName, type SeedlingResult } from './seedling.ts';
import { resolveProductVariables } from './variables.ts';

export const KNOWLEDGE_SEED_USAGE = 'knowledge seed --product <产品> --line <版本线> [--build <构建>] --basis <一句理由> [--dry-run]';

const ROLES = ['command-tree', 'cli-manual', 'app-manual'] as const;
export type SeedRoleName = (typeof ROLES)[number];

const LABEL: Record<SeedRoleName, string> = { 'command-tree': '命令树', 'cli-manual': 'CLI 手册', 'app-manual': 'APP 手册' };
const MANUAL_SLOT: Record<'cli-manual' | 'app-manual', string> = { 'cli-manual': 'cli', 'app-manual': 'app' };
const PACK_AUTHOR = '产品包作者在构建生产器里声明这个来源后重新发布产品包';
const PACK_ONE = '产品包作者把这个来源收成一份后重新发布产品包';
const PICK_BUILD = '用 --build 指定构建，让构建的产品族选出一份手册';

export interface KnowledgeSeedArgs {
  product: string;
  line: string;
  build: string | null;
  basis: string;
  dryRun: boolean;
}

export interface SeedBinding {
  producer: string;
  slot: string;
  input: ProducerSource;
}

export interface SeedGap {
  role: SeedRoleName;
  label: string;
  detail: string;
  next: string;
}

export interface SeedSourceLine {
  role: SeedRoleName;
  label: string;
  producer: string;
  slot: string;
  external: string;
  sha256: string | null;
  revision: string | null;
}

export interface SeedReport {
  ok: boolean;
  product: string;
  pack: string;
  line: string;
  build: string | null;
  dry_run: boolean;
  root: string | null;
  seedling: string | null;
  composition: string | null;
  sources: SeedSourceLine[];
  /** SVN rows of the written composition, so a revision that reached the record is visible beside the seedling origin. */
  composition_revisions: Array<{ producer: string; slot: string; external: string; revision: string | null }>;
  pointer: { moved: boolean; from: string | null; to: string | null; reason: string } | null;
  missing: SeedGap[];
  /** Non-blocking facts of the seed (an optional source not read while its declared directory root covers the role). */
  notes: string[];
  reason: string | null;
}

/** Parses the arguments after `knowledge seed`. Throws KnowledgeError with the usage on anything unknown or missing. */
export function parseKnowledgeSeedArgs(argv: readonly string[]): KnowledgeSeedArgs {
  const out: KnowledgeSeedArgs = { product: '', line: '', build: null, basis: '', dryRun: false };
  const value = (name: string, inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) throw new KnowledgeError(`${name} 缺少取值；用法：${KNOWLEDGE_SEED_USAGE}`);
    return [next, i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    switch (name) {
      case '--product':
        [out.product, i] = value(name, inline, i);
        break;
      case '--line':
        [out.line, i] = value(name, inline, i);
        break;
      case '--build':
        [out.build, i] = value(name, inline, i);
        break;
      case '--basis':
        [out.basis, i] = value(name, inline, i);
        break;
      case '--dry-run':
        if (inline !== undefined) throw new KnowledgeError(`--dry-run 不带取值；用法：${KNOWLEDGE_SEED_USAGE}`);
        out.dryRun = true;
        break;
      default:
        throw new KnowledgeError(`不认识的参数 ${arg.slice(0, 80)}；用法：${KNOWLEDGE_SEED_USAGE}`);
    }
  }
  if (out.product.trim() === '') throw new KnowledgeError(`要用 --product 指定产品；用法：${KNOWLEDGE_SEED_USAGE}`);
  if (out.line.trim() === '') throw new KnowledgeError(`要用 --line 指定版本线；用法：${KNOWLEDGE_SEED_USAGE}`);
  if (out.build !== null && out.build.trim() === '') throw new KnowledgeError('--build 的取值不能为空');
  if (out.basis.trim() === '') throw new KnowledgeError(`要用 --basis 给一句理由；用法：${KNOWLEDGE_SEED_USAGE}`);
  if (/[\r\n]/.test(out.basis)) throw new KnowledgeError('--basis 只能是一行');
  if (out.basis.trim().length > 500) throw new KnowledgeError('--basis 最长 500 字');
  out.basis = out.basis.trim();
  return out;
}

function gap(role: SeedRoleName, detail: string, next: string): SeedGap {
  return { role, label: LABEL[role], detail, next };
}

function familyOf(producer: Producer): string | null {
  const family = producer.params?.family;
  return typeof family === 'string' && family !== '' ? family : null;
}

function acceptsFamily(producer: Producer, family: string | null): boolean {
  const declared = familyOf(producer);
  return declared === null || (family !== null && declared === family);
}

function isMany(input: ProducerSource): boolean {
  return 'source' in input && input.many === true;
}

function treeInput(producer: Producer): [string, ProducerSource] | 'several' | null {
  const entries = Object.entries(producer.inputs).filter(([, input]) => 'source' in input && input.source === 'tree' && !isMany(input));
  if (entries.length > 1 && !entries.some(([slot]) => slot === 'tree')) return 'several';
  const chosen = entries.find(([slot]) => slot === 'tree') ?? (entries.length === 1 ? entries[0] : undefined);
  return chosen ?? null;
}

function slotInput(producer: Producer, slot: string): [string, ProducerSource] | null {
  const input = producer.inputs[slot];
  if (input === undefined || isMany(input)) return null;
  return [slot, input];
}

/**
 * The three seedling roles as this product pack declares them. `command-tree` is that producer id, else the one catalog
 * whose id starts with `commands`. A manual is the producer id `cli-manual` / `app-manual`, else the `cli` / `app` slot,
 * and a producer that names `params.family` only matches that build family. Another producer's `source: 'tree'` input
 * (a manual that also receives the command tree) is not a second command-tree role.
 */
export function seedRoles(product: ProductDeclaration, family: string | null): { bindings: Partial<Record<SeedRoleName, SeedBinding>>; gaps: SeedGap[] } {
  const versioned = product.producers.filter((producer) => producer.unversioned !== true);
  const bindings: Partial<Record<SeedRoleName, SeedBinding>> = {};
  const gaps: SeedGap[] = [];

  const namedTree = versioned.find((producer) => producer.id === 'command-tree');
  if (namedTree) {
    const slot = treeInput(namedTree);
    if (slot === 'several') gaps.push(gap('command-tree', '生产器 command-tree 有多份 tree 来源', PACK_ONE));
    else if (slot === null) gaps.push(gap('command-tree', '生产器 command-tree 没有非列表的 tree 来源', PACK_AUTHOR));
    else bindings['command-tree'] = { producer: namedTree.id, slot: slot[0], input: slot[1] };
  } else {
    const catalogs = product.catalogs.filter((catalog) => catalog.id.startsWith('commands') && catalog.producer !== undefined);
    const producers = catalogs.flatMap((catalog) => {
      const producer = versioned.find((item) => item.id === catalog.producer);
      return producer ? [producer] : [];
    });
    if (producers.length !== 1) gaps.push(gap('command-tree', producers.length === 0 ? '产品包没有声明树苗来源' : `对上了多个命令目录（${catalogs.map((catalog) => catalog.id).join('、')}）`, producers.length === 0 ? PACK_AUTHOR : PACK_ONE));
    else {
      const slot = treeInput(producers[0]);
      if (slot === null || slot === 'several') gaps.push(gap('command-tree', '命令目录的生产器没有单独的 tree 来源', slot === 'several' ? PACK_ONE : PACK_AUTHOR));
      else bindings['command-tree'] = { producer: producers[0].id, slot: slot[0], input: slot[1] };
    }
  }

  for (const role of ['cli-manual', 'app-manual'] as const) {
    const slot = MANUAL_SLOT[role];
    const byId = versioned.filter((producer) => producer.id === role);
    const bySlot = versioned.filter((producer) => producer.id !== role && slotInput(producer, slot) !== null);
    const pool = byId.length > 0 ? byId : bySlot;
    const candidates = pool.filter((producer) => acceptsFamily(producer, family));
    if (candidates.length === 0 && pool.length > 0 && family !== null) {
      gaps.push(gap(role, `产品族 ${family} 对不上生产器（${pool.map((producer) => producer.id).join('、')}）`, PACK_AUTHOR));
      continue;
    }
    if (candidates.length !== 1) {
      const names = (candidates.length > 0 ? candidates : pool).map((producer) => producer.id).join('、');
      const waiting = family === null && pool.some((producer) => familyOf(producer) !== null);
      gaps.push(gap(role, pool.length === 0 ? '产品包没有声明树苗来源' : `对上了多个生产器（${names}）${waiting ? '，还不知道本次构建的产品族' : ''}`, pool.length === 0 ? PACK_AUTHOR : waiting ? PICK_BUILD : PACK_ONE));
      continue;
    }
    const chosen = slotInput(candidates[0], slot) ?? (Object.keys(candidates[0].inputs).length === 1 ? Object.entries(candidates[0].inputs)[0] : null);
    if (chosen === null || isMany(chosen[1])) gaps.push(gap(role, `生产器 ${candidates[0].id} 没有单独的 ${slot} 来源`, PACK_AUTHOR));
    else bindings[role] = { producer: candidates[0].id, slot: chosen[0], input: chosen[1] };
  }
  return { bindings, gaps };
}

function contextOf(knowledge: Knowledge): KnowledgeContext {
  return knowledge.__context;
}

function systemId(pack: string): string {
  const at = pack.lastIndexOf('@');
  return at > 0 ? pack.slice(0, at) : pack;
}

function publicText(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, '（地址已略）').replace(/127\.0\.0\.1/g, '回环地址');
}

function blank(product: ProductHandle, line: string, dryRun: boolean): SeedReport {
  return {
    ok: false, product: product.product.id, pack: `${product.id}@${product.version}`, line, build: null, dry_run: dryRun,
    root: null, seedling: null, composition: null, sources: [], composition_revisions: [], pointer: null, missing: [], notes: [], reason: null,
  };
}

function syncCommand(shown: string, line: string): string {
  return `circle-hub knowledge sync --product ${shown} --line ${line}`;
}

function resourceCommand(): string {
  return 'circle-hub resource add svn --name <名字> --environment <环境> --origin svn=<地址>';
}

function againCommand(shown: string, line: string): string {
  return `circle-hub knowledge seed --product ${shown} --line ${line} --basis <一句理由>`;
}

/** Runs `knowledge seed` for an admin. `resources` is the assembled catalog; without it an SVN id is read and the failure stands as the report. */
export async function knowledgeSeed(knowledge: Knowledge, packs: PacksPort, by: Principal, args: KnowledgeSeedArgs, resources?: ResourceCatalogPort): Promise<SeedReport> {
  const product = (await packs.productByName(args.product)) ?? (await packs.productById(args.product));
  if (product === null) throw new KnowledgeError(`没有叫 ${args.product.slice(0, 80)} 的已发布产品包`);
  const shown = args.product.slice(0, 80);
  const report = blank(product, args.line, args.dryRun);
  const productId = product.product.id;

  let build;
  if (args.build === null) {
    const released = (await knowledge.builds(productId, { line: args.line, released: true })).slice().sort((a, b) => (a.released_at ?? '').localeCompare(b.released_at ?? '') || a.name.localeCompare(b.name));
    build = released.at(-1) ?? null;
    if (build === null) {
      report.reason = `版本线 ${args.line} 没有已发布的构建，没有命令树`;
      report.missing.push(gap('command-tree', report.reason, syncCommand(shown, args.line)));
      return report;
    }
  } else {
    build = await knowledge.resolveBuild(productId, args.build);
    if (build === null) {
      report.reason = `不认识构建 ${args.build.slice(0, 80)}`;
      report.missing.push(gap('command-tree', report.reason, syncCommand(shown, args.line)));
      return report;
    }
  }
  report.build = build.name;
  if (build.line !== args.line) {
    report.reason = `构建 ${build.name} 属于版本线 ${build.line}，不是 ${args.line}`;
    return report;
  }
  if (build.base !== build.name) {
    report.reason = `构建 ${build.name} 是 ${build.base} 的别名，树苗用基础构建的树`;
    report.missing.push(gap('command-tree', report.reason, `circle-hub knowledge seed --product ${shown} --line ${args.line} --build ${build.base} --basis <一句理由>`));
    return report;
  }

  const { bindings, gaps } = seedRoles(product.product, build.family);
  report.missing.push(...gaps);
  const context = contextOf(knowledge);
  const resolved = new Map<SeedRoleName, { binding: SeedBinding; external: string }>();
  for (const role of ROLES) {
    const binding = bindings[role];
    if (binding === undefined) continue;
    const found = externalOf(build, binding.input, productId, shown, args.line);
    if ('detail' in found) report.missing.push(gap(role, found.detail, found.next));
    else resolved.set(role, { binding, external: found.external });
  }
  const manualBinding = bindings['cli-manual'];
  const manualProducer = manualBinding === undefined ? undefined : product.product.producers.find((producer) => producer.id === manualBinding.producer);
  const directory = manualProducer === undefined ? null : declaredDirectory(manualProducer);
  let directoryRoot: unknown;
  let directoryMains: { cli: unknown; app: unknown } | undefined;
  if (directory === 'several' && manualBinding) report.missing.push(gap('cli-manual', `生产器 ${manualBinding.producer} 有多份列表来源`, PACK_ONE));
  else if (directory && manualProducer) {
    const resolvedProduct = await resolveProductVariables(product, context.records.variables, by, args.dryRun, { plan: { ...DEFAULT_SANDBOX.plan, ...context.sandbox.plan }, producer: { ...DEFAULT_SANDBOX.producer, ...context.sandbox.producer } });
    if ('problems' in resolvedProduct) report.missing.push(gap('cli-manual', resolvedProduct.problems.join('；'), againCommand(shown, args.line)));
    else {
      const params = resolvedProduct.product.product.producers.find((producer) => producer.id === manualProducer.id)?.params;
      directoryRoot = params?.root;
      directoryMains = { cli: params?.main, app: params?.app_main };
    }
  }
  const directoryIsSvn = typeof directoryRoot === 'string';
  if (resources && (directoryIsSvn || [...resolved.values()].some((row) => row.external.startsWith('svn:')))) {
    const listed = await resources.list(by);
    const enabled = listed.some((row) => row.enabled && systemId(row.system_pack) === 'svn');
    if (!enabled) {
      for (const role of ROLES) {
        const row = resolved.get(role);
        if (row?.external.startsWith('svn:')) {
          report.missing.push(gap(role, '没有启用的 svn 系统包资源', resourceCommand()));
          resolved.delete(role);
        }
      }
      if (directoryIsSvn) report.missing.push(gap('cli-manual', '没有启用的 svn 系统包资源', resourceCommand()));
    }
  }

  const revisions: { cli?: string; app?: string } = {};
  for (const role of ROLES) {
    const row = resolved.get(role);
    if (row === undefined) continue;
    let read;
    try {
      read = await context.external.read(row.external, { principal: by, run: null, purpose: 'knowledge seed' });
    } catch (error) {
      // A declared adoc directory root covers the manual role: the markdown input is optional in the pack, so an
      // unreadable markdown source is a reported fact, never a blocked seed. Without a root the markdown is the only
      // manual and its failure stays a gap.
      if (typeof directoryRoot === 'string' && (role === 'cli-manual' || role === 'app-manual')) {
        report.notes.push(`可选来源 ${row.external} 未读到（${publicText(describeError(error))}）；手册按已声明的 adoc 根 ${directoryRoot} 生产`);
        continue;
      }
      report.missing.push(gap(role, `读取 ${row.external} 失败：${publicText(describeError(error))}`, againCommand(shown, args.line)));
      continue;
    }
    if (!read.ok) {
      if (typeof directoryRoot === 'string' && (role === 'cli-manual' || role === 'app-manual')) {
        report.notes.push(`可选来源 ${row.external} 未读到（${publicText(read.reason)}）；手册按已声明的 adoc 根 ${directoryRoot} 生产`);
        continue;
      }
      report.missing.push(gap(role, `读取 ${row.external} 失败：${publicText(read.reason)}`, againCommand(shown, args.line)));
      continue;
    }
    if (row.external.startsWith('svn:') && (read.revision === null || read.revision === '')) {
      report.missing.push(gap(role, `SVN 读取没有给出修订号（${row.external}）`, againCommand(shown, args.line)));
      continue;
    }
    const artifact = read.artifacts.find((item) => item.name === EXTERNAL_ARTIFACT.content) ?? read.artifacts.find((item) => item.name === EXTERNAL_ARTIFACT.original);
    report.sources.push({
      role, label: LABEL[role], producer: row.binding.producer, slot: row.binding.slot, external: row.external,
      sha256: artifact?.artifact.body.sha256 ?? null, revision: read.revision,
    });
    if (role === 'cli-manual' && read.revision) revisions.cli = read.revision;
    if (role === 'app-manual' && read.revision) revisions.app = read.revision;
  }
  let overlay: Record<string, string | string[]> | null = null;
  const svnBlocked = report.missing.some((item) => item.detail === '没有启用的 svn 系统包资源');
  if (directory && directory !== 'several' && manualProducer && typeof directoryRoot === 'string' && !svnBlocked) {
    const bound = await bindDirectorySources({
      producer: manualProducer, line: build.line, root: directoryRoot, ...(directoryMains ? { mains: directoryMains } : {}),
      loader: knowledgeSourceLoader(context, by, 'knowledge seed'), maxBytes: context.limits.maxBuildBytes, next: againCommand(shown, args.line),
    });
    if (!bound.ok) report.missing.push(gap('cli-manual', publicText(bound.detail), bound.next));
    else overlay = bound.sources;
  }
  if (report.missing.length > 0) return report;
  const roles = {
    'command-tree': { producer: resolved.get('command-tree')!.binding.producer, slot: resolved.get('command-tree')!.binding.slot },
    'cli-manual': { producer: resolved.get('cli-manual')!.binding.producer, slot: resolved.get('cli-manual')!.binding.slot },
    'app-manual': { producer: resolved.get('app-manual')!.binding.producer, slot: resolved.get('app-manual')!.binding.slot },
  };
  if (args.dryRun) {
    // The dry run runs the production itself — the same producers, the same sources, the same parsing — so a producer
    // that throws on this group fails the dry run with its own message instead of passing until the real seed. It
    // writes the ordinary production records (the audit stays), writes no seedling claim and moves no pointer.
    const only = [...new Set(Object.values(roles).map((role) => role.producer))];
    const produced = await knowledge.produceTree({ product, build, by, producers: only, ...(overlay ? { sources: overlay } : {}) });
    if (!produced.ok || produced.root === null) {
      report.reason = produced.reason ?? '试运行生产没有产出根';
      return report;
    }
    report.root = produced.root;
    report.composition = produced.composition;
    report.ok = true;
    report.pointer = { moved: false, from: null, to: null, reason: '试运行不写树苗，也不移动当前树苗指针' };
    return report;
  }

  const before = await context.records.pointers.get(seedlingName(productId, args.line));
  const result = await produceSeedling(context, knowledge, product, { line: args.line, build: build.name, by, basis: args.basis, roles, revisions: { cli: revisions.cli ?? null, app: revisions.app ?? null }, ...(overlay ? { sources: overlay } : {}) });
  return await finish(context, report, result, before?.target ?? null);
}

function externalOf(build: KnownBuild, input: ProducerSource, productId: string, shown: string, line: string): { external: string } | { detail: string; next: string } {
  if ('external' in input) {
    try {
      return { external: expandTemplate(input.external, { product: productId, line: build.line, build: build.name, base: build.base, family: build.family, ...(build.platform ? { platform: build.platform } : {}) }) };
    } catch (error) {
      return { detail: `外部标识模板填不出：${publicText((error as Error).message)}`, next: PACK_AUTHOR };
    }
  }
  const value = build.sources[input.source];
  const next = syncCommand(shown, line);
  if (typeof value === 'string') return { external: value };
  if (!Array.isArray(value) || value.length === 0) return { detail: `构建 ${build.name} 没有 ${input.source} 来源`, next };
  if (value.length === 1) return { external: value[0] };
  const svn = value.filter((id) => id.startsWith('svn:'));
  if (svn.length === 1) return { external: svn[0] };
  return { detail: svn.length === 0 ? `构建 ${build.name} 的 ${input.source} 是多份对象，其中没有单独的一份` : `构建 ${build.name} 的 ${input.source} 是多份 SVN 对象，树苗要单独一份`, next: PACK_ONE };
}

async function finish(context: KnowledgeContext, report: SeedReport, result: SeedlingResult, from: string | null): Promise<SeedReport> {
  report.root = result.root;
  report.seedling = result.seedling;
  report.composition = result.composition;
  report.reason = result.reason;
  if (result.origin.length > 0) {
    report.sources = result.origin.map((source) => ({
      role: source.role, label: LABEL[source.role], producer: source.producer, slot: source.slot,
      external: source.external, sha256: source.sha256, revision: source.revision,
    }));
  }
  if (result.ok && result.composition !== null) {
    const composed = await context.store.composition(result.composition);
    report.composition_revisions = (composed?.sources ?? []).filter((source) => source.external.startsWith('svn:')).map((source) => ({
      producer: source.producer, slot: source.slot, external: source.external, revision: source.revision,
    }));
    const forgotten = report.composition_revisions.filter((source) => source.revision === null);
    if (forgotten.length > 0) report.reason = forgotten.map((source) => `${source.producer}.${source.slot} 的修订号没有进组成记录`).join('；');
  }
  report.pointer = result.pointer === null ? null : {
    moved: result.pointer.moved, from, to: result.pointer.moved ? result.root : from, reason: result.pointer.reason,
  };
  const pointerFailed = report.pointer !== null && !report.pointer.moved && !report.pointer.reason.includes('已经指着');
  report.ok = result.ok && report.reason === null && !pointerFailed;
  return report;
}

/** The report as Chinese text for the terminal, one fact per line, in the same shape as a knowledge sync report. */
export function formatSeedReport(report: SeedReport): string {
  const lines: string[] = [];
  lines.push(`育苗：产品 ${report.product}（${report.pack}），版本线 ${report.line}${report.build === null ? '' : `，构建 ${report.build}`}${report.dry_run ? '，试运行' : ''}`);
  if (report.dry_run) lines.push('试运行不写树苗，读取仍留审计');
  if (report.composition !== null) lines.push(`组成 ${report.composition}`);
  for (const source of report.sources) {
    lines.push(`来源 ${source.label} ${source.producer}.${source.slot} ${source.external}${source.sha256 === null ? '' : ` ${source.sha256}`} 修订 ${source.revision ?? '（无）'}`);
  }
  for (const source of report.composition_revisions) lines.push(`组成来源 ${source.producer}.${source.slot} ${source.external} 修订 ${source.revision ?? '（无）'}`);
  if (report.pointer !== null) {
    lines.push(report.pointer.moved ? `指针：${report.pointer.from ?? '（无）'} → ${report.pointer.to}（${report.pointer.reason}）` : `指针：${report.pointer.reason}`);
  }
  for (const missing of report.missing) {
    lines.push(`缺 ${missing.label}（${missing.role}）：${missing.detail}`);
    lines.push(`下一步：${missing.next}`);
  }
  for (const note of report.notes) lines.push(`说明：${note}`);
  if (report.reason !== null && !report.missing.some((missing) => missing.detail === report.reason)) lines.push(`失败：${report.reason}`);
  return `${lines.join('\n')}\n`;
}
