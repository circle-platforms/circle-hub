import { countEntryPositions } from './counts.ts';
import type { KnowledgeEntryCounts } from '../../contracts/src/views.ts';
import {knowledgeSourceLoader} from './credential-policy.ts';
import {resolveProductVariables,productionVariableUses} from './variables.ts';
import {emptyScopeNote} from './empty-scope.ts';
import type {VariableUse} from '../../contracts/src/variables.ts';
// Producing the root of one build (K01, K02, K04): read each declared source through the external reader in an admin
// context, parse it with the core parser for its media type, run each producer function in the sandbox (a list slot in
// batches, memoized), validate its output, verify every entry (kind, storable text, fragments, path), place what code could
// not place with the typed-judgment model, build the nodes bottom-up and write them (sharing every subtree that already
// exists), entries, the composition (one record, or parts beside it when large) and the generate action. Records are
// written in bounded chunks: entries first, then nodes from the leaves up (a node is stored only once its whole subtree is),
// then the parts, then the composition record with the generate action in one transaction. Every body is checked against
// its schema before it is written. A failure writes a generate action with the reason; content-addressed records written
// before it stay and are shared by the next production. Only a build whose own identity cannot be stored (checked first)
// is refused without a generate action.
import type {
  CompositionBasis,
  CompositionContentRow,
  CompositionPartRef,
  CompositionParts,
  CompositionRow,
  RecordedBuild,
  RefusedEntry,
  RootCatalog,
  RootSource,
  SkippedSource,
  TreeRootBody,
  UnplacedRow,
} from '../../contracts/src/knowledge.ts';
import { MAX_KEPT_PROBLEMS } from '../../contracts/src/knowledge.ts';
import { ENTRY_KIND, isEntryKind, labelOf, type EntryKind } from '../../contracts/generated/vocabulary.ts';
import { BuildInfo, expandTemplate, LinkDeclaration } from '../../contracts/src/product.ts';
import type { KnownBuild, Producer, ProducerOutput, TemplateVariable } from '../../contracts/src/product.ts';
import { CatalogEntry } from '../../contracts/src/tables.ts';
import type { ProductHandle } from '../ports.ts';
import { canonicalBytes, canonicalize, sha256Hex, type ActionBody, type Principal, type Transaction } from '../records/api.ts';
import { pathOf } from '../refs/api.ts';
import { PLACEMENT_CHAIN } from './calibration.ts';
import { runProducer } from './call.ts';
import { splitRows } from './composition.ts';
import { chunks, mapLimited } from './concurrency.ts';
import { requireAdmin, type KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, entryContentOf, entryDigest, type EntryContent } from './digest.ts';
import {emptyProblemChunks,keepProblemRows,type ProblemChunks} from './problem-journal.ts';
import {requestKnowledgeFact} from './requests.ts';
import type {Reason} from '../../contracts/generated/vocabulary.ts';
import { describeError } from './errors.ts';
import {
  DEFAULT_BATCH,
  ISOLATION_BASE_BATCHES,
  ListLoader,
  buildDigest,
  callBatch,
  emptyProbe,
  listBatches,
  uniqueList,
  type CallTotals,
  type ElementPeek,
  type ListCallContext,
  callSingleProducer,
  type ListState,
} from './lists.ts';
import { MAX_DESCRIPTION, type PlacementChild, type PlacementOutcome, type PlacementSpan } from './placement.ts';
import { SourceLoader, type ParsedSource, type SourceObservation } from './sources.ts';
import {
  ACTION,
  COMPONENTS,
  INDEX,
  MAX_KEPT_SKIPPED_IDS,
  SCHEMAS,
  buildKey,
  buildProblem,
  listRoles,
  recordedOf,
  withoutLists,
  type ListDetail,
  type ListedIds,
  type ProduceDetail,
} from './store.ts';
import { literalWarningDetails,relationFacts,relationNode } from './links.ts';
import { TreeBuilder, flatten, type BuiltNode } from './tree.ts';
import { checkPath, singleSources, verifyFragment, type FragmentSources } from './verify.ts';

/** Longest warning, refusal reason or failure reason kept (characters). */
const MAX_PROBLEM_TEXT = 1000;
const MAX_REASON_TEXT = 2000;

const ENTRY_KINDS_TEXT = ENTRY_KIND.map((kind) => `${kind} ${labelOf('entry_kind', kind)}`).join('、');

export interface ProduceInput {
  variables?:VariableUse[];
  product: ProductHandle;
  build: KnownBuild | null;
  scope?: BuildInfo['sources'];
  /** The admin whose context reads the sources; default the service's admin. */
  by?: Principal | null;
  /** The sync this production belongs to. */
  sync?: string | null;
  /** A loader shared by the builds of one sync, so a source several builds use is read once. */
  loader?: SourceLoader;
  /** List sources the package stored at most this many seconds ago are used again (default the limit; 0 reads each again). */
  maxAgeSeconds?: number;
  /** List sources read at the same time (default the limit listReadConcurrency, 4). */
  readConcurrency?: number;
  signal?: AbortSignal;
  listingDigest?:string;
  retrySkipped?:boolean;
  refreshSources?:ReadonlySet<string>;
  /** Run only these producer ids of the pack (the seedling production names its three); undefined runs all of the scope. */
  producers?: readonly string[];
  /**
   * Source roles to merge onto the build for this production only (a seedling directory the stored build does not keep).
   * Present means every list of this production is one call: the complete group, not a batch cut.
   */
  sources?: BuildInfo['sources'];
  /** The build names the sync's plan listed (the frozen known-build inventory the producers hash); a production
   *  without a plan freezes the build it is producing alone. Never accumulated from the records store (K01 R[1]). */
  planBuilds?: readonly string[];
}

export interface ProduceResult {
  ok: boolean;
  build: string | null;
  root: string | null;
  /** Digest of the tree_root record. */
  composition: string | null;
  /** Digest of the generate action; null only when the build itself could not be recorded. */
  action: string | null;
  /** Chinese reason of a failure. */
  reason: string | null;
  sources: ProduceDetail['sources'];
  nodes: number;
  /** Node records written by this production; the rest were shared with earlier roots. */
  created: number;
  /** Legacy placed (path, content) rows, excluding unplaced rows. */
  entries: number;
  /** Authoritative identity summary for reports and views; does not change stored composition rows. */
  entryCounts: KnowledgeEntryCounts;
  placedByModel: number;
  unplaced: number;
  refused: RefusedEntry[];
  refusedCount: number;
  /** Listed sources the production could not use (first 200), and how many there were. */
  skipped: SkippedSource[];
  skippedCount: number;
  sourceFailures?:SourceObservation[];
  /** Producer calls made in the sandbox and calls answered from stored outputs (memoized batches). */
  calls: { made: number; reused: number };
  /** List sources used again from a stored load, and list sources read through the port. */
  loads: { reused: number; read: number };
  /** Part records of the composition (0 when it is one record). */
  parts: number;
  warnings: string[];
  /** Entries without path not sent to the judgment service because their producer did not opt in. */
  placementSkipped?: Record<string, number>;
}

/** A source a producer reads, with the basis that decides it belongs to the version. */
export interface PlannedSource {
  parser?: string;
  producer: string;
  slot: string;
  /** The external object of a single slot; null for a list slot or when no id could be formed. */
  external: string | null;
  /** A list slot (many: true): the ids the build lists in the role, in order; null for a single slot or a missing role. */
  list: string[] | null;
  many: boolean;
  /** Objects per call of a list slot. */
  batch: number;
  optional: boolean;
  basis: CompositionBasis;
  /** Why no external id (or list) could be formed. */
  problem: string | null;
}

/** The declared sources of every producer for one build. */
export function plannedSources(product: ProductHandle, build: BuildInfo | null, scope: BuildInfo['sources'] = {}): PlannedSource[] {
  const out: PlannedSource[] = [];
  const values: Partial<Record<TemplateVariable, string>> = { product: product.product.id, ...(build === null ? {} : { line: build.line, build: build.name, base: build.base, family: build.family }) };
  if (build !== null && build.platform !== null) values.platform = build.platform;
  for (const producer of product.product.producers.filter(p => (p.unversioned === true) === (build === null))) {
    for (const [slot, source] of Object.entries(producer.inputs)) {
      const optional = source.optional === true;
      const parseDeclaration = source.parser === undefined ? {} : {parser:source.parser};
      if ('source' in source) {
        const held = Object.hasOwn(build?.sources ?? scope, source.source) ? (build?.sources ?? scope)[source.source] : null;
        const basis: CompositionBasis = build !== null && build.released_at !== null ? 'release_record' : 'declared';
        if (source.many === true) {
          // A role holding one id is a list of one.
          const list = held === null ? null : typeof held === 'string' ? [held] : [...held];
          out.push({ ...parseDeclaration,producer: producer.id, slot, external: null, list, many: true, batch: source.batch ?? DEFAULT_BATCH, optional, basis, problem: list === null ? `构建 ${build?.name ?? '不分版本'} 没有 ${source.source} 来源` : null });
          continue;
        }
        const external = typeof held === 'string' ? held : null;
        out.push({
          ...parseDeclaration,
          producer: producer.id,
          slot,
          external,
          list: null,
          many: false,
          batch: 0,
          optional,
          basis,
          problem: external === null ? (held === null ? `构建 ${build?.name ?? '不分版本'} 没有 ${source.source} 来源` : `构建 ${build?.name ?? '不分版本'} 的 ${source.source} 来源是一个列表，生产器的这个输入没有声明 many`) : null,
        });
      } else {
        const base = { ...parseDeclaration,producer: producer.id, slot, list: null, many: false, batch: 0, optional, basis: 'declared' as const };
        try {
          out.push({ ...base, external: expandTemplate(source.external, values), problem: null });
        } catch (error) {
          out.push({ ...base, external: null, problem: `来源模板 ${source.external} 填不出：${(error as Error).message}` });
        }
      }
    }
  }
  return out;
}

