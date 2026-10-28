import {FeedingLayer} from './feeding.ts';
import {scheduleSync} from './sync-schedule.ts';
import {requestKnowledgeFact} from './requests.ts';
// createKnowledge: wires the knowledge service. It provides KnowledgePort exactly as hub/ports.ts declares it, plus the
// production, sync, current-root, calibration, placement, provenance and layer operations of this package.
import type { JevClient } from '../jev/api.ts';
import type { EntryDiff, KnowledgePort, NodesPage, NodesQuery, PacksPort, ProductHandle, ReadRoot, ReadRootQuery, RootDiff, RootInfo, ExternalReaderPort } from '../ports.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { RootSource } from '../../contracts/src/knowledge.ts';
import type { EntryKind } from '../../contracts/generated/vocabulary.ts';
import type { Principal } from '../records/api.ts';
import { pathSegments, type ParserRegistry, type TreeReader } from '../refs/api.ts';
import type { CatalogView, SandboxLimits } from '../rules/api.ts';
import { Builds, type LineReconciliation, type MoveRootOptions, type MoveRootResult } from './builds.ts';
import { CalibrationStore, PLACEMENT_CHAIN, maskLiterals, type CalibrationState, type LabelledSamplesInput } from './calibration.ts';
import { DEFAULT_KNOWLEDGE_LIMITS, DEFAULT_SANDBOX, WriteQueue, requireAdmin, type KnowledgeContext, type KnowledgeLimits, type KnowledgeRecords } from './context.ts';
import { canonicalSize,compareText, cutText } from './digest.ts';
import { ObservationLayer } from './layers.ts';
import { ContributionLayer } from './contributions.ts';
import { contributionNodes } from './contribution-pages.ts';
import { MAX_DESCRIPTION, Placer, type PlaceOptions, type PlacementChild, type PlacementOutcome, type PlacementSpan, type PlacementTree } from './placement.ts';
import { produceTree, type ProduceInput, type ProduceResult } from './produce.ts';
import { TreeReading, type ProvenanceRow, type TreeLock } from './read.ts';
import { KnowledgeStore } from './store.ts';
import { syncProduct, type SyncOptions, type SyncReport } from './sync.ts';
import { LinkReading } from './links.ts';
import { KnowledgeViews } from './views.ts';
import { withReadCache } from './read-cache.ts';

export interface KnowledgeOptions {
  /** Additional declared scope (for example unversioned knowledge); roots and compositions must belong to this product. */
  additionalScopeRoots?: (product:string)=>Promise<readonly {root:string;composition:string}[]>;
  records: KnowledgeRecords;
  parsers: ParserRegistry;
  packs: PacksPort;
  external: ExternalReaderPort;
  /** Test injection point of the placement judge (a scripted judge in this package's tests). The production assembly never
   * passes one: the Hub calls no model, and spans the code cannot place stay unplaced at the root. */
  jev?: JevClient | null;
  sandbox?: { plan?: Partial<SandboxLimits>; producer?: Partial<SandboxLimits>; requireOsIsolation?: boolean };
  clock?: () => Date;
  limits?: Partial<KnowledgeLimits>;
  /** Default admin context of syncs and productions that name none. */
  admin?: Principal | null;
  credentialAcceptance?:import('./credential-policy.ts').CredentialAcceptanceOptions;
  /** Reads the feeding layer beside seedlings (kb-feeding); absent when nothing was fed yet. */
  feeding?:import('./feeding-types.ts').FeedingReader;
}

export interface BuildCalibrationInput {
  root: string;
  by?: Principal | null;
  /** Entry kinds whose code-placed entries become samples; default every kind. */
  kinds?: string[];
  /** Most entries used, deterministic by entry digest; default 200. */
  limit?: number;
  /** Calibration chain; default placement.choice. */
  kind?: string;
}

