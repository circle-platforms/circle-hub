// In-memory fakes of the ports the server consumes (hub/ports.ts), for the server's own tests and createTestServer. They are
// deterministic, synthetic (an invented product line, invented commands, 192.0.2.0/24 addresses) and use the real records
// kit for what records owns: users, pack assignments, uploads and the stored run, submission and result records. Each fake
// can be told to give one raw answer or throw once, so tests reach protocol errors, refusals and malformed answers.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARTITION, type EntryKind, type PackKind } from '../../contracts/generated/vocabulary.ts';
import type { PackManifest, RequirementTemplate, SlotsFile, WorkflowFile } from '../../contracts/src/pack.ts';
import type { KnownBuild, ProductDeclaration } from '../../contracts/src/product.ts';
import type { Claim } from '../../contracts/src/claim.ts';
import type { ProtocolError } from '../../contracts/src/common.ts';
import type { ItemProjection, PackSummary, RunRecord, RunRecordView, RunSummary } from '../../contracts/src/run.ts';
import { Submission } from '../../contracts/src/submission.ts';
import type { ResolveReferenceInput, StartRunInput } from '../../contracts/src/tools.ts';
import { partitionCountsOf, type Partitions, type RequirementResult, type ValidationResult } from '../../contracts/src/validation.ts';
import type {
  CallContext,
  KnowledgePort,
  LoadedWorkflow,
  NodeViews,
  NodesPage,
  NodesQuery,
  PackCatalogPort,
  PackHandle,
  PackListing,
  PacksPort,
  ProductHandle,
  ResourceCatalogPort,
  ResourceListing,
  EntryDiff,
  RootDiff,
  RootInfo,
  RunDetail,
  RunSubmissionView,
  RunsService,
  Untraced,
  WorkflowStore,
} from '../ports.ts';
import { canonicalize, sha256Hex, type Page, type Principal, type RecordsKit } from '../records/api.ts';
import type { ReaderIdentity, TreeRead, TreeReader } from '../refs/api.ts';
import type { ProductionResult, StartRunDetail, StoredResult } from '../runs/api.ts';
import { effectiveSubmission } from '../runs/engine/api.ts';
import { pointerOfPath, unavailable } from './tools.ts';
import type { z } from 'zod';
import type { ResolveReferenceOutput, StartRunOutput, SubmitResultOutput } from '../../contracts/src/tools.ts';

export const sha = (text: string): string => sha256Hex(text);

/** The synthetic product line every fake pack is bound to. */
export const PRODUCT = { id: 'line-a', title: '合成产品线', names: ['Line A', 'LA'] } as const;

export interface FakePack {
  id: string;
  version: string;
  kind: PackKind;
  title: string;
  description: string;
  /** Digest of the pack content (synthetic). */
  digest: string;
  owner: string | null;
  summary: PackSummary | null;
  /** The workflow binds expected sources at start_run (workflow `expected_sources`), so start_run reads outside. */
  expectedSources?: boolean;
}

const REQUIREMENTS: PackSummary['requirements'] = [
  { key: 'structure', name: '结构', description: '用例结构完整', layers: ['static'], done_rule: 'bookkeeping', accepted_producer: 'fact', repair_rounds: 2, rules: [], run_interpreters: [] },
  { key: 'findings', name: '发现', description: '评审发现', layers: ['static'], done_rule: 'bookkeeping', accepted_producer: 'judgment', repair_rounds: 2, rules: [], run_interpreters: [] },
];

/**
 * A synthetic workflow pack with one subject input slot that accepts `accepts`. `factsOnly`: its requirements are facts
 * only, so the fake run service computes its result at start_run (a production run).
 */
export function fakeWorkflowPack(id: string, title: string, accepts: string[], options: { expectedSources?: boolean; factsOnly?: boolean } = {}): FakePack {
  const version = '1.0.0';
  return {
    id,
    version,
    kind: 'workflow',
    title,
    description: `${title}（合成）`,
    digest: sha(`pack:${id}@${version}`),
    owner: null,
    ...(options.expectedSources ? { expectedSources: true } : {}),
    summary: {
      pack: `${id}@${version}`,
      id,
      version,
      kind: 'workflow',
      title,
      description: `${title}（合成）`,
      products: [...PRODUCT.names],
      inputs: [{ slot: 'subject', role: 'subject', description: '被评审的文档', accepts, required: true, many: false }],
      parameters: [{ name: 'strict', description: '严格模式', required: false }],
      requirements: options.factsOnly ? REQUIREMENTS.filter((r) => r.accepted_producer === 'fact') : REQUIREMENTS,
    },
  };
}

/** The synthetic packs: a workflow pack that reads an external system, one that takes uploads only, a product and a system pack. */
export function defaultPacks(): FakePack[] {
  return [
    fakeWorkflowPack('review', '合成评审', ['application/json', 'tracker:document']),
    fakeWorkflowPack('local-review', '合成本地评审', ['application/json', 'text/markdown']),
    { id: PRODUCT.id, version: '1.0.0', kind: 'product', title: PRODUCT.title, description: '合成产品包', digest: sha('pack:line-a@1.0.0'), owner: null, summary: null },
    { id: 'tracker-system', version: '1.0.0', kind: 'system', title: '合成跟踪系统', description: '合成系统包', digest: sha('pack:tracker-system@1.0.0'), owner: null, summary: null },
  ];
}