/** BuildInfo without the root a KnownBuild carries. Throws when the build is not build-info@1. */
export function infoOf(build: KnownBuild | BuildInfo): BuildInfo {
  return BuildInfo.parse({
    name: build.name,
    family: build.family,
    line: build.line,
    base: build.base,
    platform: build.platform,
    built_at: build.built_at,
    released_at: build.released_at,
    sources: build.sources,
  });
}

/** A verified entry of a producer's output. */
interface Collected {
  content: EntryContent & { kind: EntryKind };
  digest: string;
  producer: string;
  /** Position in the producer's output (all batches concatenated): its entries, or its unplaced spans. */
  index: number;
  unplaced: boolean;
  fragments: string[];
  applicability_sources?:CompositionRow['applicability_sources'];
  slots: string[];
  /** Estimated bytes of the entry in a composition row. */
  bytes: number;
}

/** One producer call's verified output, with indices local to the call. */
interface Verified {
  grammar?:ProducerOutput['grammar'];

  inventory: NonNullable<TreeRootBody['empty_scope']>['sources'];
  inventoryError: string | null;
  /** Entries with a path: its segments and canonical text, shared by every entry at that path. */
  placed: Array<Collected & { segments: string[]; path: string }>;
  toPlace: Array<Collected & { section: string }>;
  refused: RefusedEntry[];
  refusedCount: number;
  /** Refusals per declared kind, all of them (catalogs count their own). */
  refusedKinds: Map<string, number>;
  warnings: string[];
  entries: number;
  spans: number;
}

/** Problems of one production: refusals, warnings and skipped sources, the first ones kept and all counted. */
class Problems {
  chunks:ProblemChunks=emptyProblemChunks();
  allWarnings:string[]=[];
  allRefused:RefusedEntry[]=[];
  allSkipped:Array<SkippedSource&{retry?:boolean;reason_code?:Reason}>=[];
  async persist(context:KnowledgeContext,inputs:string[]):Promise<void>{
    this.chunks={warnings:await keepProblemRows(context,this.allWarnings,inputs),refused:await keepProblemRows(context,this.allRefused,inputs),skipped:await keepProblemRows(context,this.allSkipped,inputs)};
  }
  refused: RefusedEntry[] = [];
  refusedCount = 0;
  /** Refusals per producer and declared kind, all of them. */
  refusedOf = new Map<string, Map<string, number>>();
  warnings: string[] = [];
  warningsCount = 0;
  skipped: SkippedSource[] = [];
  skippedCount = 0;
  /** Skipped list sources per producer, all of them. */
  skippedOf = new Map<string, number>();

  warn(text: string): void {
    this.allWarnings.push(text);
    this.warningsCount++;
    if (this.warnings.length < MAX_KEPT_PROBLEMS) this.warnings.push(cutText(text, MAX_PROBLEM_TEXT));
  }

  refuse(item: RefusedEntry): void {
    this.countRefusal(item.producer, item.kind, 1);
    this.keep(item);
  }

  countRefusal(producer: string, kind: string, count: number): void {
    this.refusedCount += count;
    const kinds = this.refusedOf.get(producer) ?? new Map<string, number>();
    kinds.set(kind, (kinds.get(kind) ?? 0) + count);
    this.refusedOf.set(producer, kinds);
  }

  keep(item: RefusedEntry): void {
    this.allRefused.push(item);
    if (this.refused.length < MAX_KEPT_PROBLEMS) {
      this.refused.push({ ...item, kind: cutText(item.kind, 200), path: item.path === null ? null : cutText(item.path, MAX_PROBLEM_TEXT), reason: cutText(item.reason, MAX_PROBLEM_TEXT) });
    }
  }

  skip(item: SkippedSource&{retry?:boolean;reason_code?:Reason}): void {
    this.allSkipped.push(item);
    this.skippedCount++;
    this.skippedOf.set(item.producer, (this.skippedOf.get(item.producer) ?? 0) + 1);
    if (this.skipped.length < MAX_KEPT_PROBLEMS) this.skipped.push({ producer:item.producer, slot:item.slot, external:item.external, reason: cutText(item.reason, MAX_PROBLEM_TEXT) });
  }
}

/** The first line of a statement, as a placement description. */
function firstLine(statement: string | null): string | null {
  if (statement === null) return null;
  const line = statement.split('\n').find((l) => l.trim() !== '');
  return line === undefined ? null : cutText(line.trim(), MAX_DESCRIPTION);
}

/** Children of an in-memory tree for placement, with the first line of each child's first entry as its description. */
function placementTree(builder: TreeBuilder, contents: Map<string, EntryContent>): { children(segments: readonly string[]): PlacementChild[] } {
  return {
    children(segments) {
      const node = builder.find(segments);
      if (node === null) return [];
      return [...node.children.values()]
        .sort((a, b) => compareText(a.name, b.name))
        .map((child) => {
          const first = [...child.entries].sort(compareText)[0];
          return { name: child.name, description: firstLine(first === undefined ? null : (contents.get(first)?.statement ?? null)) };
        });
    },
  };
}

/** Basis of a row from the bases of every slot its fragments are in: one basis, or declared when they differ. */
function basisOver(slots: ReadonlySet<string>, producerSlotBasis: ReadonlyMap<string, CompositionBasis>): CompositionBasis {
  const bases = new Set([...slots].map((key) => producerSlotBasis.get(key) ?? 'declared'));
  return bases.size === 1 ? ([...bases][0] as CompositionBasis) : 'declared';
}

/** Checked paths of one production by the text a producer gave: one check, one segment array and one path text per path. */
type PathCache = Map<string, ReturnType<typeof checkPath>>;

/** Verifies one producer call's output (K02 R[0], R[3]): kinds, storable text, sizes, fragments in their sources, paths. */
function verifyOutput(context: KnowledgeContext, producer: string, output: ProducerOutput, sources: FragmentSources, loader: SourceLoader, paths: PathCache): Verified {
  const out: Verified = { grammar:output.grammar, inventory:[],inventoryError:null,placed: [], toPlace: [], refused: [], refusedCount: 0, refusedKinds: new Map(), warnings: output.warnings, entries: output.entries.length, spans: (output.unplaced ?? []).length };
  for(const row of output.inventory??[]){
    const listed=verifyFragment(row.listed,sources,loader),complete=verifyFragment(row.complete,sources,loader);
    if(!listed.ok||!complete.ok||listed.value.sha256!==complete.value.sha256||row.selected!==0||(sources.list?.elements.size??0)!==0){out.inventoryError='空范围的清单来源或选中数不符；下一步核对生产器清单证明后重产';continue;}
    const source=sources.single.get(listed.value.slot);
    try{
      if(!source||row.listed.parser!=='json@1'||row.complete.parser!=='json@1')throw Error('invalid inventory');
      const items=JSON.parse(source.document.locate(row.listed.selector)!.text),done=JSON.parse(source.document.locate(row.complete.selector)!.text);
      if(!Array.isArray(items)||done!==true)throw Error('incomplete inventory');
      out.inventory.push({producer,label:row.label,listed:listed.value.reference,completion:complete.value.reference,total:items.length,selected:0});
    }catch{out.inventoryError='空范围缺少完整清单数组及完成标记；下一步重读完整来源清单后重产';}
  }
  const refuse = (item: RefusedEntry): void => {
    out.refusedCount++;
    out.refusedKinds.set(item.kind, (out.refusedKinds.get(item.kind) ?? 0) + 1);
    out.refused.push(item);
  };
  const collect = (
    entry: { kind: string; statement: string; data: Record<string, unknown>; applicability: EntryContent['applicability'] },
    fragments: ProducerOutput['entries'][number]['fragments'],
    index: number,
    unplaced: boolean,
  ): Collected | string => {
    // K02 R[3]: only the kinds of the entry_kind axis.
    if (!isEntryKind(entry.kind)) return `种类“${cutText(entry.kind, 80)}”不是知识条目种类（${ENTRY_KINDS_TEXT}）`;
    let content: EntryContent;
    let digest: string;
    try {
      // Canonical JSON refuses what cannot be stored (a lone surrogate in any text, a number that is not finite).
      content = entryContentOf(entry);
      digest = entryDigest(content);
    } catch (error) {
      return `条目内容不能按规范 JSON 保存：${describeError(error)}`;
    }
    const statementBytes = Buffer.byteLength(content.statement, 'utf8');
    if (statementBytes > context.limits.maxStatementBytes) return `陈述超过 ${context.limits.maxStatementBytes} 字节`;
    const dataBytes = canonicalSize(content.data);
    if (dataBytes > context.limits.maxDataBytes) return `结构化数据超过 ${context.limits.maxDataBytes} 字节`;
    const references: string[] = [];
    const applicabilitySources:NonNullable<CompositionRow['applicability_sources']>=[];
    const slotNames: string[] = [];
    for (const fragment of fragments) {
      const verified = verifyFragment(fragment, sources, loader);
      if (!verified.ok) return verified.reason;
      if (!references.includes(verified.value.reference)) references.push(verified.value.reference);
      for(const origin of fragment.applicability??[])applicabilitySources.push({...origin,fragment:verified.value.reference});
      slotNames.push(verified.value.slot);
    }
    const bytes = statementBytes + dataBytes + references.reduce((sum, r) => sum + r.length, 0) + canonicalSize(applicabilitySources) + 400;
    return { content: { ...content, kind: entry.kind }, digest, producer, index, unplaced, fragments: references, ...(applicabilitySources.length?{applicability_sources:applicabilitySources}:{}), slots: slotNames, bytes };
  };
  output.entries.forEach((entry, index) => {
    let at: { segments: string[]; path: string } | null = null;
    if (entry.path !== null) {
      let path = paths.get(entry.path);
      if (path === undefined) {
        path = checkPath(entry.path);
        paths.set(entry.path, path);
      }
      if (!path.ok) {
        refuse({ producer, index, unplaced: false, kind: entry.kind, path: entry.path, reason: path.reason });
        return;
      }
      at = path.value;
    }
    const collected = collect(entry, entry.fragments, index, false);
    if (typeof collected === 'string') {
      refuse({ producer, index, unplaced: false, kind: entry.kind, path: entry.path, reason: collected });
      return;
    }
    if (at === null) out.toPlace.push({ ...collected, section: '' });
    else out.placed.push({ ...collected, segments: at.segments, path: at.path });
  });
  (output.unplaced ?? []).forEach((span, index) => {
    const collected = collect({ kind: span.kind, statement: span.text, data: { section: span.section }, applicability: null }, [span.fragment], index, true);
    if (typeof collected === 'string') {
      refuse({ producer, index, unplaced: true, kind: span.kind, path: null, reason: collected });
      return;
    }
    out.toPlace.push({ ...collected, section: span.section });
  });
  return out;
}