export interface KnowledgeCalibration {
  state(kind: string, model: string): Promise<CalibrationState>;
  threshold(kind: string, model: string): Promise<number | null>;
  addLabelled(by: Principal, input: LabelledSamplesInput): Promise<string>;
  /**
   * Turns code-placed spans of a root into frozen samples (K04 R[1]): their command literals are masked, then the placement
   * question is asked at every level of their known path. Needs the Jev client.
   */
  buildCalibrationSet(input: BuildCalibrationInput): Promise<{ record: string | null; samples: number; state: CalibrationState | null }>;
}

export interface KnowledgePlacement {
  readonly model: string | null;
  place(spans: readonly PlacementSpan[], tree: PlacementTree, options: PlaceOptions): Promise<Map<string, PlacementOutcome>>;
}

export interface Knowledge extends KnowledgePort {
  /** The context this service was created with (the seedling production and tests of this package reach for it). */
  readonly __context: KnowledgeContext;
  /**
   * KnowledgePort's reader; bound to `lock.composition` (the RootInfo.composition a run locked) its grounds come from that
   * composition alone, otherwise from every composition of the root (README decision 13; Needs: the port does not pass it).
   */
  treeReader(lock?: TreeLock | null): TreeReader;
  produceTree(input: ProduceInput): Promise<ProduceResult>;
  /** Syncs of one product run one after the other in this process. */
  syncProduct(product: ProductHandle, options?: SyncOptions): Promise<SyncReport>;
  /** Explicit opt-in periodic synchronization; the caller owns and stops this handle. */
  scheduleSync(product:ProductHandle,options:{intervalMs:number;sync?:SyncOptions;onReport?:(report:SyncReport)=>void}):ReturnType<typeof scheduleSync<SyncReport>>;
  /** The root a run locks and a view reads: the line's seedling when that pointer names one, otherwise the sync root. */
  rootForRead(product: string, query: ReadRootQuery): Promise<ReadRoot | null>;
  /** Same choice as rootForRead, as the root alone. */
  lockRoot(product: string, target: { line?: string | null; build?: string | null }): Promise<RootInfo | null>;
  /** An enabled admin moves a current root, with the completed generate action that produced it as `cause` (K01 R[6], B05 R[4]). */
  moveRoot(product: string, line: string | null, expected: string | null, root: string, cause: string | null, options?: MoveRootOptions): Promise<MoveRootResult>;
  reconcileLine(product: string, line: string, by?: Principal | null): Promise<LineReconciliation>;
  /** Provenance for a reader who may read the root; null for anyone else (absent and forbidden alike). */
  provenanceOf(reference: string, reader: Principal): Promise<ProvenanceRow[] | null>;
  calibration: KnowledgeCalibration;
  placement: KnowledgePlacement;
  layers: { observations: ObservationLayer; contributions: ContributionLayer };
  /** The knowledge views (impact, facets, index); createKnowledgeReader serves them as external objects. */
  views: KnowledgeViews;
  /** Record access of this package (console and tests). */
  store: KnowledgeStore;
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  const now = options.clock ?? (() => new Date());
  const deadlineHours=options.credentialAcceptance?.deadlineHours??72;
  if(!Number.isFinite(deadlineHours)||deadlineHours<=0||!Number.isFinite(new Date(now().getTime()+deadlineHours*3600000).getTime()))throw new TypeError('凭据核对期限必须是有效的正数小时');
  const store = new KnowledgeStore(options.records.store);
  const placer = new Placer({ jev: options.jev ?? null, store, now });
  const calibration = new CalibrationStore(store, options.records.principals);
  const context: KnowledgeContext = {
    additionalScopeRoots: options.additionalScopeRoots,
    additionalScopeRootsDeclared: options.additionalScopeRoots !== undefined,
    records: options.records,
    store,
    parsers: options.parsers,
    packs: options.packs,
    external: options.external,
    placer,
    calibration,
    now,
    sandbox: {
      plan: { ...DEFAULT_SANDBOX.plan, ...(options.sandbox?.plan ?? {}) },
      producer: { ...DEFAULT_SANDBOX.producer, ...(options.sandbox?.producer ?? {}) },
      requireOsIsolation: options.sandbox?.requireOsIsolation ?? true,
    },
    limits: { ...DEFAULT_KNOWLEDGE_LIMITS, ...(options.limits ?? {}) },
    admin: options.admin ?? null,
    feedingReader: options.feeding,
    credentialAcceptance:{autoAcceptSources:options.credentialAcceptance?.autoAcceptSources??[],deadlineHours},
    writes: new WriteQueue(),
  };
  const builds = new Builds(context);
  context.additionalScopeRoots ??= async product => {
    const root = await builds.currentRoot(product, null);
    return root === null ? [] : [{root:root.root,composition:root.composition}];
  };
  const reading = new TreeReading(context);
  const feeding=new FeedingLayer(context,reading);context.feeding=feeding;context.feedingReader??=feeding;
  const observations = new ObservationLayer(context, reading);
  const contributions = new ContributionLayer(context, reading);
  const seedlingInfo = async (product: string, line: string): Promise<RootInfo | null> => {
    const seed = await feeding.seedFor(product, line);
    if (!seed) return null;
    const info = (await builds.rootInfo(seed.root)).find((row) => row.composition === seed.composition && row.build !== null);
    return (info as RootInfo | undefined) ?? null;
  };
  const rootForRead = async (product: string, query: ReadRootQuery): Promise<ReadRoot | null> => {
    const buildName = typeof query.build === 'string' && query.build !== '' ? query.build : null;
    const lineQuery = typeof query.line === 'string' && query.line !== '' ? query.line : null;
    let line: string | null = null;
    let sync: RootInfo | null = null;
    if (buildName) {
      sync = await builds.syncRoot(product, buildName);
      const named = sync?.build ?? await builds.named(product, buildName);
      if (named === null) return null;
      line = named.line;
    } else if (lineQuery) {
      line = lineQuery;
      sync = await builds.currentRoot(product, lineQuery);
    } else return null;
    const seedling = line ? await seedlingInfo(product, line) : null;
    if (seedling) return { info: seedling, source: 'seedling', sync: sync && sync.root !== seedling.root ? sync : null };
    return sync ? { info: sync, source: 'sync', sync: null } : null;
  };
  const relations = new LinkReading(context, builds, rootForRead);
  reading.setRelations(relations);
  const views = new KnowledgeViews(context, builds, reading, relations, rootForRead);