type Method = string;
interface Scripted {
  answer?: unknown;
  error?: unknown;
}

/** One scripted answer or error per method, used once. */
class Script {
  readonly #queue = new Map<Method, Scripted[]>();
  answerNext(method: Method, answer: unknown): void {
    this.#queue.set(method, [...(this.#queue.get(method) ?? []), { answer }]);
  }
  failNext(method: Method, error: unknown): void {
    this.#queue.set(method, [...(this.#queue.get(method) ?? []), { error }]);
  }
  /** The scripted answer, or undefined to run the fake's own logic. */
  take(method: Method): { value: unknown } | undefined {
    const queue = this.#queue.get(method);
    const next = queue?.shift();
    if (next === undefined) return undefined;
    if (next.error !== undefined) throw next.error;
    return { value: next.answer };
  }
}

async function isAdmin(records: RecordsKit, user: Principal): Promise<boolean> {
  const stored = await records.principals.get(user.id);
  return stored !== null && !stored.disabled && stored.role === 'admin';
}

async function isActive(records: RecordsKit, user: Principal): Promise<boolean> {
  const stored = await records.principals.get(user.id);
  return stored !== null && !stored.disabled;
}

// ---------------------------------------------------------------- packs

export class FakeWorkflows implements WorkflowStore {
  readonly packs: FakePack[];
  readonly #records: RecordsKit;
  readonly script = new Script();
  constructor(records: RecordsKit, packs: FakePack[]) {
    this.#records = records;
    this.packs = packs;
  }