/** Root rows of a list slot's elements, by the list's order. */
function sourceRowOf(producer: string, slot: string, source: ParsedSource, basis: CompositionBasis, decidedBy: string): RootSource {
  return {
    producer,
    slot,
    external: source.external,
    revision: source.revision,
    sha256: source.sha256,
    size: source.size,
    media_type: source.mediaType,
    parser: source.parser,
    artifact: source.artifact.digest,
    read_tier: source.readTier,
    basis,
    decided_by: decidedBy,
  };
}

const listDigest = (value: unknown): string => sha256Hex(canonicalize(value));

/**
 * Keeps the ids of each list role as an object (their canonical JSON array, named by the digest the recorded build cites).
 * Best effort: the digest is recorded either way; a list that could not be kept is a warning.
 */
async function keepLists(context: KnowledgeContext, lists: readonly ListedIds[], problems: Problems): Promise<void> {
  for (const list of lists) {
    try {
      const stored = await context.records.objects.put(canonicalBytes(list.ids), 'application/json');
      if (stored.sha256 !== list.list) problems.warn(`列表 ${list.role} 存下的对象 ${stored.sha256} 与它的摘要 ${list.list} 不符`);
    } catch (error) {
      problems.warn(`列表 ${list.role} 的 ${list.ids.length} 个外部标识没能存成对象（${describeError(error)}）；组成记录里只有它的摘要`);
    }
  }
}

