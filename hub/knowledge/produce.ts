// Producing the root of one build (K01, K02, K04): read each declared source through the external reader in an admin
// context, parse it with the core parser for its media type, run each producer function in the sandbox, validate its
// output, verify every entry (kind, storable text, fragments, path), place what code could not place with the
// typed-judgment model, build the nodes bottom-up, write nodes (sharing every subtree that already exists), entries, the
// composition record and the generate action in one transaction. Every body is checked against its schema before it is
// written. A failure writes a generate action with the reason and nothing else; only a build whose own identity cannot be
// stored (checked first) is refused without one.
import type { CompositionBasis, CompositionRow, RefusedEntry, RootCatalog, RootSource, TreeRootBody, UnplacedRow } from '../../contracts/src/knowledge.ts';
import { MAX_KEPT_PROBLEMS } from '../../contracts/src/knowledge.ts';
import { ENTRY_KIND, isEntryKind, labelOf, type EntryKind } from '../../contracts/generated/vocabulary.ts';
import { BuildInfo, ProducerOutput, expandTemplate } from '../../contracts/src/product.ts';
import type { KnownBuild, Producer, ProducerInput, TemplateVariable } from '../../contracts/src/product.ts';
import { CatalogEntry } from '../../contracts/src/tables.ts';
import type { ProductHandle } from '../ports.ts';
import type { ActionBody, Principal } from '../records/api.ts';
import { pathOf } from '../refs/api.ts';
import { SANDBOX_ERRORS, SandboxError, callPackFunction } from '../rules/api.ts';
import { PLACEMENT_CHAIN } from './calibration.ts';
import { requireAdmin, type KnowledgeContext } from './context.ts';
import { canonicalSize, compareText, cutText, entryContentOf, entryDigest, type EntryContent } from './digest.ts';
import { describeError } from './errors.ts';
import { MAX_DESCRIPTION, type PlacementChild, type PlacementOutcome, type PlacementSpan } from './placement.ts';
import { SourceLoader, type ParsedSource } from './sources.ts';
import { ACTION, COMPONENTS, INDEX, buildKey, buildProblem, type ProduceDetail } from './store.ts';
import { TreeBuilder, flatten, type BuiltNode } from './tree.ts';
import { checkPath, verifyFragment } from './verify.ts';

/** Longest warning, refusal reason or failure reason kept (characters). */
const MAX_PROBLEM_TEXT = 1000;
const MAX_REASON_TEXT = 2000;

const ENTRY_KINDS_TEXT = ENTRY_KIND.map((kind) => `${kind} ${labelOf('entry_kind', kind)}`).join('、');

export interface ProduceInput {
  product: ProductHandle;
  build: KnownBuild;
  /** The admin whose context reads the sources; default the service's admin. */
  by?: Principal | null;
  /** The sync this production belongs to. */
  sync?: string | null;
  /** A loader shared by the builds of one sync, so a source several builds use is read once. */
  loader?: SourceLoader;
  signal?: AbortSignal;
}

export interface ProduceResult {
  ok: boolean;
  build: string;
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
  entries: number;
  placedByModel: number;
  unplaced: number;
  refused: RefusedEntry[];
  refusedCount: number;
  warnings: string[];
}

/** A source a producer reads, with the basis that decides it belongs to the version. */
export interface PlannedSource {
  producer: string;
  slot: string;
  external: string | null;
  optional: boolean;
  basis: CompositionBasis;
  /** Why no external id could be formed (only when external is null). */
  problem: string | null;
}