  async usable(user: Principal): Promise<FakePack[]> {
    if (!(await isActive(this.#records, user))) return [];
    const out: FakePack[] = [];
    for (const pack of this.packs) if (pack.kind === 'workflow' && (await this.#records.authorizations.canUse(user.id, pack.id))) out.push(pack);
    return out;
  }

  find(ref: string): FakePack | undefined {
    const [id, version] = ref.split('@');
    return this.packs.find((pack) => pack.id === id && (version === undefined || pack.version === version));
  }

  async forUser(user: Principal, ref: string): Promise<LoadedWorkflow | null> {
    const pack = this.find(ref);
    if (pack === undefined || pack.kind !== 'workflow' || !(await this.usable(user)).includes(pack)) return null;
    return loaded(pack);
  }

  async byDigest(digest: string): Promise<LoadedWorkflow | null> {
    const pack = this.packs.find((p) => p.digest === digest && p.kind === 'workflow');
    return pack === undefined ? null : loaded(pack);
  }

  async summaries(user: Principal): Promise<PackSummary[]> {
    const scripted = this.script.take('summaries');
    if (scripted !== undefined) return scripted.value as PackSummary[];
    return (await this.usable(user)).map((pack) => pack.summary!).filter((summary) => summary !== null);
  }
}

function loaded(pack: FakePack): LoadedWorkflow {
  const handle: PackHandle = { id: pack.id, version: pack.version, digest: pack.digest, kind: 'workflow', directory: join(tmpdir(), 'circle-hub-fake-pack', pack.id) };
  const manifest: PackManifest = { schema: 'pack@1', id: pack.id, version: pack.version, kind: 'workflow', title: pack.title, description: pack.description, files: [] };
  const workflow: WorkflowFile = {
    schema: 'workflow@1',
    inputs: (pack.summary?.inputs ?? []).map((input) => ({ ...input, slot: input.slot })),
    parameters: [],
    product: { id: PRODUCT.id, catalogs: [] },
    subject: 'subject',
    projection: { module: 'functions/project.ts' },
    ...(pack.expectedSources ? { expected_sources: { module: 'functions/expected.ts' } } : {}),
  };
  const requirements: RequirementTemplate[] = (pack.summary?.requirements ?? REQUIREMENTS).map((r) => ({
    key: r.key,
    name: r.name,
    description: r.description,
    target: 'item',
    required: true,
    done_rule: r.done_rule,
    layers: r.layers,
    accepted_producer: r.accepted_producer,
    checks: [],
    error_handling: [],
  }));
  const slots: SlotsFile = { schema: 'slots@1', item: { findings: { min: 0 } }, run: {} };
  const instructions = '按规程逐条评审每个合成用例。';
  return {
    pack: handle,
    manifest,
    workflow,
    requirements,
    checks: [],
    slots,
    knowledge: null,
    instructions,
    instructionsDigest: sha(instructions),
    readJson: (path: string) => {
      throw new Error(`the fake pack has no file ${path}`);
    },
  };
}

export class FakeProducts implements Pick<PacksPort, 'products' | 'readableProducts'> {
  readonly #records: RecordsKit;
  readonly #workflows: FakeWorkflows;
  constructor(records: RecordsKit, workflows: FakeWorkflows) {
    this.#records = records;
    this.#workflows = workflows;
  }
  async products(): Promise<ProductHandle[]> {
    const product: ProductDeclaration = { schema: 'product@1', id: PRODUCT.id, title: PRODUCT.title, names: [...PRODUCT.names], catalogs: [], producers: [] };
    return [{ id: PRODUCT.id, version: '1.0.0', digest: sha('pack:line-a@1.0.0'), kind: 'product', directory: join(tmpdir(), 'circle-hub-fake-pack', PRODUCT.id), product }];
  }
  /** A user reads the lines bound by a pack assigned to them; admins read every line (R01 R[2]). */
  async readableProducts(user: Principal): Promise<ReadonlySet<string>> {
    if (await isAdmin(this.#records, user)) return new Set([PRODUCT.id]);
    const usable = await this.#workflows.usable(user);
    return new Set(usable.some((pack) => pack.summary?.products.some((name) => (PRODUCT.names as readonly string[]).includes(name))) ? [PRODUCT.id] : []);
  }
}

export class FakePackCatalog implements PackCatalogPort {
  readonly #records: RecordsKit;
  readonly #workflows: FakeWorkflows;
  constructor(records: RecordsKit, workflows: FakeWorkflows) {
    this.#records = records;
    this.#workflows = workflows;
  }
  async list(user: Principal): Promise<PackListing[]> {
    const admin = await isAdmin(this.#records, user);
    const visible = admin ? this.#workflows.packs : await this.#workflows.usable(user);
    const out: PackListing[] = [];
    for (const pack of visible) {
      const listing: PackListing = {
        id: pack.id,
        version: pack.version,
        kind: pack.kind,
        title: pack.title,
        owner: pack.owner ?? user.id,
        digest: pack.digest,
        published_at: '2026-10-01T00:00:00.000Z',
        withdrawn: false,
        active: pack.kind === 'product',
        samples: pack.kind === 'workflow' ? { author: 2 } : {},
      };
      if (admin) listing.assigned_to = await this.#records.authorizations.usersOf(pack.id);
      out.push(listing);
    }
    return out;
  }
}

export class FakeResources implements ResourceCatalogPort {
  readonly #records: RecordsKit;
  constructor(records: RecordsKit) {
    this.#records = records;
  }
  async list(user: Principal): Promise<ResourceListing[]> {
    if (!(await isAdmin(this.#records, user))) return [];
    return [
      {
        id: 'res-tracker',
        system_pack: 'tracker-system',
        name: '合成跟踪系统',
        environment: 'test',
        enabled: true,
        origins: { api: 'http://192.0.2.10:8080' },
        allow_plaintext: ['http://192.0.2.10:8080'],
      },
    ];
  }
}

// ---------------------------------------------------------------- knowledge

interface FakeNode {
  path: string;
  name: string;
  entries: { kind: EntryKind; statement: string; applicability: string; data?: Record<string, unknown> }[];
}

const TREE_1: FakeNode[] = [
  { path: '/', name: '合成产品线', entries: [] },
  { path: '/catalog', name: 'catalog', entries: [] },
  { path: '/catalog/alpha', name: 'alpha', entries: [{ kind: 'definition', statement: 'alpha <name>', applicability: '2.1', data: { params: [{ name: 'name', type: 'string' }] } }] },
  { path: '/catalog/alpha/beta', name: 'beta', entries: [{ kind: 'definition', statement: 'alpha beta <count:1-8>', applicability: '2.1' }] },
];
const TREE_2: FakeNode[] = [
  ...TREE_1.filter((node) => node.path !== '/catalog/alpha/beta'),
  { path: '/catalog/alpha/beta', name: 'beta', entries: [{ kind: 'definition', statement: 'alpha beta <count:1-16>', applicability: '2.2' }] },
  { path: '/catalog/gamma', name: 'gamma', entries: [{ kind: 'definition', statement: 'gamma', applicability: '2.2' }] },
];

export const ROOT_1 = sha('fake-root-1');
export const ROOT_2 = sha('fake-root-2');

const BUILDS: KnownBuild[] = [
  { name: 'b-2.2-1', family: 'Line A', line: '2.2', base: 'b-2.2-1', platform: null, built_at: '2026-09-20T00:00:00.000Z', released_at: '2026-09-25T00:00:00.000Z', sources: {}, root: ROOT_2 },
  { name: 'b-2.1-7', family: 'Line A', line: '2.1', base: 'b-2.1-7', platform: null, built_at: '2026-08-01T00:00:00.000Z', released_at: '2026-08-05T00:00:00.000Z', sources: {}, root: ROOT_1 },
  { name: 'LA_2.1_7', family: 'LA', line: '2.1', base: 'b-2.1-7', platform: null, built_at: '2026-08-01T00:00:00.000Z', released_at: '2026-08-06T00:00:00.000Z', sources: {}, root: ROOT_1 },
];

export class FakeKnowledge implements KnowledgePort {
  readonly #products: FakeProducts;
  readonly #trees = new Map<string, FakeNode[]>([
    [ROOT_1, TREE_1],
    [ROOT_2, TREE_2],
  ]);
  readonly script = new Script();
  constructor(products: FakeProducts) {
    this.#products = products;
  }

  async #readable(reader: Principal | ReaderIdentity): Promise<boolean> {
    const principal: Principal = 'id' in reader ? reader : { id: reader.user, name: '', role: reader.role };
    return (await this.#products.readableProducts(principal)).has(PRODUCT.id);
  }

  async builds(product: string, filter: { line?: string; released?: boolean } = {}): Promise<KnownBuild[]> {
    if (product !== PRODUCT.id) return [];
    return BUILDS.filter((b) => (filter.line === undefined || b.line === filter.line) && (filter.released === undefined || (b.released_at !== null) === filter.released));
  }
  async resolveBuild(product: string, name: string): Promise<KnownBuild | null> {
    if (product !== PRODUCT.id) return null;
    const build = BUILDS.find((b) => b.name.toLowerCase() === name.toLowerCase());
    return build === undefined ? null : (BUILDS.find((b) => b.name === build.base) ?? build);
  }
  #info(build: KnownBuild): RootInfo {
    return { root: build.root!, composition: sha(`composition:${build.name}`), product: PRODUCT.id, build, produced_at: build.released_at ?? '2026-10-01T00:00:00.000Z' };
  }
  async currentRoot(product: string, line: string): Promise<RootInfo | null> {
    const build = (await this.builds(product, { line })).find((b) => b.root !== null && b.base === b.name);
    return build === undefined ? null : this.#info(build);
  }
  async rootOfBuild(product: string, name: string): Promise<RootInfo | null> {
    const build = await this.resolveBuild(product, name);
    return build === null || build.root === null ? null : this.#info(build);
  }
  async rootInfo(root: string): Promise<RootInfo[]> {
    return BUILDS.filter((b) => b.root === root && b.base === b.name).map((b) => this.#info(b));
  }
  async catalog(): Promise<null> {
    return null;
  }

  #view(root: string, node: FakeNode, nodes: FakeNode[]): NodeViews[number] {
    const address = `tree:${root}${node.path}`;
    const prefix = node.path === '/' ? '/' : `${node.path}/`;
    const children = nodes.filter((n) => n.path !== node.path && n.path.startsWith(prefix) && !n.path.slice(prefix.length).includes('/'));
    return {
      path: node.path,
      reference: address,
      name: node.name,
      level: node.path === '/' ? 'trunk' : children.length === 0 ? 'leaf' : 'branch',
      digest: sha(`${root}${node.path}`),
      children: children.map((child) => ({ name: child.name, path: child.path, digest: sha(`${root}${child.path}`) })),
      entries: node.entries.map((entry) => {
        const digest = sha(`${root}${node.path}#${entry.statement}`);
        return { entry: digest, kind: entry.kind, statement: entry.statement, reference: `${address}@${digest}`, applicability: entry.applicability, ...(entry.data ? { data: entry.data } : {}) };
      }),
    };
  }

  async getNodes(query: NodesQuery, reader: Principal): Promise<NodesPage | null> {
    const scripted = this.script.take('getNodes');
    if (scripted !== undefined) return scripted.value as NodesPage | null;
    const nodes = this.#trees.get(query.root);
    if (nodes === undefined || !(await this.#readable(reader))) return null;
    const out: NodeViews = [];
    for (const path of query.paths) {
      const node = nodes.find((n) => n.path === path);
      if (node === undefined) return null;
      const depthOf = (p: string) => (p === '/' ? 0 : p.split('/').length - 1);
      const base = depthOf(path);
      const prefix = path === '/' ? '/' : `${path}/`;
      for (const n of nodes) {
        if ((n.path === path || n.path.startsWith(prefix)) && depthOf(n.path) - base <= query.depth && !out.some((v) => v.path === n.path)) out.push(this.#view(query.root, n, nodes));
      }
    }
    return { nodes: out, next: null, coverage: { complete: true, examined: out.length, total: out.length } };
  }

  treeReader(): TreeReader {
    const self = this;
    return {
      async read(root: string, path: string, entry: string | null, reader: ReaderIdentity): Promise<TreeRead | null> {
        const nodes = self.#trees.get(root);
        if (nodes === undefined || !(await self.#readable(reader))) return null;
        const node = nodes.find((n) => n.path === path);
        if (node === undefined) return null;
        if (entry === null) return { text: node.name, mediaType: 'text/plain', readTier: 'model_readable', grounds: [] };
        const found = node.entries.find((e) => sha(`${root}${node.path}#${e.statement}`) === entry);
        return found === undefined ? null : { text: found.statement, mediaType: 'text/plain', readTier: 'model_readable', grounds: [] };
      },
      async readEntry(entry: string, reader: ReaderIdentity): Promise<TreeRead | null> {
        if (!(await self.#readable(reader))) return null;
        for (const [root, nodes] of self.#trees) {
          for (const node of nodes) {
            const found = node.entries.find((e) => sha(`${root}${node.path}#${e.statement}`) === entry);
            if (found !== undefined) return { text: found.statement, mediaType: 'text/plain', readTier: 'model_readable', grounds: [] };
          }
        }
        return null;
      },
    };
  }

  async diffEntries(): Promise<EntryDiff | null> {
    return null;
  }

  async diffRoots(from: string, to: string): Promise<RootDiff | null> {
    const a = this.#trees.get(from);
    const b = this.#trees.get(to);
    if (a === undefined || b === undefined) return null;
    const content = (nodes: FakeNode[], path: string) => JSON.stringify(nodes.find((n) => n.path === path)?.entries ?? null);
    const pathsA = new Set(a.map((n) => n.path));
    const pathsB = new Set(b.map((n) => n.path));
    return {
      from,
      to,
      added: [...pathsB].filter((p) => !pathsA.has(p)),
      removed: [...pathsA].filter((p) => !pathsB.has(p)),
      modified: [...pathsB].filter((p) => pathsA.has(p) && content(a, p) !== content(b, p)),
    };
  }
}

// ---------------------------------------------------------------- runs

type StartOut = Untraced<z.infer<typeof StartRunOutput>>;
type SubmitOut = Untraced<z.infer<typeof SubmitResultOutput>>;
type ResolveOut = Untraced<z.infer<typeof ResolveReferenceOutput>>;

interface StoredRun {
  record: RunRecordView;
  recordDigest: string;
  submissions: RunSubmissionView[];
  results: Map<string, { record: string; result: ValidationResult }>;
  resultsBySession: Map<string, { record: string; result: ValidationResult }>;
  latest: { record: string; result: ValidationResult } | null;
  /** The result a fact-only pack computed at start_run. */
  production: ProductionResult | null;
}

/** The slot schema a fake run hands out: one list of statements per item (a compact text names `findings`). */
const FAKE_SLOT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: '评审发现（合成）',
      items: { type: 'object', properties: { text: { type: 'string', description: '发现的说明' }, code: { type: 'string' } }, required: ['text'] },
    },
  },
  required: ['findings'],
} as const;

const UNAVAILABLE: ProtocolError = unavailable();
const RUN_ID = /^run_[0-7][0-9a-hjkmnp-tv-z]{25}$/;

/** Items a fake run projects when the test does not choose its own: invented cases. */
export function defaultItems(subject: string): ItemProjection[] {
  return [
    { id: 'doc-1:n1', label: '合成用例一', location: `${subject}`, fields: { priority: 1 } },
    { id: 'doc-1:n2', label: '合成用例二', location: `${subject}`, fields: { priority: 2 } },
    { id: 'doc-1:n3', label: '合成用例三', location: `${subject}`, fields: { priority: 3 } },
  ];
}

export class FakeRuns implements RunsService {
  readonly #records: RecordsKit;
  readonly #workflows: FakeWorkflows;
  readonly #now: () => Date;
  readonly runs = new Map<string, StoredRun>();
  readonly script = new Script();
  /** The contexts the service was called with, newest last. */
  readonly contexts: CallContext[] = [];
  /** Items of the next runs; default three invented cases located in the subject input. */
  items: ((subject: string) => ItemProjection[]) | null = null;
  /** Evidence gaps startRunDetailed reports for the next runs (expected sources that could not be bound, function warnings). */
  gaps: Pick<StartRunDetail, 'unavailable' | 'gaps'> = { unavailable: [], gaps: [] };
  #counter = 0;

  constructor(records: RecordsKit, workflows: FakeWorkflows, now: () => Date) {
    this.#records = records;
    this.#workflows = workflows;
    this.#now = now;
  }

  #note(context: CallContext, reason: string): void {
    (context as { adminNote?: (reason: string) => void }).adminNote?.(reason);
  }

  #nextId(): string {
    this.#counter += 1;
    return `run_${String(this.#counter).padStart(26, '0')}`;
  }

  async startRun(user: Principal, input: z.infer<typeof StartRunInput>, context: CallContext): Promise<StartOut> {
    this.contexts.push(context);
    const scripted = this.script.take('startRun');
    if (scripted !== undefined) return scripted.value as StartOut;
    const pack = this.#workflows.find(input.pack);
    if (pack === undefined || pack.kind !== 'workflow' || !(await this.#workflows.usable(user)).includes(pack)) {
      this.#note(context, pack === undefined ? `pack ${input.pack} does not exist` : `pack ${input.pack} is not assigned to ${user.id}`);
      return { call_result: 'error', errors: [UNAVAILABLE] };
    }
    const summary = pack.summary!;
    const sources: RunSummary['sources'] = [];
    for (const [slot, value] of Object.entries(input.inputs)) {
      for (const binding of Array.isArray(value) ? value : [value]) {
        if ('reference' in binding) {
          const digest = /^src:([0-9a-f]{64})/.exec(binding.reference)?.[1];
          if (digest === undefined || (await this.#records.artifacts.readable(user, digest)) === null) {
            this.#note(context, `input ${binding.reference} is absent or not readable`);
            return { call_result: 'error', errors: [UNAVAILABLE] };
          }
          sources.push({ reference: binding.reference, role: 'subject', slot });
        } else if ('external' in binding) {
          sources.push({ reference: `src:${sha(binding.external)}`, role: 'subject', slot, external: binding.external });
        } else {
          this.#note(context, `input run ${binding.run} is absent or not readable`);
          return { call_result: 'error', errors: [UNAVAILABLE] };
        }
      }
    }
    if (sources.length === 0) {
      return { call_result: 'error', errors: [{ code: 'SUBMISSION_SCHEMA_VIOLATION', message: '缺少必填的输入 subject', fix: '按任务包的输入槽给出被评审的文档', path: '/inputs/subject' }] };
    }
    const subject = sources[0].reference;
    const run = this.#nextId();
    const instructions = '按规程逐条评审每个合成用例。';
    const record: RunRecordView = {
      run,
      pack: summary.pack,
      pack_digest: pack.digest,
      product: PRODUCT.id,
      version: '2.1',
      build: 'b-2.1-7',
      target_basis: [
        {
          statement: { text: '按包规则选定该版本线最新的已发布构建', data: { field: 'build', value: 'b-2.1-7' } },
          qualifier: { nature: 'fact', provenance: 'projected', basis_rank: 'rule_over_observation', marks: [] },
          grounds: [subject],
          warrant: { producer: 'function', id: 'latest-release@1' },
          validity: { status: 'valid', bound: [ROOT_1], premises: [] },
        },
      ],
      root: ROOT_1,
      sources,
      requirements: summary.requirements,
      items: (this.items ?? defaultItems)(subject),
      slots: { schema: JSON.parse(JSON.stringify(FAKE_SLOT_SCHEMA)) as Record<string, unknown>, sha256: sha('slots') },
      instructions,
      instructions_digest: sha(instructions),
      ...(input.predecessor === undefined ? {} : { predecessor: input.predecessor }),
      ...(context.sessionId === null ? {} : { session: context.sessionId }),
      ...(input.model_identity === undefined ? {} : { model_identity: input.model_identity }),
      started_at: this.#now().toISOString(),
      runner: user.id,
      host: 'local_circle',
      trigger: 'session',
      parameters: input.parameters ?? {},
    };
    const stored = await this.#records.store.put({ kind: 'run', schema: 'run@1', provenance: 'declared', body: record, index: [{ key: 'run.id', value: run },{key:'runs.id',value:run}] });
    const kept: StoredRun = { record, recordDigest: stored.digest, submissions: [], results: new Map(), resultsBySession: new Map(), latest: null, production: null };
    this.runs.set(run, kept);
    if (summary.requirements.every((r) => r.accepted_producer === 'fact')) kept.production = await this.#produce(kept, context);
    const { runner: _runner, host: _host, trigger: _trigger, parameters: _parameters, ...shown } = record;
    const production = kept.production;
    return { call_result: 'ok', errors: [], run: shown, ...(production !== null ? { result: { reference: production.reference, counts: production.counts } } : {}) };
  }

  /**
   * The result of a fact-only pack, computed at start_run as the engine does (its submission is the run record digest): the
   * second item has a blocking structure violation, every other item passes.
   */
  async #produce(stored: StoredRun, context: CallContext): Promise<ProductionResult> {
    const items = stored.record.items;
    const delivered = items.map((item, i) => ({
      item: item.id,
      label: item.label,
      location: item.location,
      requirements: stored.record.requirements.map((r): RequirementResult =>
        i === 1
          ? { requirement: r.key, layers: [{ layer: 'static', terminal: 'violation', code: 'core.structure.required_empty', tier: 'blocking', attribution: 'author_input' }], status: 'unsatisfied', unsatisfied_reason: 'outcome_mismatch', claims: [] }
          : { requirement: r.key, layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [] },
      ),
    }));
    const partitions = { ...(Object.fromEntries(PARTITION.map((p) => [p, []])) as unknown as Partitions), delivered } as Partitions;
    const result: ValidationResult = {
      schema: 'validation@1',
      run: stored.record.run,
      submission: stored.recordDigest,
      acceptance: 'accepted',
      errors: [],
      rounds: { used: 0, max: 0 },
      partitions,
      cross_item: [],
      coverage: { complete: true, examined: items.length, total: items.length },
      locks: { pack: stored.record.pack, pack_digest: stored.record.pack_digest, root: ROOT_1 },
      trace: context.traceId,
    };
    const record = await this.#records.store.put({ kind: 'validation_result', schema: 'validation@1', provenance: 'projected', body: result });
    stored.results.set(stored.recordDigest, { record: record.digest, result });
    stored.latest = { record: record.digest, result };
    return { reference: `rec:${record.digest}`, record: record.digest, result, counts: partitionCountsOf(partitions) };
  }

  /**
   * RunsEngine.startRunDetailed over the fake: the answer (a scripted startRun answer included), the digest of the run record,
   * the production result of a fact-only pack and the evidence gaps of `gaps`.
   */
  async startRunDetailed(user: Principal, input: z.infer<typeof StartRunInput>, context: CallContext): Promise<StartRunDetail> {
    const answer = await this.startRun(user, input, context);
    const run = answer.call_result === 'ok' ? answer.run?.run : undefined;
    const stored = run === undefined ? undefined : this.runs.get(run);
    if (stored === undefined) return { answer, production: null, runRecord: null, unavailable: [], gaps: [] };
    return { answer, production: stored.production, runRecord: stored.recordDigest, unavailable: [...(this.gaps.unavailable ?? [])], gaps: [...(this.gaps.gaps ?? [])] };
  }

  /** RunsEngine.getResult over the fake: the result of a submission by its digest, or the latest accepted one. */
  async getResult(user: Principal, run: string, submission?: string): Promise<StoredResult | null> {
    const scripted = this.script.take('getResult');
    if (scripted !== undefined) return scripted.value as StoredResult | null;
    const stored = await this.#visible(user, run);
    if (stored === null) return null;
    return submission === undefined ? stored.latest : (stored.results.get(submission) ?? null);
  }

  async #visible(user: Principal, run: string): Promise<StoredRun | null> {
    const stored = this.runs.get(run);
    if (stored === undefined) return null;
    if (stored.record.runner === user.id && (await isActive(this.#records, user))) return stored;
    return (await isAdmin(this.#records, user)) ? stored : null;
  }

  async submitResult(user: Principal, args: Record<string, unknown>, context: CallContext): Promise<SubmitOut> {
    this.contexts.push(context);
    const scripted = this.script.take('submitResult');
    if (scripted !== undefined) return scripted.value as SubmitOut;
    const runId = args.run;
    if (typeof runId !== 'string' || !RUN_ID.test(runId)) {
      return {
        call_result: 'error',
        acceptance: 'not_accepted',
        errors: [{ code: 'SUBMISSION_SCHEMA_VIOLATION', message: '提交结构或条目投影违规：run 不是运行编号', fix: '按槽位模式改正后重交', path: '/run' }],
      };
    }
    const stored = await this.#visible(user, runId);
    if (stored === null) {
      this.#note(context, `run ${runId} is absent or not visible to ${user.id}`);
      return { call_result: 'error', acceptance: 'not_accepted', errors: [UNAVAILABLE] };
    }
    let text: string;
    try {
      text = canonicalize(args);
    } catch {
      text = JSON.stringify(args);
    }
    const digest = sha(text);
    const parsed = Submission.safeParse(args);
    const effective = parsed.success ? effectiveSubmission(parsed.data,stored.record,context.sessionId) : null;
    const observer=JSON.stringify([digest,context.sessionId,effective?.model??null]);
    const repeated = stored.resultsBySession.get(observer);
    if (repeated !== undefined) return this.#answer(repeated.result);
    const received = await this.#records.store.put({ kind: 'submission', schema: parsed.success ? 'submission@1' : 'submission-received@1', provenance: 'declared', body: { ...args } });
    const base = {
      schema: 'validation@1' as const,
      run: runId,
      submission: digest,
      rounds: { used: stored.submissions.length, max: 2 },
      coverage: { complete: true, examined: stored.record.items.length, total: stored.record.items.length },
      locks: { pack: stored.record.pack, pack_digest: stored.record.pack_digest, root: ROOT_1 },
      trace: context.traceId,
    };
    const empty = Object.fromEntries(PARTITION.map((p) => [p, []])) as unknown as Partitions;
    let result: ValidationResult;
    if (!parsed.success) {
      result = {
        ...base,
        acceptance: 'not_accepted',
        errors: parsed.error.issues.slice(0, 5).map((issue) => ({
          code: 'SUBMISSION_SCHEMA_VIOLATION',
          message: `提交结构或条目投影违规：${issue.message}`,
          fix: '按槽位模式改正后重交',
          path: pointerOfPath(issue.path),
          rounds_left: 1,
        })),
        partitions: empty,
        cross_item: [],
      };
    } else if (effective === null) {
      result = { ...base, acceptance: 'not_accepted', errors: [{code:'SUBMISSION_SCHEMA_VIOLATION',message:'本次提交没有可沿用或显式声明的模型身份',fix:'本会话显式声明 model_identity，或带原先声明身份的同一 Circle 会话重交',path:'/model_identity'}], partitions: empty, cross_item: [] };
    } else if (parsed.data.notes === 'quote-mismatch') {
      result = {
        ...base,
        acceptance: 'not_accepted',
        errors: [{ code: 'QUOTE_MISMATCH', message: '原文与引用对不上', fix: '按原文逐字引用，或先调用 resolve_reference', path: '/items/0/slots', item: parsed.data.items[0]?.item, requirement: 'findings', rounds_left: 1 }],
        partitions: empty,
        cross_item: [],
      };
    } else {
      result = { ...base, acceptance: 'accepted', errors: [], partitions: this.#partition(stored.record, effective), cross_item: [] };
    }
    const resultRecord = await this.#records.store.put({ kind: 'validation_result', schema: 'validation@1', provenance: 'projected', body: result });
    stored.results.set(digest, { record: resultRecord.digest, result });
    stored.resultsBySession.set(observer, { record: resultRecord.digest, result });
    stored.submissions.push({ record: received.digest, received_at: this.#now().toISOString(), acceptance: result.acceptance, errors: result.errors, result: result.acceptance === 'accepted' ? resultRecord.digest : null });
    if (result.acceptance === 'accepted') stored.latest = { record: resultRecord.digest, result };
    return this.#answer(result);
  }

  #answer(result: ValidationResult): SubmitOut {
    if (result.acceptance === 'accepted') return { call_result: 'ok', errors: [], acceptance: 'accepted', result, counts: partitionCountsOf(result.partitions) };
    return { call_result: 'error', acceptance: 'not_accepted', errors: result.errors, result };
  }

  /** Handled items are delivered (an `unknown: true` slot leaves the static layer unchecked), skipped and uncovered ones incomplete. */
  #partition(run: RunRecord, submission: z.infer<typeof Submission> & {model:string}): Partitions {
    const parts = Object.fromEntries(PARTITION.map((p) => [p, [] as unknown[]])) as Record<string, unknown[]>;
    const due = new Date(this.#now().getTime() + 72 * 60 * 60 * 1000).toISOString();
    const exit = { action: 'request' as const, request_kind: 'repair' as const, audience: { user: (run.runner ?? run.configurer)! }, due };
    for (const item of run.items) {
      const entry = submission.items.find((i) => i.item === item.id);
      const common = { item: item.id, label: item.label, location: item.location };
      if (entry === undefined || entry.handling === 'skipped') {
        const reason = entry === undefined ? 'not_covered' : 'declared_skip';
        const requirements: RequirementResult[] = run.requirements.map((r) => ({ requirement: r.key, layers: [{ layer: 'static', terminal: 'incomplete', reason, missing: `合成条目 ${item.id} 的提交产物；下一步：补交后重核`, exit }], status: 'pending', claims: [] }));
        parts.incomplete.push({ ...common, reason, requirements });
        continue;
      }
      const slots = (entry.slots ?? {}) as { unknown?: unknown; findings?: unknown };
      const findings = Array.isArray(slots.findings) ? slots.findings : [];
      const claims: Claim[] = findings
        .filter((f): f is { text: string; code?: string } => typeof (f as { text?: unknown })?.text === 'string')
        .map((f) => ({
          item: item.id,
          requirement: 'findings',
          statement: { text: f.text, ...(typeof f.code === 'string' ? { code: f.code } : {}) },
          qualifier: { nature: 'judgment', provenance: 'declared', basis_rank: 'judgment', marks: ['semantics_unasserted'] },
          grounds: [],
          warrant: { producer: 'model', id: submission.model },
          validity: { status: 'valid', bound: [], premises: [] },
        }));
      const requirements: RequirementResult[] = [
        slots.unknown === true
          ? { requirement: 'structure', layers: [{ layer: 'static', terminal: 'unchecked', reason: 'no_check', missing: '合成结构检查的判定结果；下一步：补齐检查后重跑', exit }], status: 'pending', claims: [] }
          : { requirement: 'structure', layers: [{ layer: 'static', terminal: 'pass' }], status: 'satisfied', claims: [] },
        { requirement: 'findings', layers: [{ layer: 'static', terminal: 'judgment' }], status: 'satisfied', claims },
      ];
      parts.delivered.push({ ...common, requirements });
    }
    return parts as unknown as Partitions;
  }

  async resolveReference(user: Principal, input: z.infer<typeof ResolveReferenceInput>, context: CallContext): Promise<ResolveOut> {
    this.contexts.push(context);
    const scripted = this.script.take('resolveReference');
    if (scripted !== undefined) return scripted.value as ResolveOut;
    if (input.run !== undefined) {
      const stored = await this.#visible(user, input.run);
      if (stored === null) {
        this.#note(context, `run ${input.run} is absent or not visible to ${user.id}`);
        return { call_result: 'error', errors: [UNAVAILABLE], references: [], diagnostics: [] };
      }
      const found = stored.record.items.filter((item) => item.label.includes(input.text));
      if (found.length === 0) return { call_result: 'ok', errors: [], resolution: 'unresolved', references: [], diagnostics: [`没有找到 ${input.text}`] };
      return {
        call_result: 'ok',
        errors: [],
        resolution: found.length === 1 ? 'resolved' : 'ambiguous',
        references: found.map((item) => ({ reference: item.location, text: item.label, role: 'subject' as const })),
        diagnostics: [],
      };
    }
    if (input.text.trim().startsWith('rec:')) {
      return {
        call_result: 'error',
        errors: [{ code: 'REFERENCE_UNRESOLVED', message: 'rec: 引用和回注层条目需要运行锁定的喂入层序列', fix: '改用 start_run 启动运行并在 resolve_reference 中传入 run 参数', path: '/text' }],
        references: [],
        diagnostics: [],
      };
    }
    return {
      call_result: 'ok',
      errors: [],
      resolution: 'unresolved',
      references: [],
      diagnostics: [`没有找到 ${input.text}`],
    };
  }

  async getRun(user: Principal, run: string): Promise<RunDetail | null> {
    const scripted = this.script.take('getRun');
    if (scripted !== undefined) return scripted.value as RunDetail | null;
    const stored = await this.#visible(user, run);
    return stored === null ? null : { run: stored.record, submissions: [...stored.submissions], latest: stored.latest,
      production:stored.production === null ? null : {record:stored.production.record,result:stored.production.result} };
  }

  async listRuns(user: Principal, query: { pack?: string; limit?: number; cursor?: string | null } = {}): Promise<Page<RunRecordView>> {
    const scripted = this.script.take('listRuns');
    if (scripted !== undefined) return scripted.value as Page<RunRecordView>;
    const admin = await isAdmin(this.#records, user);
    const active = await isActive(this.#records, user);
    const all = [...this.runs.values()]
      .map((s) => s.record)
      .filter((r) => (admin || (active && r.runner === user.id)) && (query.pack === undefined || r.pack.startsWith(`${query.pack}@`) || r.pack === query.pack))
      .reverse();
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 50;
    const items = all.slice(start, start + limit);
    return { items, next: start + limit < all.length ? String(start + limit) : null };
  }
}