export async function produceTree(context: KnowledgeContext, input: ProduceInput): Promise<ProduceResult> {
  const startedAt = context.now().toISOString();
  let { product } = input;
  const build = input.build !== null && input.sources !== undefined ? { ...input.build, sources: { ...input.build.sources, ...input.sources } } : input.build;
  const wholeList = input.sources !== undefined;
  const by = await requireAdmin(context, input.by, '生产知识树');
  const pack = { id: product.id, version: product.version, digest: product.digest };
  const decidedBy = `${product.id}@${product.version}`;
  const lineProduct = product.product.id;
  const sync = input.sync ?? null;
  const problems = new Problems();
  const usedSources: ProduceDetail['sources'] = [];
  const missing: ProduceDetail['missing'] = [];
  const sourceFailures:SourceObservation[]=[];
  const lists: ListDetail[] = [];
  const totals: CallTotals = { made: 0, reused: 0, timeouts: 0, warnings: [] };
  const inventory:NonNullable<TreeRootBody['empty_scope']>['sources']=[];
  const inventoryErrors:string[]=[];
  let listLoader: ListLoader | null = null;
  const result = (partial: Partial<ProduceResult>): ProduceResult => ({
    ok: false,
    build: build?.name ?? null,
    root: null,
    composition: null,
    action: null,
    reason: null,
    sources: usedSources,
    nodes: 0,
    created: 0,
    entries: 0,
    entryCounts: { total: 0, placed: 0, unplaced: 0 },
    placedByModel: 0,
    unplaced: 0,
    refused: problems.refused,
    refusedCount: problems.refusedCount,
    skipped: problems.skipped,
    skippedCount: problems.skippedCount,
    sourceFailures,
    calls: { made: totals.made, reused: totals.reused },
    loads: { reused: listLoader?.reused ?? 0, read: listLoader?.read ?? 0 },
    parts: 0,
    warnings: problems.warnings,
    ...partial,
  });

  if(input.variables===undefined){
    const resolved=await resolveProductVariables(product,context.records.variables,by,false,{plan:context.sandbox.plan,producer:context.sandbox.producer});
    if('problems' in resolved)return result({reason:resolved.problems.join('；')});
    product=resolved.product;
    input={...input,product,variables:resolved.uses,loader:input.loader??knowledgeSourceLoader(context,by,'knowledge production',resolved.snapshot)};
  }
  const productionUses=productionVariableUses(product,build===null,input.variables??[]),domainNames=new Set(Object.values(product.product.applicability?.closed_sets??{}));
  input={...input,variables:(input.variables??[]).filter(use=>domainNames.has(use.name)||productionUses.includes(use))};
  product = { ...product, product: { ...product.product, producers: product.product.producers.filter(p => (p.unversioned === true) === (build === null) && (input.producers === undefined || input.producers.includes(p.id))) } };
  product.product.catalogs = product.product.catalogs.filter(catalog => catalog.producer === undefined || product.product.producers.some(producer => producer.id === catalog.producer));
  // The build's own identity goes into every record of the production, the failure included: it is checked first.
  // infoOf deliberately strips the KnownBuild root before validation.
  let info: BuildInfo | null = null;
  if (build !== null) {
    try { info = infoOf(build); } catch { return result({ reason: '构建信息不符合 build-info@1，没有生产，也没有记录' }); }
  }
  if (info !== null) {
    const unrecordable = buildProblem(lineProduct, info);
    if (unrecordable !== null) return result({ reason: `${unrecordable}；没有生产，也没有记录` });
  }
  const recorded = info === null ? { build: null, lists: [] } : recordedOf(info);
  let listsKept = false;
  const keep = async (): Promise<void> => {
    if (listsKept) return;
    listsKept = true;
    await keepLists(context, recorded.lists, problems);
    await problems.persist(context,usedSources.map(source=>`src:${source.sha256}`));
  };
  // What every producer receives: the build as listed, without a root (the root is what this production makes; the previous
  // root would make a producer's output, and so this root, depend on what was produced before, K01 R[1]).
  const handed = info === null ? null : { ...info, root: null };
  // The frozen known-build inventory is a declared input, never accumulated database state: producers hash it into
  // their applicability criteria digest, so a build record this very production writes must not change it (K01 R[1],
  // same sources give the same bytes, and two builds of one plan share their manual subtree). The sync passes the
  // plan's build names; a production without a plan knows only the build it is producing.
  const planNames = input.planBuilds === undefined
    ? (info === null ? [] : [info.name])
    : [...new Set([...input.planBuilds, ...(info === null ? [] : [info.name])])].sort(compareText);
  if (planNames.length > 50000) return result({ reason: '已知构建清单超过有界输入上限；下一步包维护者扩展分片清单合约后重产' });
  const ZERO = '0'.repeat(64);
  const buildNameInventory = new Map<string, string>();
  for (const name of planNames) buildNameInventory.set(name, ZERO);
  context = { ...context, knownBuildInventory: [...buildNameInventory].sort(([a], [b]) => compareText(a, b)).map(([name]) => ({ name, record: ZERO })) };
  const applicabilityClosedSets:Record<string,string[]>={};
  for(const [field,name]of Object.entries(product.product.applicability?.closed_sets??{})){
    const uses=(input.variables??[]).filter(use=>use.name===name);if(!uses.length)continue;
    try{const value=await context.records.variables?.valueAt(name,uses[0].decision);if(Array.isArray(value)&&value.every(v=>typeof v==='string'))applicabilityClosedSets[field]=[...value];}catch{return result({reason:'缺冻结适用条件变量 '+name+'；下一步管理员恢复该版本变量后重产'});}
  }
  const handedDigest = sha256Hex(canonicalize({build:handed,known_builds:context.knownBuildInventory!.map(v=>v.name)}));

  const fail = async (reason: string): Promise<ProduceResult> => {
    const text = cutText(reason, MAX_REASON_TEXT);
    await keep();
    const action = await writeProduceAction(
      context,
      { startedAt, sync, product: lineProduct, pack, build: recorded.build, root: null, composition: null, sources: usedSources, missing, lists, listing_digest:input.listingDigest, source_failures:sourceFailures, problem_chunks:problems.chunks, calls: totals, placement: null, reason: text },
      null,
    );
    return result({ reason: text, action });
  };

  const configured=product.product.links===undefined?undefined:LinkDeclaration.array().max(32).safeParse(product.product.links);
  if(configured&&!configured.success)return fail('产品链接声明无效，修正声明后重新生产');
  const links=configured?.success?configured.data:[];
  if(links?.some(rule=>[...(rule.source_producers??[]),...(rule.target_producers??[])].some(id=>!input.product.product.producers.some(producer=>producer.id===id))))return fail('产品链接声明引用了不存在的生产器，修正声明后重新生产');
  if(links&&new Set(links.map(rule=>rule.id)).size!==links.length)return fail('产品链接声明编号重复，修正后重新生产');

  if (build !== null && build.base !== build.name) return fail(`构建 ${build?.name ?? '不分版本'} 是 ${build.base} 的别名，没有自己的树`);
  if (product.product.producers.length === 0) return fail(input.product.product.producers.length === 0 ? '产品包没有声明生产器' : build === null ? '产品包没有为不分版本范围声明生产器；请产品包作者声明 unversioned 生产器后重试同步' : '产品包没有为构建范围声明生产器；请产品包作者声明构建生产器后重试同步');
  const loader = input.loader ?? knowledgeSourceLoader(context,by,'knowledge sync');
  const cap = context.limits.maxBuildBytes;
  listLoader = new ListLoader(context, loader, {
    maxAgeSeconds: input.maxAgeSeconds ?? context.limits.listMaxAgeSeconds,
    concurrency: input.readConcurrency ?? context.limits.listReadConcurrency,
    refresh:input.refreshSources,
  });

  const planned = plannedSources(product, info, input.scope);
  for (const producer of product.product.producers) {
    const many = planned.filter((s) => s.producer === producer.id && s.many);
    if (many.length > 1) return fail(`生产器 ${producer.id} 声明了 ${many.length} 个列表输入（${many.map((s) => s.slot).join('、')}），一个生产器最多一个`);
  }

  // Single sources: read, check and parse every declared one once.
  const parsed = new Map<string, ParsedSource>();
  const charged = new Set<string>();
  const slotsOf = new Map<string, Map<string, ParsedSource | null>>();
  const sourceRows: RootSource[] = [];
  const listRows: RootSource[] = [];
  let bytes = 0;
  for (const source of planned) {
    if (input.signal?.aborted) return fail('同步被中止');
    if (source.many) {
      if (source.list === null && !source.optional) return fail(`${source.producer}.${source.slot}：${source.problem}`);
      continue;
    }
    const slots = slotsOf.get(source.producer) ?? new Map<string, ParsedSource | null>();
    slotsOf.set(source.producer, slots);
    if (source.external === null) {
      if (source.optional) {
        problems.warn(`${source.producer}.${source.slot}：${source.problem}（可选，跳过）`);
        slots.set(source.slot, null);
        missing.push({ producer: source.producer, slot: source.slot, external: null });
        continue;
      }
      return fail(`${source.producer}.${source.slot}：${source.problem}`);
    }
    const parseKey=JSON.stringify([source.external,source.parser??null]);
    let loaded = parsed.get(parseKey);
    if (loaded === undefined) {
      const read = await loader.read(source.external,source.slot);
      if (!read.ok) {
        if(read.observation){
          sourceFailures.push(read.observation);
          if(read.observation.code==='SOURCE_FORBIDDEN')await requestKnowledgeFact(context,{kind:'repair',subject:source.external,missing:'构建站明确拒绝访问（SOURCE_FORBIDDEN）',action:'联系此构建站负责人开放这个读取对象，再重新同步',inputs:[`rec:${read.observation.manifest}`]});
        }
        if (source.optional) {
          problems.warn(`${source.producer}.${source.slot}：${source.external} ${read.reason}（可选，跳过）`);
          slots.set(source.slot, null);
          missing.push({ producer: source.producer, slot: source.slot, external: source.external, ...(read.observation?{observation:read.observation,conclusion:`可选来源读取确定失败：${read.observation.code}，HTTP ${read.observation.status}，${read.observation.at}`}:{}) });
          continue;
        }
        return fail(`${source.producer}.${source.slot}：${source.external} ${read.reason}`);
      }
      const size = read.artifact.body.size;
      const charge=charged.has(source.external)?0:size;
      if (bytes + charge > cap) {
        return fail(`构建的来源合计超过每个构建 ${cap} 字节的上限：已读 ${bytes} 字节，源文件 ${read.artifact.body.sha256}（${source.external}）还有 ${size} 字节`);
      }
      const readable = await loader.readable(read, charged.has(source.external)?cap:cap - bytes,{slot:source.slot});
      if (!readable.ok) return fail(readable.reason);
      const parse = loader.parse(readable.value,source.parser);
      if (!parse.ok) return fail(parse.reason);
      loaded = parse.value;
      bytes += charge;
      charged.add(source.external);
      parsed.set(parseKey, loaded);
    }
    if(loaded.parseNote)problems.warn(`${source.producer}.${source.slot}：${loaded.parseNote}`);
    slots.set(source.slot, loaded);
    usedSources.push({ producer: source.producer, slot: source.slot, external: source.external, sha256: loaded.sha256 });
    sourceRows.push(sourceRowOf(source.producer, source.slot, loaded, source.basis, decidedBy));
  }
  const basisOf = new Map<string, CompositionBasis>();
  for (const source of planned) if (source.external !== null || source.many) basisOf.set(`${source.producer}\u0000${source.slot}`, source.basis);

  // Producers: a single call, or one call per batch of the list slot.
  const producerPlacement = new Map<string, string>();
  for (const producer of product.product.producers) {
    producerPlacement.set(producer.id, producer.placement ?? 'code_only');
  }
  const placedEntries: Array<Collected & { segments: string[]; path: string }> = [];
  const toPlace: Array<Collected & { section: string }> = [];
  const directUnplaced: Array<Collected & { section: string }> = [];
  const skippedPlacement = new Map<string, number>();
  const contents = new Map<string, EntryContent>();
  const pathCache: PathCache = new Map();
  const incompleteGrammars = new Set<string>();
  // The verified items themselves are kept (their indices moved to the concatenated output), never copied.
  const take = (producer: string, verified: Verified, offsets: { entries: number; spans: number }): void => {
    if(verified.grammar?.complete===false)incompleteGrammars.add(producer);

    inventory.push(...verified.inventory);
    if(verified.inventoryError)inventoryErrors.push(verified.inventoryError);
    for (const warning of verified.warnings) problems.warn(`${producer}：${warning}`);
    for (const item of verified.refused) problems.keep({ ...item, index: item.index + (item.unplaced ? offsets.spans : offsets.entries) });
    for (const [kind, count] of verified.refusedKinds) problems.countRefusal(producer, kind, count);
    for (const entry of verified.placed) {
      contents.set(entry.digest, entry.content);
      entry.index += offsets.entries;
      placedEntries.push(entry);
    }
    const allows = producerPlacement.get(producer) === 'judgment_allowed';
    for (const entry of verified.toPlace) {
      contents.set(entry.digest, entry.content);
      entry.index += entry.unplaced ? offsets.spans : offsets.entries;
      if (allows) {
        toPlace.push(entry);
      } else {
        directUnplaced.push(entry);
        skippedPlacement.set(producer, (skippedPlacement.get(producer) ?? 0) + 1);
      }
    }
    offsets.entries += verified.entries;
    offsets.spans += verified.spans;
  };
  for (const producer of product.product.producers) {
    if (input.signal?.aborted) return fail('同步被中止');
    const slots = slotsOf.get(producer.id) ?? new Map<string, ParsedSource | null>();
    const list = planned.find((s) => s.producer === producer.id && s.many);
    if (list === undefined) {
      const output = product.product.variables?.length
        ? await callSingleProducer(context,product,producer,handed,slots,totals)
        : await (async()=>{totals.made++;return runProducer(context, product, producer, { build: handed, slots, params: producer.params ?? {} });})();
      if (!output.ok) return fail(output.reason);
      take(producer.id, verifyOutput(context, producer.id, output.value, singleSources(slots), loader, pathCache), { entries: 0, spans: 0 });
      continue;
    }
    const outcome = await produceList(context, {
      product,
      producer,
      build: handed,
      buildDigest: handedDigest,
      slots,
      list: wholeList && list.list !== null ? { ...list, batch: Math.max(list.list.length, 1) } : list,
      whole: wholeList,
      cap,
      loader,
      listLoader,
      totals,
      problems,
      decidedBy,
      paths: pathCache,
      retrySkipped:input.retrySkipped,
      signal: input.signal,
    });
    if (!outcome.ok) return fail(outcome.reason);
    const offsets = { entries: 0, spans: 0 };
    for (const verified of outcome.verified) take(producer.id, verified, offsets);
    listRows.push(...outcome.rows);
    lists.push(outcome.detail);
  }
  for (const warning of totals.warnings) problems.warn(warning);
  const empty=placedEntries.length===0&&toPlace.length===0&&directUnplaced.length===0;
  const emptyScope:TreeRootBody['empty_scope']=empty&&build===null&&problems.refusedCount===0&&problems.skippedCount===0&&!missing.some(source=>source.external!==null)&&inventoryErrors.length===0&&product.product.producers.every(producer=>inventory.some(row=>row.producer===producer.id))?{complete:true,sources:inventory}:undefined;
  if (empty && !emptyScope) {
    if(build===null&&problems.refusedCount===0)return fail(inventoryErrors[0]??(problems.skippedCount>0?`空范围仍略去 ${problems.skippedCount} 份来源；下一步补齐来源后重产`:missing.some(source=>source.external!==null)?'空范围仍有来源读取失败；下一步恢复读取后重产':'空范围缺少清单完整且选中 0 份的逐生产器证明；下一步补齐清单证明后重产'));
    return fail(problems.refusedCount > 0 ? `生产器的 ${problems.refusedCount} 个条目都没有通过核对，没有可以挂树的内容` : '生产器没有产出任何条目');
  }

  // Code placement; the Hub calls no model, so what code cannot place stays unplaced at the root (a producer may
  // declare it for the bot's placement proposals). A node holds at most maxNodeEntries entries.
  const builder = new TreeBuilder(context.limits.maxNodeEntries);
  const full = (entry: Collected, path: string): void => {
    problems.refuse({ producer: entry.producer, index: entry.index, unplaced: entry.unplaced, kind: entry.content.kind, path, reason: `节点 ${cutText(path, 200)} 已有 ${context.limits.maxNodeEntries} 个条目，达到每个节点的上限` });
  };
  const hung: Array<Collected & { segments: string[]; path: string }> = [];
  for (const entry of placedEntries) {
    if (builder.add(entry.segments, entry.digest)) hung.push(entry);
    else full(entry, entry.path);
  }
  placedEntries.length = 0;
  pathCache.clear();
  const spans: PlacementSpan[] = toPlace.map((entry) => ({ key: entry.digest, text: entry.content.statement, section: entry.section, fragment: entry.fragments[0] }));
  let outcomes = new Map<string, PlacementOutcome>();
  let placement: ProduceDetail['placement'] = null;
  const skippedRecord = skippedPlacement.size > 0 ? Object.fromEntries(skippedPlacement) : undefined;
  const model = context.placer.model;
  if (spans.length > 0 && model !== null) {
    const threshold = await context.calibration.threshold(PLACEMENT_CHAIN, model);
    outcomes = await context.placer.place(spans, placementTree(builder, contents), { threshold, context: { product: lineProduct, build: build?.name ?? '未声明' }, onProblem: (text) => problems.warn(`归类：${text}`) });
    // Recorded so that a later sync places again when the judge failed or the chain's calibration changed.
    placement = {
      model,
      threshold,
      spans: outcomes.size,
      failed: [...outcomes.values()].filter((o) => o.failed).length,
      ...(skippedRecord !== undefined ? { skipped: skippedRecord } : {}),
    };
  } else if (spans.length > 0 || skippedRecord !== undefined) {
    // No placer (the Hub calls no model): nobody judges the declared spans; spans counts judged spans only.
    placement = {
      model: null,
      threshold: null,
      spans: 0,
      failed: 0,
      ...(skippedRecord !== undefined ? { skipped: skippedRecord } : {}),
    };
  }
  const modelHung = new Set<Collected>();
  for (const entry of toPlace) {
    const outcome = outcomes.get(entry.digest);
    if (outcome === undefined || !outcome.placed) continue;
    if (builder.add(outcome.segments, entry.digest)) modelHung.add(entry);
    else full(entry, pathOf(outcome.segments));
  }

  const root = builder.build();
  const nodes = flatten(root);

  // Composition rows: one per (path, entry), producers and fragments merged in order, the basis over every slot.
  const rows = new Map<string, Map<string, { row: CompositionRow; producers: Set<string>; slots: Set<string> }>>();
  /** Placed identities only: byte estimates for row parts, also reused as the report’s placed identity index. */
  const entryBytes = new Map<string, number>();
  const addRow = (path: string, entry: Collected, placed: PlacementOutcome | undefined): void => {
    let atPath = rows.get(path);
    if (atPath === undefined) {
      atPath = new Map();
      rows.set(path, atPath);
    }
    let held = atPath.get(entry.digest);
    if (held === undefined) {
      const row: CompositionRow = { path, entry: entry.digest, kind: entry.content.kind, producers: [], fragments: [], basis: 'declared', decided_by: decidedBy };
      if (placed !== undefined && placed.model !== null && placed.p !== null && placed.threshold !== null) {
        row.placement = { model: placed.model, p: placed.p, threshold: placed.threshold, judgments: placed.judgments, note: cutText(placed.note, MAX_PROBLEM_TEXT) };
      }
      held = { row, producers: new Set(), slots: new Set() };
      atPath.set(entry.digest, held);
      if (!entryBytes.has(entry.digest)) entryBytes.set(entry.digest, entry.bytes);
    }
    held.producers.add(entry.producer);
    for (const slot of entry.slots) held.slots.add(`${entry.producer}\u0000${slot}`);
    for (const fragment of entry.fragments) if (!held.row.fragments.includes(fragment)) held.row.fragments.push(fragment);
    for(const origin of entry.applicability_sources??[]){held.row.applicability_sources??=[];if(!held.row.applicability_sources.some(existing=>canonicalize(existing)===canonicalize(origin)))held.row.applicability_sources.push(origin);}
  };
  for (const entry of hung) addRow(entry.path, entry, undefined);
  hung.length = 0;
  for (const entry of modelHung) {
    const outcome = outcomes.get(entry.digest) as PlacementOutcome;
    addRow(pathOf(outcome.segments), entry, outcome);
  }
  // The rows are finished in place: producers sorted, the basis decided over every slot their fragments are in.
  const composition: CompositionRow[] = [];
  for (const atPath of rows.values()) {
    for (const { row, producers, slots } of atPath.values()) {
      row.producers = [...producers].sort(compareText);
      row.basis = basisOver(slots, basisOf);
      composition.push(row);
    }
  }
  rows.clear();
  composition.sort((a, b) => compareText(a.path, b.path) || compareText(a.entry, b.entry));

  // Spans no rule and no calibrated judgment placed: one row per content, every fragment and producer kept.
  const lost = new Map<string, { row: UnplacedRow; producers: Set<string>; slots: Set<string> }>();
  for (const entry of toPlace) {
    const outcome = outcomes.get(entry.digest);
    if (outcome !== undefined && outcome.placed) continue;
    let held = lost.get(entry.digest);
    if (held === undefined) {
      held = {
        row: {
          entry: entry.digest,
          kind: entry.content.kind,
          producers: [],
          section: cutText(entry.section, MAX_PROBLEM_TEXT),
          fragments: [],
          basis: 'declared',
          decided_by: decidedBy,
          stopped_at: pathOf(outcome?.segments ?? []),
          candidate:
            outcome?.candidate === null || outcome?.candidate === undefined
              ? null
              : { path: pathOf(outcome.candidate.segments), model: outcome.model, p: outcome.candidate.p, calibrated: outcome.calibrated },
          judgments: outcome?.judgments ?? [],
          note: cutText(outcome?.note ?? '未归位，留在根下', MAX_PROBLEM_TEXT),
        },
        producers: new Set(),
        slots: new Set(),
      };
      lost.set(entry.digest, held);
    }
    held.producers.add(entry.producer);
    for (const slot of entry.slots) held.slots.add(`${entry.producer}\u0000${slot}`);
    for (const fragment of entry.fragments) if (!held.row.fragments.includes(fragment)) held.row.fragments.push(fragment);
    for(const origin of entry.applicability_sources??[]){held.row.applicability_sources??=[];if(!held.row.applicability_sources.some(existing=>canonicalize(existing)===canonicalize(origin)))held.row.applicability_sources.push(origin);}
  }
  for (const entry of directUnplaced) {
    let held = lost.get(entry.digest);
    if (held === undefined) {
      held = {
        row: {
          entry: entry.digest,
          kind: entry.content.kind,
          producers: [],
          section: cutText(entry.section, MAX_PROBLEM_TEXT),
          fragments: [],
          basis: 'declared',
          decided_by: decidedBy,
          stopped_at: '/',
          candidate: null,
          judgments: [],
          note: '生产器未声明交给 bot 归位，留在根下标为未归位',
        },
        producers: new Set(),
        slots: new Set(),
      };
      lost.set(entry.digest, held);
    }
    held.producers.add(entry.producer);
    for (const slot of entry.slots) held.slots.add(`${entry.producer}\u0000${slot}`);
    for (const fragment of entry.fragments) if (!held.row.fragments.includes(fragment)) held.row.fragments.push(fragment);
    for(const origin of entry.applicability_sources??[]){held.row.applicability_sources??=[];if(!held.row.applicability_sources.some(existing=>canonicalize(existing)===canonicalize(origin)))held.row.applicability_sources.push(origin);}
  }
  const unplacedRows = [...lost.values()]
    .map(({ row, producers, slots }) => ({ ...row, producers: [...producers].sort(compareText), basis: basisOver(slots, basisOf) }))
    .sort((a, b) => compareText(a.entry, b.entry));

  if(links.length>0){
    try {
      const ownership=new Map(composition.map(row=>[row.path+"\0"+row.entry,row.producers]));
      const kinds=new Map(nodes.map(node=>[node.path,relationNode(node.entries.map(id=>({kind:contents.get(id)!.kind,producers:ownership.get(node.path+"\0"+id)??[]})))]));
      const sources=[...composition.map(row=>({path:row.path,entry:row.entry,content:contents.get(row.entry)!,producers:row.producers})),...unplacedRows.map(row=>({path:'/',entry:row.entry,content:contents.get(row.entry)!,producers:row.producers,unplaced:true}))];
      const facts=relationFacts(root.digest,links,kinds,sources);
      for(const diagnostic of facts.rule_diagnostics)problems.warn(diagnostic.message+'；待核对候选字面 '+diagnostic.unchecked_literals+' 个；下一步：'+diagnostic.next_action);
      for(const diagnostic of facts.diagnostics)problems.warn(diagnostic.message+"；"+diagnostic.reference+"；下一步："+diagnostic.next_action);
      for(const rule of links){const groups=facts.drift.filter(group=>group.rule===rule.id);if(groups.length)problems.warn(`链接声明 ${rule.id}：有 ${groups.length} 个字面在此根没有可匹配目标（漂移事实）：${literalWarningDetails(groups.map(g=>g.literal))}`);}
    }catch(error){return fail(`链接声明无法核对：${describeError(error)}`);}
  }

  const catalogs = rootCatalogs(product, composition, unplacedRows, problems.refusedOf, problems.skippedOf, contents, incompleteGrammars);
  const kinds = Object.fromEntries(ENTRY_KIND.map((kind) => [kind, 0])) as Record<EntryKind, number>;
  for (const row of composition) kinds[row.kind]++;

  // A large composition goes into parts; a small one stays in its record.
  const inline = context.limits.inlineRows;
  const parted = composition.length > inline || unplacedRows.length > inline || listRows.length > inline;

  if (input.signal?.aborted) return fail('同步被中止');
  await keep();
  let written: { created: number; composition: string; action: string; body: TreeRootBody; parts: number };
  try {
    written = await context.writes.run(() =>
      writeRoot(context, {
        product: lineProduct,
        root,
        contents,
        unplacedRows,
        parts: parted ? { composition, unplaced: unplacedRows, sources: listRows, entryBytes } : null,
        body: (parts) => ({
          variables:input.variables??[],
          ...(product.product.command_policy?{command_policy:product.product.command_policy}:{}),
          known_builds:[...(context.knownBuildInventory??[])],
          ...(product.product.applicability?{applicability_context:{grammar:product.product.applicability.grammar,closed_sets:applicabilityClosedSets}}:{}),
          product: lineProduct,
          version: info === null ? null : { line: info.line, build: info.name, family: info.family, platform: info.platform },
          build: recorded.build,
          root: root.digest,
          producer: {
            pack: product.id,
            version: product.version,
            digest: product.digest,
            id: decidedBy,
            producers: product.product.producers.map((p: Producer) => ({ id: p.id, function: p.function })),
          },
          sources: parted ? sourceRows : [...sourceRows, ...listRows],
          composition: parted ? [] : composition,
          unplaced: parted ? [] : unplacedRows,
          ...(parts === null ? {} : { parts }),
          refused: problems.refused,
          refused_count: problems.refusedCount,
          ...(lists.length > 0 ? { skipped: problems.skipped, skipped_count: problems.skippedCount } : {}),
          catalogs,
          links,
          counts: { nodes: nodes.length, entries: composition.length, placed_by_model: composition.filter((row) => row.placement !== undefined).length, unplaced: unplacedRows.length },
          kinds,
          warnings: problems.warnings,
          warnings_count: problems.warningsCount,
          ...(emptyScope?{empty_scope:emptyScope}:{}),
          produced_at: context.now().toISOString(),
        }),
        action: async (record, tx) => {
          const action = await writeProduceAction(
            context,
            { startedAt, sync, product: lineProduct, pack, build: recorded.build, root: root.digest, composition: record, sources: usedSources, missing, lists, listing_digest:input.listingDigest, source_failures:sourceFailures, problem_chunks:problems.chunks, calls: totals, placement, reason: null },
            tx,
          );
          // A build produced without a build record (not by a sync) gets one, so that builds are known from their records alone.
          if (info !== null) {
          const named = await context.store.buildsNamed(lineProduct, info.name, tx);
          if (!named.some((b) => b.body.build.name === info.name)) {
            const roles = listRoles(info);
            await context.store.putBuild({ product: lineProduct, build: withoutLists(info), ...(roles.length > 0 ? { lists: roles } : {}), pack, plan: null, sync }, tx);
          }
          }
          return action;
        },
      }),
    );
  } catch (error) {
    return fail(`写入知识树时出错：${describeError(error)}`);
  }
  return result({
    ok: true,
    root: root.digest,
    ...(emptyScope?{reason:emptyScopeNote(emptyScope)}:{}),
    composition: written.composition,
    action: written.action,
    nodes: nodes.length,
    created: written.created,
    entries: composition.length,
    entryCounts: countEntryPositions(entryBytes, lost),
    placedByModel: written.body.counts.placed_by_model,
    unplaced: unplacedRows.length,
    parts: written.parts,
    ...(skippedRecord !== undefined ? { placementSkipped: skippedRecord } : {}),
  });
}