  const buildCalibrationSet = async (input: BuildCalibrationInput): Promise<{ record: string | null; samples: number; state: CalibrationState | null }> => {
    await requireAdmin(context, input.by, '建立校准样例');
    const model = placer.model;
    if (model === null) return { record: null, samples: 0, state: null };
    const kind = input.kind ?? PLACEMENT_CHAIN;
    const composition = await reading.compositionOf(input.root);
    if (composition === null) return { record: null, samples: 0, state: await calibration.state(kind, model) };
    const eligible: Array<{ entry: string; path: string; fragments: string[] }> = [];
    for await (const row of composition.rows(input.kinds === undefined ? undefined : new Set(input.kinds))) {
      if (row.placement === undefined && row.path !== '/' && (input.kinds === undefined || input.kinds.includes(row.kind))) eligible.push({ entry: row.entry, path: row.path, fragments: row.fragments });
    }
    const rows = eligible.sort((a, b) => compareText(a.entry, b.entry) || compareText(a.path, b.path)).slice(0, input.limit ?? 200);
    // The options of a question about one entry: the entry itself never describes an option (its own first line would hand
    // the model the answer), and every description is masked like the passage.
    const childrenAt = async (segments: string[], sampled: string, literals: readonly string[]): Promise<PlacementChild[]> => {
      const found = await reading.nodeAt(input.root, segments);
      if (found === null) return [];
      const out: PlacementChild[] = [];
      for (const child of found.node.children) {
        const node = await store.node(child.digest);
        const first = node?.entries.find((entry) => entry !== sampled);
        const statement = first === undefined ? null : ((await store.entry(first))?.statement ?? null);
        const line = statement === null ? null : (statement.split('\n').find((l) => l.trim() !== '') ?? null);
        out.push({ name: child.name, description: line === null ? null : cutText(maskLiterals(line.trim(), literals), MAX_DESCRIPTION) });
      }
      return out;
    };
    const questions = [];
    for (const row of rows) {
      const content = await store.entry(row.entry);
      if (content === null || content.statement.trim() === '') continue;
      const segments = pathSegments(row.path);
      const words = Array.isArray(content.data.words) ? content.data.words.filter((w): w is string => typeof w === 'string') : [];
      const literals = [...segments, segments.join(' '), words.join(' '), ...words];
      const masked = maskLiterals(content.statement, literals);
      // Every level of the known path, and the entry's own node when it has children: there none of them is right (the
      // entry is about the node itself), which measures descents that should not happen.
      for (let depth = 0; depth <= segments.length; depth++) {
        const at = segments.slice(0, depth);
        const children = await childrenAt(at, row.entry, literals);
        if (depth === segments.length && children.length === 0) continue;
        questions.push({ key: `${row.entry}:${depth}`, text: masked, section: '', fragment: row.fragments[0], segments: at, children, expected: depth < segments.length ? segments[depth] : null });
      }
    }
    const samples = await placer.sample(questions, { product: composition.body.product, build: composition.body.build?.name ?? '未声明' });
    if (samples.length === 0) return { record: null, samples: 0, state: await calibration.state(kind, model) };
    const record = await calibration.append({ kind, model, origin: 'projected', samples, decided_by: null, root: input.root, note: `由 ${rows.length} 个代码挂树的片段遮去命令字面后生成` });
    return { record, samples: samples.length, state: await calibration.state(kind, model) };
  };

