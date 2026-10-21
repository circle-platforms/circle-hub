// createKnowledge: wires the knowledge service. It provides KnowledgePort exactly as hub/ports.ts declares it, plus the
// production, sync, current-root, calibration, placement, provenance and layer operations of this package.
import type { JevClient } from '../jev/api.ts';
import type { KnowledgePort, NodesPage, NodesQuery, PacksPort, ProductHandle, RootDiff, RootInfo, ExternalReaderPort } from '../ports.ts';
import type { KnownBuild } from '../../contracts/src/product.ts';
import type { Principal } from '../records/api.ts';
import { pathSegments, type ParserRegistry, type TreeReader } from '../refs/api.ts';
import type { CatalogView, SandboxLimits } from '../rules/api.ts';
import { Builds, type LineReconciliation, type MoveRootOptions, type MoveRootResult } from './builds.ts';
import { CalibrationStore, PLACEMENT_CHAIN, maskLiterals, type CalibrationState, type LabelledSamplesInput } from './calibration.ts';
import { DEFAULT_KNOWLEDGE_LIMITS, DEFAULT_SANDBOX, WriteQueue, requireAdmin, type KnowledgeContext, type KnowledgeLimits, type KnowledgeRecords } from './context.ts';
import { compareText, cutText } from './digest.ts';
import { CandidateLayer, ObservationLayer } from './layers.ts';
import { MAX_DESCRIPTION, Placer, type PlaceOptions, type PlacementChild, type PlacementOutcome, type PlacementSpan, type PlacementTree } from './placement.ts';
import { produceTree, type ProduceInput, type ProduceResult } from './produce.ts';
import { TreeReading, type ProvenanceRow, type TreeLock } from './read.ts';
import { KnowledgeStore } from './store.ts';
import { syncProduct, type SyncOptions, type SyncReport } from './sync.ts';

export interface KnowledgeOptions {
  records: KnowledgeRecords;
  parsers: ParserRegistry;
  packs: PacksPort;
  external: ExternalReaderPort;
  /** The typed-judgment client for placement; null or absent: spans the code cannot place stay unplaced. */
  jev?: JevClient | null;
  sandbox?: { plan?: Partial<SandboxLimits>; producer?: Partial<SandboxLimits>; requireOsIsolation?: boolean };
  clock?: () => Date;
  limits?: Partial<KnowledgeLimits>;
  /** Default admin context of syncs and productions that name none. */
  admin?: Principal | null;
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
  /**
   * KnowledgePort's reader; bound to `lock.composition` (the RootInfo.composition a run locked) its grounds come from that
   * composition alone, otherwise from every composition of the root (README decision 13; Needs: the port does not pass it).
   */
  treeReader(lock?: TreeLock | null): TreeReader;
  produceTree(input: ProduceInput): Promise<ProduceResult>;
  /** Syncs of one product run one after the other in this process. */
  syncProduct(product: ProductHandle, options?: SyncOptions): Promise<SyncReport>;
  /** What a run locks: the root of a named build (any family), else the current root of the line. */
  lockRoot(product: string, target: { line?: string | null; build?: string | null }): Promise<RootInfo | null>;
  /** An enabled admin moves a current root, with the completed generate action that produced it as `cause` (K01 R[6], B05 R[4]). */
  moveRoot(product: string, line: string, expected: string | null, root: string, cause: string | null, options?: MoveRootOptions): Promise<MoveRootResult>;
  reconcileLine(product: string, line: string, by?: Principal | null): Promise<LineReconciliation>;
  /** Provenance for a reader who may read the root; null for anyone else (absent and forbidden alike). */
  provenanceOf(reference: string, reader: Principal): Promise<ProvenanceRow[] | null>;
  calibration: KnowledgeCalibration;
  placement: KnowledgePlacement;
  layers: { observations: ObservationLayer; candidates: CandidateLayer };
  /** Record access of this package (console and tests). */
  store: KnowledgeStore;
}

export function createKnowledge(options: KnowledgeOptions): Knowledge {
  const now = options.clock ?? (() => new Date());
  const store = new KnowledgeStore(options.records.store);
  const placer = new Placer({ jev: options.jev ?? null, store, now });
  const calibration = new CalibrationStore(store, options.records.principals);
  const context: KnowledgeContext = {
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
    writes: new WriteQueue(),
  };
  const builds = new Builds(context);
  const reading = new TreeReading(context);
  const observations = new ObservationLayer(context, reading);
  const candidates = new CandidateLayer(context, reading);

  const buildCalibrationSet = async (input: BuildCalibrationInput): Promise<{ record: string | null; samples: number; state: CalibrationState | null }> => {
    await requireAdmin(context, input.by, '建立校准样例');
    const model = placer.model;
    if (model === null) return { record: null, samples: 0, state: null };
    const kind = input.kind ?? PLACEMENT_CHAIN;
    const composition = await reading.compositionOf(input.root);
    if (composition === null) return { record: null, samples: 0, state: await calibration.state(kind, model) };
    const rows = composition.body.composition
      .filter((row) => row.placement === undefined && row.path !== '/' && (input.kinds === undefined || input.kinds.includes(row.kind)))
      .sort((a, b) => compareText(a.entry, b.entry) || compareText(a.path, b.path))
      .slice(0, input.limit ?? 200);
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
    const samples = await placer.sample(questions, { product: composition.body.product, build: composition.body.build.name });
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
    async builds(product: string, filter: { line?: string; released?: boolean } = {}): Promise<KnownBuild[]> {
      return (await builds.known(product)).filter(
        (build) => (filter.line === undefined || build.line === filter.line) && (filter.released === undefined || (build.released_at !== null) === filter.released),
      );
    },
    resolveBuild: (product, name) => builds.resolve(product, name),
    currentRoot: (product, line) => builds.currentRoot(product, line),
    rootOfBuild: (product, name) => builds.rootOfBuild(product, name),
    rootInfo: (root) => builds.rootInfo(root),
    catalog: (root, catalogId): Promise<CatalogView | null> => reading.catalog(root, catalogId),
    treeReader: (lock?: TreeLock | null): TreeReader => reading.treeReader(lock ?? null),
    getNodes: (query: NodesQuery, reader: Principal): Promise<NodesPage | null> => reading.getNodes(query, reader),
    diffRoots: (from, to): Promise<RootDiff | null> => reading.diff(from, to),

    // ------------------------------------------------ extras
    produceTree: (input) => produceTree(context, input),
    syncProduct: (product, syncOptions = {}) => syncOne(product, syncOptions),
    async lockRoot(product, target) {
      if (target.build !== undefined && target.build !== null && target.build !== '') return builds.rootOfBuild(product, target.build);
      if (target.line !== undefined && target.line !== null && target.line !== '') return builds.currentRoot(product, target.line);
      return null;
    },
    moveRoot: (product, line, expected, root, cause, moveOptions) => builds.moveRoot(product, line, expected, root, cause, moveOptions),
    async reconcileLine(product, line, by) {
      const account = await requireAdmin(context, by, '移动当前根');
      return builds.reconcileLine(product, line, account);
    },
    provenanceOf: (reference, reader) => reading.provenanceOf(reference, reader),
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
    layers: { observations, candidates },
    store,
  };
}