interface ListInput {
  product: ProductHandle;
  producer: Producer;
  /** The build as the function receives it, and its digest (part of every memo key). */
  build: KnownBuild | null;
  buildDigest: string;
  slots: ReadonlyMap<string, ParsedSource | null>;
  list: PlannedSource;
  /** The list is one call. A missing element fails the production; the call is not cut by batch size or byte cap. */
  whole?: boolean;
  cap: number;
  loader: SourceLoader;
  listLoader: ListLoader;
  totals: CallTotals;
  problems: Problems;
  decidedBy: string;
  paths: PathCache;
  retrySkipped?:boolean;
  signal?: AbortSignal;
}

type ListOutcome = { ok: true; verified: Verified[]; rows: RootSource[]; detail: ListDetail } | { ok: false; reason: string };

/** Why a listed document was not used: it could not be read, or checked and parsed, it is over the byte cap alone, or the producer fails on it alone. */
type SkipCause = 'read' | 'check' | 'size' | 'producer';

/** Consecutive runs of the elements whose sizes together stay within `cap` (an element over it alone is a run of its own). */
function withinCap(elements: readonly ParsedSource[], cap: number): ParsedSource[][] {
  const out: ParsedSource[][] = [];
  let run: ParsedSource[] = [];
  let bytes = 0;
  for (const element of elements) {
    if (run.length > 0 && bytes + element.size > cap) {
      out.push(run);
      run = [];
      bytes = 0;
    }
    run.push(element);
    bytes += element.size;
  }
  if (run.length > 0) out.push(run);
  return out;
}