  // One sync per product at a time in this process: a second one waits, then finds the first one's work done.
  const syncing = new Map<string, Promise<unknown>>();
  const syncOne = (product: ProductHandle, syncOptions: SyncOptions): Promise<SyncReport> => {
    const id = product.product.id;
    const run = (syncing.get(id) ?? Promise.resolve()).then(() => syncProduct(context, builds, product, syncOptions));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    syncing.set(id, settled);
    void settled.then(() => {
      if (syncing.get(id) === settled) syncing.delete(id);
    });
    return run;
  };

  return {
    // ------------------------------------------------ KnowledgePort
    /** The context this service was created with (the seedling production and tests of this package reach for it). */
    __context: context,
    feeding,
    async builds(product: string, filter: { line?: string; released?: boolean } = {}): Promise<KnownBuild[]> {
      return (await builds.known(product)).filter(
        (build) => (filter.line === undefined || build.line === filter.line) && (filter.released === undefined || (build.released_at !== null) === filter.released),
      );
    },
    resolveBuild: (product, name) => builds.resolve(product, name),
    async unversionedRoot(product) {
      const info = await builds.currentRoot(product, null);
      if (info === null) return null;
      const body = await store.composition(info.composition);
      if (body === null || body.build !== null || body.version !== null) throw new Error('不分版本的根缺少对应的组成；恢复组成后重新读取');
      return { ...info, source_count: body.sources.length + (body.parts?.sources ?? []).reduce((n, p) => n + p.rows, 0) };
    },
    currentRoot: (product, line) => builds.currentRoot(product, line),
    seedlingRoot: (product, line) => seedlingInfo(product, line),
    rootForRead,
    rootOfBuild: (product, name) => builds.rootOfBuild(product, name),
    rootInfo: (root) => builds.rootInfo(root),
    rootSources: (root: string): Promise<RootSource[]> => withReadCache(async () => {
      const compositions = await reading.compositionsOf(root);
      const out: RootSource[] = [];
      for (const c of compositions) {
        for (const s of await c.sources()) {
          if (!out.some((existing) => existing.sha256 === s.sha256)) out.push(s);
        }
      }
      return out;
    }),
    catalog: (root, catalogId, selection): Promise<CatalogView | null> => withReadCache(()=>reading.catalog(root, catalogId, selection)),
    treeReader: (lock?: TreeLock | null): TreeReader => {
      const reader=reading.treeReader(lock??null);
      return {...reader,read:(...args)=>withReadCache(()=>reader.read(...args)),readEntry:(...args)=>withReadCache(()=>reader.readEntry(...args)),...(reader.hasRoot?{hasRoot:(...args:Parameters<NonNullable<TreeReader['hasRoot']>>)=>withReadCache(()=>reader.hasRoot!(...args))}:{})};
    },
    getNodes:async(query:NodesQuery,reader:Principal):Promise<NodesPage|null>=>withReadCache(async()=>{
      // Establish permission before even decoding a contribution cursor.
      if(!(await reading.mayReadRoot(reader,query.root)))return null;
      const page=await contributionNodes(context,reading,contributions,query,reader);if(!page)return null;
      const products=await reading.productsOfRoot(query.root);const rows=[];for(const product of products)rows.push(...await feeding.entries(reader,product,query.feeding_offset?.offset??Number.MAX_SAFE_INTEGER));
      for(const node of page.nodes){const relevant=rows.filter(row=>row.validity==='valid'&&row.body.root===query.root&&(row.body.path===node.path||row.body.path===null&&node.path==='/'||Array.isArray(row.body.commands)&&row.body.commands.some((command:Record<string,unknown>)=>command.path===node.path)));const references=[];for(const row of relevant){if(references.length===100)break;const ref={object:row.body.object,reference:'rec:'+row.record};if(canonicalSize(page)+canonicalSize(references)+canonicalSize(ref)>context.limits.pageBytes-1024)break;references.push(ref);}if(relevant.length){node.feeding_objects=references;node.feeding_complete=references.length===relevant.length;if(!node.feeding_complete)page.coverage={...page.coverage,complete:false,note:[page.coverage.note,'喂入引用达到本页预算；从知识 index/facets 视图读取完整范围'].filter(Boolean).join('；')};}}
      return page;
    }),
    diffRoots: (from, to): Promise<RootDiff | null> => withReadCache(()=>reading.diff(from, to)),
    diffEntries: (from: string, to: string, diffOptions: { kinds: readonly EntryKind[]; limit?: number }): Promise<EntryDiff | null> => withReadCache(()=>reading.diffEntries(from, to, diffOptions)),

    // ------------------------------------------------ extras
    produceTree: (input) => produceTree(context, input),
    syncProduct: (product, syncOptions = {}) => syncOne(product, syncOptions),
    scheduleSync(product,options){
      return scheduleSync(signal=>syncOne(product,{...options.sync,signal}),{intervalMs:options.intervalMs,onReport:options.onReport,onError:async()=>{await requestKnowledgeFact(context,{kind:'repair',subject:product.product.id,missing:'定时知识同步未能完成',action:'管理员核对该产品同步动作的错误并修复后重新同步',inputs:[]});}});
    },
    lockRoot: async (product, target) => (await rootForRead(product, target))?.info ?? null,
    moveRoot: (product, line, expected, root, cause, moveOptions) => builds.moveRoot(product, line, expected, root, cause, moveOptions),
    async reconcileLine(product, line, by) {
      const account = await requireAdmin(context, by, '移动当前根');
      return builds.reconcileLine(product, line, account);
    },
    provenanceOf: (reference, reader) => withReadCache(()=>reading.provenanceOf(reference, reader)),
    calibration: {
      state: (kind, model) => calibration.state(kind, model),
      threshold: (kind, model) => calibration.threshold(kind, model),
      addLabelled: (by, input) => calibration.addLabelled(by, input),
      buildCalibrationSet,
    },
    placement: {
      get model() {
        return placer.model;
      },
      place: (spans, tree, placeOptions) => placer.place(spans, tree, placeOptions),
    },
    layers: { observations, contributions },
    views,
    store,
  };
}