/** The declared sources of every producer for one build. */
export function plannedSources(product: ProductHandle, build: BuildInfo): PlannedSource[] {
  const out: PlannedSource[] = [];
  const values: Partial<Record<TemplateVariable, string>> = { product: product.product.id, line: build.line, build: build.name, base: build.base, family: build.family };
  if (build.platform !== null) values.platform = build.platform;
  for (const producer of product.product.producers) {
    for (const [slot, source] of Object.entries(producer.inputs)) {
      const optional = source.optional === true;
      if ('source' in source) {
        const external = Object.hasOwn(build.sources, source.source) ? build.sources[source.source] : null;
        out.push({
          producer: producer.id,
          slot,
          external,
          optional,
          basis: build.released_at !== null ? 'release_record' : 'declared',
          problem: external === null ? `构建 ${build.name} 没有 ${source.source} 来源` : null,
        });
      } else {
        try {
          out.push({ producer: producer.id, slot, external: expandTemplate(source.external, values), optional, basis: 'declared', problem: null });
        } catch (error) {
          out.push({ producer: producer.id, slot, external: null, optional, basis: 'declared', problem: `来源模板 ${source.external} 填不出：${(error as Error).message}` });
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

interface Collected {
  content: EntryContent & { kind: EntryKind };
  digest: string;
  producer: string;
  fragments: string[];
  slots: string[];
}

function pushProblem<T>(list: T[], item: T): void {
  if (list.length < MAX_KEPT_PROBLEMS) list.push(item);
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

export async function produceTree(context: KnowledgeContext, input: ProduceInput): Promise<ProduceResult> {
  const startedAt = context.now().toISOString();
  const { product } = input;
  const build = input.build;
  const by = await requireAdmin(context, input.by, '生产知识树');
  const pack = { id: product.id, version: product.version, digest: product.digest };
  const decidedBy = `${product.id}@${product.version}`;
  const lineProduct = product.product.id;
  const sync = input.sync ?? null;
  const warnings: string[] = [];
  let warningsCount = 0;
  const warn = (text: string): void => {
    warningsCount++;
    pushProblem(warnings, cutText(text, MAX_PROBLEM_TEXT));
  };
  const refused: RefusedEntry[] = [];
  let refusedCount = 0;
  // Refusals per producer and declared kind, all of them (not only the kept ones): catalogs count their own.
  const refusedOf = new Map<string, Map<string, number>>();
  const refuse = (item: RefusedEntry): void => {
    refusedCount++;
    const kinds = refusedOf.get(item.producer) ?? new Map<string, number>();
    kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
    refusedOf.set(item.producer, kinds);
    pushProblem(refused, { ...item, kind: cutText(item.kind, 200), path: item.path === null ? null : cutText(item.path, MAX_PROBLEM_TEXT), reason: cutText(item.reason, MAX_PROBLEM_TEXT) });
  };
  const usedSources: ProduceDetail['sources'] = [];
  const missing: ProduceDetail['missing'] = [];
  const result = (partial: Partial<ProduceResult>): ProduceResult => ({
    ok: false,
    build: build.name,
    root: null,
    composition: null,
    action: null,
    reason: null,
    sources: usedSources,
    nodes: 0,
    created: 0,
    entries: 0,
    placedByModel: 0,
    unplaced: 0,
    refused,
    refusedCount,
    warnings,
    ...partial,
  });

  // The build's own identity goes into every record of the production, the failure included: it is checked first.
  const parsedInfo = BuildInfo.safeParse({
    name: build.name,
    family: build.family,
    line: build.line,
    base: build.base,
    platform: build.platform,
    built_at: build.built_at,
    released_at: build.released_at,
    sources: build.sources,
  });
  if (!parsedInfo.success) return result({ reason: '构建信息不符合 build-info@1，没有生产，也没有记录' });
  const info = parsedInfo.data;
  const unrecordable = buildProblem(lineProduct, info);
  if (unrecordable !== null) return result({ reason: `${unrecordable}；没有生产，也没有记录` });

  const fail = async (reason: string): Promise<ProduceResult> => {
    const text = cutText(reason, MAX_REASON_TEXT);
    const action = await writeProduceAction(context, { startedAt, sync, product: lineProduct, pack, info, root: null, composition: null, sources: usedSources, missing, placement: null, reason: text }, null);
    return result({ reason: text, action });
  };

  if (build.base !== build.name) return fail(`构建 ${build.name} 是 ${build.base} 的别名，没有自己的树`);
  if (product.product.producers.length === 0) return fail('产品包没有声明生产器');
  const loader = input.loader ?? new SourceLoader({ external: context.external, artifacts: context.records.artifacts, parsers: context.parsers }, by, 'knowledge sync');
  const cap = context.limits.maxBuildBytes;

  // Sources: read, check and parse every declared source once.
  const planned = plannedSources(product, info);
  const parsed = new Map<string, ParsedSource>();
  const slotsOf = new Map<string, Map<string, ParsedSource | null>>();
  const sourceRows: RootSource[] = [];
  let bytes = 0;
  for (const source of planned) {
    if (input.signal?.aborted) return fail('同步被中止');
    const slots = slotsOf.get(source.producer) ?? new Map<string, ParsedSource | null>();
    slotsOf.set(source.producer, slots);
    if (source.external === null) {
      if (source.optional) {
        warn(`${source.producer}.${source.slot}：${source.problem}（可选，跳过）`);
        slots.set(source.slot, null);
        missing.push({ producer: source.producer, slot: source.slot, external: null });
        continue;
      }
      return fail(`${source.producer}.${source.slot}：${source.problem}`);
    }
    let loaded = parsed.get(source.external);
    if (loaded === undefined) {
      const read = await loader.read(source.external);
      if (!read.ok) {
        if (source.optional) {
          warn(`${source.producer}.${source.slot}：${source.external} ${read.reason}（可选，跳过）`);
          slots.set(source.slot, null);
          missing.push({ producer: source.producer, slot: source.slot, external: source.external });
          continue;
        }
        return fail(`${source.producer}.${source.slot}：${source.external} ${read.reason}`);
      }
      const size = read.artifact.body.size;
      if (bytes + size > cap) {
        return fail(`构建的来源合计超过每个构建 ${cap} 字节的上限：已读 ${bytes} 字节，源文件 ${read.artifact.body.sha256}（${source.external}）还有 ${size} 字节`);
      }
      const readable = await loader.readable(read, cap - bytes);
      if (!readable.ok) return fail(readable.reason);
      const parse = loader.parse(readable.value);
      if (!parse.ok) return fail(parse.reason);
      loaded = parse.value;
      bytes += loaded.size;
      parsed.set(source.external, loaded);
    }
    slots.set(source.slot, loaded);
    usedSources.push({ producer: source.producer, slot: source.slot, external: source.external, sha256: loaded.sha256 });
    sourceRows.push({
      producer: source.producer,
      slot: source.slot,
      external: source.external,
      revision: loaded.revision,
      sha256: loaded.sha256,
      size: loaded.size,
      media_type: loaded.mediaType,
      parser: loaded.parser,
      artifact: loaded.artifact.digest,
      read_tier: loaded.readTier,
      basis: source.basis,
      decided_by: decidedBy,
    });
  }
  const basisOf = new Map<string, CompositionBasis>();
  for (const source of planned) if (source.external !== null) basisOf.set(`${source.producer}\u0000${source.slot}`, source.basis);

  // Producers.
  const placedEntries: Array<Collected & { segments: string[] }> = [];
  const toPlace: Array<Collected & { section: string }> = [];
  const contents = new Map<string, EntryContent>();
  for (const producer of product.product.producers) {
    if (input.signal?.aborted) return fail('同步被中止');
    const slots = slotsOf.get(producer.id) ?? new Map<string, ParsedSource | null>();
    const output = await runProducer(context, product, producer, { build: { ...info, root: build.root }, slots, params: producer.params ?? {} });
    if (!output.ok) return fail(output.reason);
    for (const warning of output.value.warnings) warn(`${producer.id}：${warning}`);
    const collect = (entry: { kind: string; statement: string; data: Record<string, unknown>; applicability: EntryContent['applicability'] }, fragments: ProducerOutput['entries'][number]['fragments']): Collected | string => {
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
      if (Buffer.byteLength(content.statement, 'utf8') > context.limits.maxStatementBytes) return `陈述超过 ${context.limits.maxStatementBytes} 字节`;
      if (canonicalSize(content.data) > context.limits.maxDataBytes) return `结构化数据超过 ${context.limits.maxDataBytes} 字节`;
      const references: string[] = [];
      const slotNames: string[] = [];
      for (const fragment of fragments) {
        const verified = verifyFragment(fragment, slots, loader);
        if (!verified.ok) return verified.reason;
        if (!references.includes(verified.value.reference)) references.push(verified.value.reference);
        slotNames.push(verified.value.slot);
      }
      return { content: { ...content, kind: entry.kind }, digest, producer: producer.id, fragments: references, slots: slotNames };
    };
    output.value.entries.forEach((entry, index) => {
      let segments: string[] | null = null;
      if (entry.path !== null) {
        const path = checkPath(entry.path);
        if (!path.ok) {
          refuse({ producer: producer.id, index, unplaced: false, kind: entry.kind, path: entry.path, reason: path.reason });
          return;
        }
        segments = path.value.segments;
      }
      const collected = collect(entry, entry.fragments);
      if (typeof collected === 'string') {
        refuse({ producer: producer.id, index, unplaced: false, kind: entry.kind, path: entry.path, reason: collected });
        return;
      }
      contents.set(collected.digest, collected.content);
      if (segments === null) toPlace.push({ ...collected, section: '' });
      else placedEntries.push({ ...collected, segments });
    });
    (output.value.unplaced ?? []).forEach((span, index) => {
      const collected = collect({ kind: span.kind, statement: span.text, data: { section: span.section }, applicability: null }, [span.fragment]);
      if (typeof collected === 'string') {
        refuse({ producer: producer.id, index, unplaced: true, kind: span.kind, path: null, reason: collected });
        return;
      }
      contents.set(collected.digest, collected.content);
      toPlace.push({ ...collected, section: span.section });
    });
  }
  if (placedEntries.length === 0 && toPlace.length === 0) {
    return fail(refusedCount > 0 ? `生产器的 ${refusedCount} 个条目都没有通过核对，没有可以挂树的内容` : '生产器没有产出任何条目');
  }

  // Code placement, then the typed-judgment model for the rest.
  const builder = new TreeBuilder();
  for (const entry of placedEntries) builder.add(entry.segments, entry.digest);
  const spans: PlacementSpan[] = toPlace.map((entry) => ({ key: entry.digest, text: entry.content.statement, section: entry.section, fragment: entry.fragments[0] }));
  let outcomes = new Map<string, PlacementOutcome>();
  let placement: ProduceDetail['placement'] = null;
  if (spans.length > 0) {
    const model = context.placer.model;
    const threshold = model === null ? null : await context.calibration.threshold(PLACEMENT_CHAIN, model);
    outcomes = await context.placer.place(spans, placementTree(builder, contents), { threshold, context: { product: lineProduct, build: build.name }, onProblem: (text) => warn(`归类：${text}`) });
    // Recorded so that a later sync places again when the judge failed or the chain's calibration changed.
    placement = { model, threshold, spans: outcomes.size, failed: [...outcomes.values()].filter((o) => o.failed).length };
  }
  const modelPlaced = new Map<string, Map<string, PlacementOutcome>>();
  for (const entry of toPlace) {
    const outcome = outcomes.get(entry.digest);
    if (outcome === undefined || !outcome.placed) continue;
    builder.add(outcome.segments, entry.digest);
    const path = pathOf(outcome.segments);
    const at = modelPlaced.get(path) ?? new Map<string, PlacementOutcome>();
    at.set(entry.digest, outcome);
    modelPlaced.set(path, at);
  }

  const root = builder.build();
  const nodes = flatten(root);

  // Composition rows: one per (path, entry), producers and fragments merged in order, the basis over every slot.
  const rows = new Map<string, { row: CompositionRow; producers: Set<string>; slots: Set<string> }>();
  const addRow = (path: string, entry: Collected, placed: PlacementOutcome | undefined): void => {
    const key = `${path}\u0000${entry.digest}`;
    let held = rows.get(key);
    if (held === undefined) {
      const row: CompositionRow = { path, entry: entry.digest, kind: entry.content.kind, producers: [], fragments: [], basis: 'declared', decided_by: decidedBy };
      if (placed !== undefined && placed.model !== null && placed.p !== null && placed.threshold !== null) {
        row.placement = { model: placed.model, p: placed.p, threshold: placed.threshold, judgments: placed.judgments, note: cutText(placed.note, MAX_PROBLEM_TEXT) };
      }
      held = { row, producers: new Set(), slots: new Set() };
      rows.set(key, held);
    }
    held.producers.add(entry.producer);
    for (const slot of entry.slots) held.slots.add(`${entry.producer}\u0000${slot}`);
    for (const fragment of entry.fragments) if (!held.row.fragments.includes(fragment)) held.row.fragments.push(fragment);
  };
  for (const entry of placedEntries) addRow(pathOf(entry.segments), entry, undefined);
  for (const entry of toPlace) {
    const outcome = outcomes.get(entry.digest);
    if (outcome !== undefined && outcome.placed) addRow(pathOf(outcome.segments), entry, outcome);
  }
  const composition = [...rows.values()]
    .map(({ row, producers, slots }) => ({ ...row, producers: [...producers].sort(compareText), basis: basisOver(slots, basisOf) }))
    .sort((a, b) => compareText(a.path, b.path) || compareText(a.entry, b.entry));

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
          note: cutText(outcome?.note ?? '没有归类', MAX_PROBLEM_TEXT),
        },
        producers: new Set(),
        slots: new Set(),
      };
      lost.set(entry.digest, held);
    }
    held.producers.add(entry.producer);
    for (const slot of entry.slots) held.slots.add(`${entry.producer}\u0000${slot}`);
    for (const fragment of entry.fragments) if (!held.row.fragments.includes(fragment)) held.row.fragments.push(fragment);
  }
  const unplacedRows = [...lost.values()]
    .map(({ row, producers, slots }) => ({ ...row, producers: [...producers].sort(compareText), basis: basisOver(slots, basisOf) }))
    .sort((a, b) => compareText(a.entry, b.entry));

  const catalogs = rootCatalogs(product, composition, unplacedRows, refusedOf, contents);

  // Write everything of the root in one transaction; existing subtrees are shared. A write the store refuses (a body over
  // the record limit, a record that does not match its schema) fails the build like any other failure.
  if (input.signal?.aborted) return fail('同步被中止');
  const producedAt = context.now().toISOString();
  let written: { created: number; composition: string; action: string; body: TreeRootBody };
  try {
    written = await context.writes.run(() => context.store.records.withTransaction(async (tx) => {
      let created = 0;
      const ensure = async (node: BuiltNode): Promise<void> => {
        if (await context.store.hasNode(node.digest, tx)) return;
        for (const child of node.built) await ensure(child);
        for (const entry of node.entries) {
          if (!(await context.store.hasEntryFor(lineProduct, entry, tx))) await context.store.putEntry(lineProduct, entry, contents.get(entry) as EntryContent, tx);
        }
        await context.store.putNode(node, tx);
        created++;
      };
      await ensure(root);
      for (const row of unplacedRows) {
        if (!(await context.store.hasEntryFor(lineProduct, row.entry, tx))) await context.store.putEntry(lineProduct, row.entry, contents.get(row.entry) as EntryContent, tx);
      }
      const body: TreeRootBody = {
        product: lineProduct,
        version: { line: info.line, build: info.name, family: info.family, platform: info.platform },
        build: info,
        root: root.digest,
        producer: {
          pack: product.id,
          version: product.version,
          digest: product.digest,
          id: decidedBy,
          producers: product.product.producers.map((p: Producer) => ({ id: p.id, function: p.function })),
        },
        sources: sourceRows,
        composition,
        unplaced: unplacedRows,
        refused,
        refused_count: refusedCount,
        catalogs,
        counts: { nodes: nodes.length, entries: composition.length, placed_by_model: composition.filter((row) => row.placement !== undefined).length, unplaced: unplacedRows.length },
        warnings,
        warnings_count: warningsCount,
        produced_at: producedAt,
      };
      const record = await context.store.putRoot(body, tx);
      const action = await writeProduceAction(context, { startedAt, sync, product: lineProduct, pack, info, root: root.digest, composition: record.digest, sources: usedSources, missing, placement, reason: null }, tx);
      return { created, composition: record.digest, action, body };
    }));
  } catch (error) {
    return fail(`写入知识树时出错：${describeError(error)}`);
  }
  return result({
    ok: true,
    root: root.digest,
    composition: written.composition,
    action: written.action,
    nodes: nodes.length,
    created: written.created,
    entries: composition.length,
    placedByModel: written.body.counts.placed_by_model,
    unplaced: unplacedRows.length,
  });
}

/**
 * The catalogs of the root. Members are the entries of the declared kind, of the declared producer when the catalog names
 * one; a declared-complete catalog stays complete only when no such entry was refused, left unplaced or lacks catalog data.
 */
function rootCatalogs(
  product: ProductHandle,
  composition: CompositionRow[],
  unplaced: UnplacedRow[],
  refusedOf: ReadonlyMap<string, ReadonlyMap<string, number>>,
  contents: Map<string, EntryContent>,
): RootCatalog[] {
  return product.product.catalogs.map((catalog) => {
    const ours = (producers: readonly string[]): boolean => catalog.producer === undefined || producers.includes(catalog.producer);
    const rows = composition.filter((row) => row.kind === catalog.entry_kind && ours(row.producers));
    const invalid = rows.filter((row) => catalogData(contents.get(row.entry)?.data ?? {}) === null).length;
    const lost = unplaced.filter((row) => row.kind === catalog.entry_kind && ours(row.producers)).length;
    let refusedHere = 0;
    for (const [producer, kinds] of refusedOf) if (ours([producer])) refusedHere += kinds.get(catalog.entry_kind) ?? 0;
    const reasons: string[] = [];
    if (rows.length === 0) reasons.push(`没有${catalog.producer === undefined ? '' : `生产器 ${catalog.producer} 的`} ${catalog.entry_kind} 种类的条目`);
    if (invalid > 0) reasons.push(`${invalid} 个条目没有可用的目录数据`);
    if (lost > 0) reasons.push(`${lost} 个条目没能挂树`);
    if (refusedHere > 0) reasons.push(`${refusedHere} 个条目没有通过核对`);
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

type ProducerRun = { ok: true; value: ProducerOutput } | { ok: false; reason: string };

async function runProducer(context: KnowledgeContext, product: ProductHandle, producer: Producer, input: { build: KnownBuild; slots: Map<string, ParsedSource | null>; params: Record<string, unknown> }): Promise<ProducerRun> {
  const slots: ProducerInput['slots'] = {};
  for (const [slot, source] of input.slots) {
    slots[slot] = source === null ? null : { sha256: source.sha256, media_type: source.mediaType, parser: source.parser, model: source.document.model };
  }
  const payload: ProducerInput = { build: input.build, slots, params: input.params };
  let output: unknown;
  try {
    const run = await callPackFunction(
      { packDir: product.directory, module: producer.function.module, export: producer.function.export },
      payload,
      context.sandbox.producer,
      { requireOsIsolation: context.sandbox.requireOsIsolation },
    );
    output = run.output;
  } catch (error) {
    if (error instanceof SandboxError) return { ok: false, reason: `生产器 ${producer.id} 运行失败：${SANDBOX_ERRORS[error.code]}` };
    return { ok: false, reason: `生产器 ${producer.id} 运行失败：${describeError(error)}` };
  }
  const parsed = ProducerOutput.safeParse(output);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, reason: `生产器 ${producer.id} 的输出不符合 producer-output@1：${issue === undefined ? '' : `${issue.path.join('/')} ${issue.message}`}` };
  }
  return { ok: true, value: parsed.data };
}

interface ProduceActionInput {
  startedAt: string;
  sync: string | null;
  product: string;
  pack: { id: string; version: string; digest: string };
  info: BuildInfo;
  root: string | null;
  composition: string | null;
  sources: ProduceDetail['sources'];
  missing: ProduceDetail['missing'];
  placement: ProduceDetail['placement'];
  reason: string | null;
}

/** The generate action of one production (completed) or of its failure (error), indexed for the build and the root. */
export async function writeProduceAction(context: KnowledgeContext, input: ProduceActionInput, tx: Parameters<KnowledgeContext['store']['putAction']>[2] | null): Promise<string> {
  const detail: ProduceDetail = {
    sync: input.sync,
    product: input.product,
    pack: input.pack,
    build: input.info,
    root: input.root,
    composition: input.composition,
    sources: input.sources,
    missing: input.missing,
    placement: input.placement,
    reason: input.reason,
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
    error_code: null,
    acceptance: null,
    codes: [],
    detail: detail as unknown as Record<string, unknown>,
  };
  const index = [
    { key: INDEX.produce, value: buildKey(input.product, input.info.name) },
    { key: INDEX.produceProduct, value: input.product },
    ...(input.root === null ? [] : [{ key: INDEX.produceRoot, value: input.root }]),
    ...(input.sync === null ? [] : [{ key: INDEX.sync, value: input.sync }]),
  ];
  const record = await context.store.putAction(body, index, tx ?? undefined);
  return record.digest;
}