/**
 * One producer with a list slot: the listed objects in batches of the declared size. A batch is read first (records and
 * sizes, no bytes), cut into consecutive calls of at most `cap` bytes of documents, and each call's documents are fetched,
 * checked and parsed only when its turn comes; a call is memoized, split to isolate a document it fails on (README decision
 * 19) and verified while its documents are parsed. The verified outputs come back in batch order and element order. A
 * document that cannot be used is skipped and listed; the production fails instead when the producer is not shown to work
 * on documents, when every document of a batch fails alone, or when more than `maxSkippedShare` of a required list is
 * skipped. An optional list (the case index) uses a share of 1, so skipped documents are reported and do not drop the root.
 */
async function produceList(context: KnowledgeContext, input: ListInput): Promise<ListOutcome> {
  const { producer, list, problems, cap } = input;
  const { ids, repeats } = uniqueList(list.list ?? []);
  if (list.list === null) problems.warn(`${producer.id}.${list.slot}：${list.problem}（可选，按空列表生产）`);
  if (repeats > 0) problems.warn(`${producer.id}.${list.slot}：列表里有 ${repeats} 个重复的外部对象，各只读一次`);
  const batches = listBatches(ids, list.batch);
  const state: ListState = { succeeded: false, isolationCalls: 0, isolationBudget: context.limits.isolationCallsPerBatch * (batches.length + ISOLATION_BASE_BATCHES), failure: null };
  const ctx: ListCallContext = { context, product: input.product, producer, build: input.build, buildDigest: input.buildDigest, slots: input.slots, list: list.slot, totals: input.totals, state, retryFailures:input.retrySkipped };
  const probe = emptyProbe(ctx);
  type Skip = { external: string; reason: string; retry: boolean; reason_code?:Reason; cause: SkipCause };
  const skippedHere: Array<Omit<Skip, 'cause'>> = [];
  const causes = new Map<SkipCause, number>();
  let skippedCount = 0;
  let failedAlone = 0;
  const skip = (item: Skip): void => {
    skippedCount++;
    causes.set(item.cause, (causes.get(item.cause) ?? 0) + 1);
    if (item.cause === 'producer') failedAlone++;
    if (skippedHere.length < MAX_KEPT_SKIPPED_IDS) skippedHere.push({ external: item.external, reason: cutText(item.reason, MAX_PROBLEM_TEXT), retry: item.retry, ...(item.reason_code?{reason_code:item.reason_code}:{}) });
    problems.skip({ producer: producer.id, slot: list.slot, external: item.external, reason: item.reason, retry:item.retry, reason_code:item.reason_code });
  };
  const stop = (reason: string): { ok: false; reason: string } => {
    state.failure ??= reason;
    return { ok: false, reason };
  };
  // A finished batch keeps no parsed document: only its verified entries, the source rows and the [id, digest] pairs.
  type BatchDone =
    | { ok: true; verified: Verified[]; rows: RootSource[]; pairs: Array<[string, string]>; read: Array<[string, string]>; skipped: Array<Skip & { position: number }> }
    | { ok: false; reason: string };
  const done = await mapLimited(batches, context.limits.batchConcurrency, async (batch): Promise<BatchDone> => {
    if (input.signal?.aborted) return { ok: false, reason: '同步被中止' };
    if (state.failure !== null) return { ok: false, reason: state.failure };
    const position = new Map(batch.externals.map((external, i) => [external, i]));
    const skipped: Array<Skip & { position: number }> = [];
    // The digest of every object read, by position: the one loaded when a stored read had to be read again.
    const readAt: Array<string | undefined> = [];
    // Records and sizes first: no bytes are fetched before the batch is cut into calls within the cap.
    const peeks = await Promise.all(batch.externals.map((external) => input.listLoader.peek(external,{slot:list.slot})));
    if (input.whole) {
      for (const peek of peeks) {
        if (!peek.ok) return { ok: false, reason: `${producer.id}.${list.slot}：${peek.external} ${peek.reason}` };
      }
      const total = peeks.reduce((sum, peek) => sum + (peek.ok ? peek.load.artifact.body.size : 0), 0);
      if (total > cap) return { ok: false, reason: `${producer.id}.${list.slot}：完整目录 ${peeks.length} 份共 ${total} 字节，超过每个构建 ${cap} 字节的上限，不拆批` };
    }
    const calls: Array<Array<Extract<ElementPeek, { ok: true }>>> = [];
    let current: Array<Extract<ElementPeek, { ok: true }>> = [];
    let bytes = 0;
    peeks.forEach((peek, i) => {
      if (!peek.ok) {
        skipped.push({ external: peek.external, reason: peek.reason, retry: true, cause: 'read', position: i });
        return;
      }
      const body = peek.load.artifact.body;
      readAt[i] = body.sha256;
      if (body.size > cap) {
        if(current.length>0)calls.push(current);current=[];bytes=0;
        calls.push([peek]);return;
      }
      if (current.length > 0 && bytes + body.size > cap) {
        calls.push(current);
        current = [];
        bytes = 0;
      }
      current.push(peek);
      bytes += body.size;
    });
    // An empty batch is still one call (an empty list runs the producer once).
    if (current.length > 0 || calls.length === 0) calls.push(current);
    const verified: Verified[] = [];
    const rows: RootSource[] = [];
    const pairs: Array<[string, string]> = [];
    let handed = 0;
    let failedHere = 0;
    for (const call of calls) {
      if (state.failure !== null) return { ok: false, reason: state.failure };
      // Only this call's documents are held: at most `cap` bytes of them per batch at a time.
      const loads = await Promise.all(call.map((peek) => input.listLoader.materialize(peek,Math.max(cap,Math.min(peek.load.artifact.body.size,context.sandbox.producer.inputBytes??128*1024*1024)),list.slot,list.parser)));
      const elements: ParsedSource[] = [];
      if (input.whole) {
        const failed = loads.find((load) => !load.ok);
        if (failed !== undefined && !failed.ok) {
          const at = loads.indexOf(failed);
          return { ok: false, reason: `${producer.id}.${list.slot}：${call[at].external} ${failed.reason}` };
        }
      }
      loads.forEach((load, k) => {
        const at = position.get(call[k].external) as number;
        if (load.ok) {
          if(load.value.parseNote)problems.warn(`${producer.id}.${list.slot}：${load.value.parseNote}`);
          elements.push(load.value);
          readAt[at] = load.value.sha256;
        } else skipped.push({ external: call[k].external, reason: load.reason, retry: true, cause: 'check', position: at });
      });
      // A stored read that failed its checks was read again and may have other bytes: the call is cut again by what loaded.
      for (const part of elements.length === 0 ? [[]] : withinCap(elements, cap)) {
        handed += part.length;
        const called = await callBatch(ctx, { index: batch.index, of: batch.of }, part, probe);
        if (!called.ok) return { ok: false, reason: `${producer.id} 第 ${batch.index + 1}/${batch.of} 批：${called.reason}` };
        const failed = new Set(called.failed.map((f) => f.element));
        failedHere += failed.size;
        // Producing again fails on these the same way while the pack and the document stay as they are: no retry.
        for (const item of called.failed) skipped.push({ external: item.element.external, reason: item.reason, retry: true, reason_code:item.reason_code, cause: 'producer', position: position.get(item.element.external) as number });
        // Verified now, while the call's documents are parsed; each call cites only its own elements.
        for (const { elements: own, output } of called.outputs) {
          const byDigest = new Map<string, ParsedSource>();
          for (const element of own) if (!byDigest.has(element.sha256)) byDigest.set(element.sha256, element);
          verified.push(verifyOutput(context, producer.id, output, { single: input.slots, list: { slot: list.slot, elements: byDigest } }, input.loader, input.paths));
        }
        for (const source of part) {
          if (failed.has(source)) continue;
          rows.push(sourceRowOf(producer.id, list.slot, source, list.basis, input.decidedBy));
          pairs.push([source.external, source.sha256]);
        }
      }
    }
    if (handed >= 2 && failedHere === handed) {
      return stop(`${producer.id} 第 ${batch.index + 1}/${batch.of} 批：${handed} 份源文件单独调用生产器都失败，是生产器本身的问题`);
    }
    skipped.sort((a, b) => a.position - b.position);
    const read = batch.externals.flatMap((external, i): Array<[string, string]> => (readAt[i] === undefined ? [] : [[external, readAt[i]]]));
    return { ok: true, verified, rows, pairs, read, skipped };
  });
  const verified: Verified[] = [];
  const rows: RootSource[] = [];
  const pairs: Array<[string, string]> = [];
  const read: Array<[string, string]> = [];
  for (const batch of done) {
    if (!batch.ok) return { ok: false, reason: state.failure ?? batch.reason };
    verified.push(...batch.verified);
    rows.push(...batch.rows);
    pairs.push(...batch.pairs);
    read.push(...batch.read);
    for (const item of batch.skipped) {
      skip(item);
      if(item.cause==='producer')await requestKnowledgeFact(context,{kind:'repair',attribution:'producer_error',reason:item.reason_code??'check_error',subject:`${input.product.id}@${input.product.version}/${producer.id}`,missing:`生产器处理单份来源失败（producer_error；${item.reason_code??'check_error'}）：${item.external}`,action:'联系该版本包作者核对这份来源，修复生产器并发布新版本后重新同步',inputs:[]});
    }
  }
  // A document is blamed only when the producer is shown to work on documents in this production.
  if (failedAlone > 0 && !state.succeeded) {
    return { ok: false, reason: `生产器 ${producer.id} 在这次生产里没有成功处理过任何一份列出的源文件（${failedAlone} 份单独调用都失败），是生产器本身的问题` };
  }
  const share = list.optional ? 1 : context.limits.maxSkippedShare;
  if (ids.length > 0 && skippedCount > share * ids.length) {
    const parts = (
      [
        ['read', '读不到'],
        ['check', '没有通过核对或解析不了'],
        ['size', '超过字节上限'],
        ['producer', '生产器处理不了'],
      ] as const
    )
      .filter(([cause]) => (causes.get(cause) ?? 0) > 0)
      .map(([cause, text]) => `${text} ${causes.get(cause)} 份`);
    return {
      ok: false,
      reason: `列表 ${producer.id}.${list.slot} 列出的 ${ids.length} 份源文件有 ${skippedCount} 份没有用上（${parts.join('、')}），超过 ${Math.round(share * 100)}%，这次不产出根`,
    };
  }
  return {
    ok: true,
    verified,
    rows,
    detail: {
      producer: producer.id,
      slot: list.slot,
      count: ids.length,
      externals: listDigest(ids),
      loaded: listDigest(pairs),
      read: listDigest(read),
      skipped: skippedHere,
      skipped_count: skippedCount,
    },
  };
}

interface WriteInput {
  product: string;
  root: BuiltNode;
  contents: Map<string, EntryContent>;
  unplacedRows: UnplacedRow[];
  /** The rows of a large composition, to be split into parts; null for one record. */
  parts: { composition: CompositionRow[]; unplaced: UnplacedRow[]; sources: RootSource[]; entryBytes: Map<string, number> } | null;
  body: (parts: CompositionParts | null) => TreeRootBody;
  action: (composition: string, tx: Transaction) => Promise<string>;
}

/**
 * Writes a produced root in bounded chunks: the missing entries, then the missing nodes from the leaves up (a node is stored
 * only after its whole subtree), then the parts of a large composition, then the composition record and the generate action
 * in one transaction. Stored nodes are never written again: their subtrees are shared.
 */
async function writeRoot(context: KnowledgeContext, input: WriteInput): Promise<{ created: number; composition: string; action: string; body: TreeRootBody; parts: number }> {
  const store = context.store;
  const { writeChunk, writeConcurrency } = context.limits;
  const inChunks = async <T>(items: readonly T[], size: number, write: (item: T, tx: Transaction) => Promise<unknown>): Promise<void> => {
    await mapLimited(chunks(items, size), writeConcurrency, (chunk) =>
      store.records.withTransaction(async (tx) => {
        for (const item of chunk) await write(item, tx);
      }),
    );
  };

  // Nodes not yet stored, level by level from the root; a stored node's subtree is complete and shared.
  const fresh = new Map<string, BuiltNode>();
  let level: BuiltNode[] = [input.root];
  while (level.length > 0) {
    const seen = new Set<string>();
    const unseen = level.filter((node) => !fresh.has(node.digest) && !seen.has(node.digest) && (seen.add(node.digest), true));
    const stored = await mapLimited(unseen, 8, (node) => store.hasNode(node.digest));
    const next: BuiltNode[] = [];
    unseen.forEach((node, i) => {
      if (stored[i]) return;
      fresh.set(node.digest, node);
      next.push(...node.built);
    });
    level = next;
  }

  // Entries of the new nodes and of the unplaced rows that are not yet stored for this product.
  const wanted = new Set<string>();
  for (const node of fresh.values()) for (const entry of node.entries) wanted.add(entry);
  for (const row of input.unplacedRows) wanted.add(row.entry);
  const candidates = [...wanted];
  const present = await mapLimited(candidates, 8, (entry) => store.hasEntryFor(input.product, entry));
  const absent = candidates.filter((_, i) => !present[i]);
  await inChunks(absent, writeChunk, (entry, tx) => store.putEntry(input.product, entry, input.contents.get(entry) as EntryContent, tx));

  // Nodes from the leaves up: every child of a node is stored before the node.
  const byHeight = new Map<number, BuiltNode[]>();
  for (const node of fresh.values()) {
    const at = byHeight.get(node.height);
    if (at === undefined) byHeight.set(node.height, [node]);
    else at.push(node);
  }
  for (const height of [...byHeight.keys()].sort((a, b) => a - b)) await inChunks(byHeight.get(height) as BuiltNode[], writeChunk, (node, tx) => store.putNode(node, tx));

  // Parts of a large composition: content-addressed, so unchanged parts are found instead of written.
  let parts: CompositionParts | null = null;
  let partCount = 0;
  if (input.parts !== null) {
    const { composition, unplaced, sources, entryBytes } = input.parts;
    const contentRow = (row: CompositionRow): CompositionContentRow => {
      const content = input.contents.get(row.entry) as EntryContent;
      return { ...row, statement: content.statement, data: content.data, applicability: content.applicability };
    };
    // Rows of one kind per part, kinds in code-unit order: a scan by kind reads its own parts, and the parts of a kind
    // that did not change between two builds (often the cases) are shared even when another kind changed everywhere.
    const byKind = new Map<string, CompositionRow[]>();
    for (const row of composition) {
      const group = byKind.get(row.kind);
      if (group === undefined) byKind.set(row.kind, [row]);
      else group.push(row);
    }
    const rowParts = [...byKind.keys()].sort(compareText).flatMap((kind) => splitRows(byKind.get(kind) as CompositionRow[], (row) => row.entry, (row) => (entryBytes.get(row.entry) ?? 1000) + row.path.length));
    const unplacedParts = splitRows(unplaced, (row) => row.entry, (row) => 600 + row.fragments.reduce((s, f) => s + f.length, 0) + row.note.length);
    const sortedSources = [...sources].sort((a, b) => compareText(a.sha256, b.sha256) || compareText(a.external, b.external));
    const sourceParts = splitRows(sortedSources, (row) => row.sha256, (row) => 500 + row.external.length);
    const refs = async <R>(groups: R[][], write: (rows: R[]) => Promise<{ digest: string }>, first: (row: R) => string): Promise<CompositionPartRef[]> =>
      mapLimited(groups, writeConcurrency, async (group) => ({ record: (await write(group)).digest, rows: group.length, first: first(group[0]), last: first(group[group.length - 1]) }));
    const rowRefs = await refs(rowParts, (group) => store.putPart(SCHEMAS.rowsPart, group.map(contentRow)), (row) => row.path);
    parts = {
      composition: rowRefs.map((ref, i) => ({ ...ref, kind: rowParts[i][0].kind })),
      unplaced: await refs(unplacedParts, (group) => store.putPart(SCHEMAS.unplacedPart, group), (row) => row.entry),
      sources: await refs(sourceParts, (group) => store.putPart(SCHEMAS.sourcesPart, group), (row) => row.sha256),
    };
    partCount = parts.composition.length + parts.unplaced.length + parts.sources.length;
  }

  const body = input.body(parts);
  return store.records.withTransaction(async (tx) => {
    const record = await store.putRoot(body, tx);
    const action = await input.action(record.digest, tx);
    return { created: fresh.size, composition: record.digest, action, body, parts: partCount };
  });
}

/**
 * The catalogs of the root. Members are the entries of the declared kind, of the declared producer when the catalog names
 * one; a declared-complete catalog stays complete only when no such entry was refused, left unplaced or lacks catalog data,
 * and no listed source its producer could have given members from was skipped (C07 R[1]: absence is a fact only for a
 * complete catalog). Without a declared producer, the skips of every producer count that gave entries of the kind here, or
 * gave nothing whose kind is known.
 */
function rootCatalogs(
  product: ProductHandle,
  composition: CompositionRow[],
  unplaced: UnplacedRow[],
  refusedOf: ReadonlyMap<string, ReadonlyMap<string, number>>,
  skippedOf: ReadonlyMap<string, number>,
  contents: Map<string, EntryContent>,
  incompleteGrammars:ReadonlySet<string>,
): RootCatalog[] {
  // The entry kinds each producer gave in this root (placed, unplaced, or declared on a refused entry).
  const kindsOf = new Map<string, Set<string>>();
  const gave = (producer: string, kind: string): void => {
    const kinds = kindsOf.get(producer) ?? new Set<string>();
    kinds.add(kind);
    kindsOf.set(producer, kinds);
  };
  for (const row of composition) for (const producer of row.producers) gave(producer, row.kind);
  for (const row of unplaced) for (const producer of row.producers) gave(producer, row.kind);
  for (const [producer, kinds] of refusedOf) for (const kind of kinds.keys()) if (isEntryKind(kind)) gave(producer, kind);
  return product.product.catalogs.map((catalog) => {
    const ours = (producers: readonly string[]): boolean => catalog.producer === undefined || producers.includes(catalog.producer);
    const rows = composition.filter((row) => row.kind === catalog.entry_kind && ours(row.producers));
    const invalid = rows.filter((row) => catalogData(contents.get(row.entry)?.data ?? {}) === null).length;
    const lost = unplaced.filter((row) => row.kind === catalog.entry_kind && ours(row.producers)).length;
    let refusedHere = 0;
    for (const [producer, kinds] of refusedOf) if (ours([producer])) refusedHere += kinds.get(catalog.entry_kind) ?? 0;
    let skippedHere = 0;
    const skippers: string[] = [];
    for (const [producer, count] of [...skippedOf].sort(([a], [b]) => compareText(a, b))) {
      const kinds = kindsOf.get(producer);
      const counts = catalog.producer === undefined ? kinds === undefined || kinds.has(catalog.entry_kind) : producer === catalog.producer;
      if (!counts || count === 0) continue;
      skippedHere += count;
      skippers.push(producer);
    }
    const reasons: string[] = [];
    const grammars=[...incompleteGrammars].filter(producer=>ours([producer])).sort(compareText);
    if(grammars.length)reasons.push(`生产器 ${grammars.join('、')} 的声明语法未完整核对，缺失事实与出口见生产诊断`);
    if (invalid > 0) reasons.push(`${invalid} 个条目没有可用的目录数据`);
    if (lost > 0) reasons.push(`${lost} 个条目没能挂树`);
    if (refusedHere > 0) reasons.push(`${refusedHere} 个条目没有通过核对`);
    if (skippedHere > 0) reasons.push(`${skippedHere} 份列出的来源没有用上（生产器 ${skippers.join('、')}）`);
    const complete = catalog.complete && reasons.length === 0;
    return {
      ...catalog,
      complete,
      declared_complete: catalog.complete,
      members: rows.length - invalid,
      incomplete_reason: catalog.complete && !complete ? reasons.join('；') : null,
    };
  });
}

/** The catalog-entry fields of an entry's data (words, signatures, summary), or null when they are not there. */
export function catalogData(data: Record<string, unknown>): { words: string[]; signatures: CatalogEntry['signatures']; summary?: string } | null {
  const candidate = { words: data.words, signatures: data.signatures ?? [], reference: 'rec:0000000000000000000000000000000000000000000000000000000000000000', ...(typeof data.summary === 'string' ? { summary: data.summary } : {}) };
  const parsed = CatalogEntry.safeParse(candidate);
  if (!parsed.success) return null;
  return { words: parsed.data.words, signatures: parsed.data.signatures, ...(parsed.data.summary === undefined ? {} : { summary: parsed.data.summary }) };
}

/**
 * The syntax of an entry's catalog data as an impact view asked for a catalog compares it (catalog-entry@1): the words,
 * and the signatures as a set, each signature without its id and reference and each parameter without its description;
 * the summary is left out. Null when the data is not catalog data.
 */
export function catalogCanon(data: Record<string, unknown>): string | null {
  const parsed = catalogData(data);
  if (parsed === null) return null;
  const signatures = parsed.signatures.map((signature) => ({
    params: signature.params.map((param) => {
      const { description: _dropped, native_type: _nativeType, ...rest } = param;
      // Diagnostic paths and recovery prose identify observations; they do not change a parameter's syntax.
      return {...rest,...(rest.unchecked_constraints?{unchecked_constraints:rest.unchecked_constraints.map(({path:_path,next_action:_action,...constraint})=>constraint).sort((a,b)=>compareText(canonicalize(a),canonicalize(b)))}:{})};
    }),
  }));
  signatures.sort((a, b) => compareText(canonicalize(a), canonicalize(b)));
  return canonicalize({ words: parsed.words, signatures });
}

interface ProduceActionInput {
  startedAt: string;
  sync: string | null;
  product: string;
  pack: { id: string; version: string; digest: string };
  /** The build as listed, list roles by reference. */
  build: RecordedBuild | null;
  root: string | null;
  composition: string | null;
  sources: ProduceDetail['sources'];
  missing: ProduceDetail['missing'];
  lists: ListDetail[];
  calls: { made: number; reused: number };
  placement: ProduceDetail['placement'];
  reason: string | null;
  problem_chunks?:ProblemChunks;
  listing_digest?:string;
  source_failures?:SourceObservation[];
}

/** The generate action of one production (completed) or of its failure (error), indexed for the build and the root. */
export async function writeProduceAction(context: KnowledgeContext, input: ProduceActionInput, tx: Parameters<KnowledgeContext['store']['putAction']>[2] | null): Promise<string> {
  const detail: ProduceDetail = {
    sync: input.sync,
    product: input.product,
    pack: input.pack,
    build: input.build,
    root: input.root,
    composition: input.composition,
    sources: input.sources,
    missing: input.missing,
    lists: input.lists,
    calls: { made: input.calls.made, reused: input.calls.reused },
    placement: input.placement,
    reason: input.reason,
    ...(input.listing_digest?{listing_digest:input.listing_digest}:{}),
    ...(input.source_failures?.length?{source_failures:input.source_failures}:{}),
    ...(input.problem_chunks?{problem_chunks:input.problem_chunks}:{}),
  };
  const body: ActionBody = {
    action: ACTION.generate,
    run: null,
    item: null,
    inputs: [...new Set(input.sources.map((s) => `src:${s.sha256}`))],
    component: COMPONENTS.produce,
    lease: null,
    started_at: input.startedAt,
    ended_at: context.now().toISOString(),
    result: input.root === null ? 'error' : 'completed',
    error_code: input.source_failures?.some(source=>source.code==='SOURCE_ABSENT')?'SOURCE_ABSENT':input.source_failures?.some(source=>source.code==='SOURCE_FORBIDDEN')?'SOURCE_UNAVAILABLE':null,
    acceptance: null,
    codes: [],
    detail: detail as unknown as Record<string, unknown>,
  };
  const index = [
    { key: input.build === null ? INDEX.produceScope : INDEX.produce, value: input.build === null ? input.product : buildKey(input.product, input.build.name) },
    { key: INDEX.produceProduct, value: input.product },
    ...(input.root===null?[{key:INDEX.buildFailure,value:input.product},...(input.build===null?[]:[{key:INDEX.buildFailureName,value:buildKey(input.product,input.build.name)}]),{key:INDEX.buildFailureRoot,value:`${input.product}/none`}]:[]),
    ...(input.root === null ? [] : [{ key: INDEX.produceRoot, value: input.root },...(input.composition?[{key:'knowledge.produce.composition',value:input.composition}]:[])]),
    ...(input.sync === null ? [] : [{ key: INDEX.sync, value: input.sync }]),
  ];
  const record = await context.store.putAction(body, index, tx ?? undefined);
  return record.digest;
}
