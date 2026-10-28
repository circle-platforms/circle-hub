import type { Placement, ReadTier } from '../../contracts/generated/vocabulary.ts';
// Test support for hub/knowledge: a synthetic product pack written to a temporary directory with real pack functions (run
// in the sandbox), fakes of PacksPort and ExternalReaderPort, and a synthetic build site that mirrors the structure of the
// real one (index -> hub pages -> listing pages, builds of two name families, aliases, a dead link), never its content.
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProductDeclaration } from '../../contracts/src/product.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort, PackHandle, PacksPort, ProductHandle } from '../ports.ts';
import type { Limits, Principal, RecordsKit, User } from '../records/api.ts';
import {createTestParserRegistry as createDefaultRegistry} from '../testing/parsers.ts';
import { osIsolationAvailable } from '../rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../testing/records.ts';
import type { JevClient } from '../jev/api.ts';
import { createKnowledge, type Knowledge, type KnowledgeOptions } from './service.ts';

// ---------------------------------------------------------------- synthetic pack functions (pure modules, no imports)

/** Plan: index -> hub pages -> listing pages; tolerant of dead links; options.lines limits the pages it asks for. */
export const PLAN_SOURCE = `
type Read = { ok: boolean; media_type: string | null; parser: string | null; model: any; reason: string | null };
const ENTRY = /^(Rel_([A-Z]+)_(\\d+)_(\\d+)_(\\d+)) \\(build on (\\d{4}-\\d\\d-\\d\\d) (\\d\\d:\\d\\d:\\d\\d) \\):(?: based on (\\S+))?(?: Released on (\\d{4}-\\d\\d-\\d\\d))?/;
function lineOfPage(id: string): string | null {
  const m = /(\\d+)[-_](\\d+)(?:_special)?$/.exec(id);
  return m ? m[1] + '.' + m[2] : null;
}
export default function plan(input: any): unknown {
  const read: Record<string, Read> = input.read;
  const lines: string[] | null = Array.isArray(input.options?.lines) ? input.options.lines : null;
  const fetch: string[] = [];
  const builds: any[] = [];
  for (const id of Object.keys(read).sort()) {
    const page = read[id];
    if (!page.ok || page.parser !== 'html@1') continue;
    for (const link of page.model.links) {
      const href = link.href;
      if (typeof href !== 'string' || !href.endsWith('.html')) continue;
      const target = 'site:page:' + href.slice(0, -5);
      const line = lineOfPage(target);
      if (lines !== null && line !== null && !lines.includes(line)) continue;
      if (!(target in read) && !fetch.includes(target)) fetch.push(target);
    }
    for (const block of page.model.blocks) {
      const m = ENTRY.exec(block.text);
      if (m === null) continue;
      const line = m[3] + '.' + m[4];
      if (lines !== null && !lines.includes(line)) continue;
      const sources: Record<string, string> = {};
      for (const index of block.links) {
        const href = page.model.links[index].href;
        if (typeof href === 'string' && href.startsWith('tree-')) sources.tree = 'site:tree:' + href.slice(5, -4);
      }
      builds.push({
        name: m[1],
        family: m[2],
        line,
        base: m[8] ?? m[1],
        platform: null,
        built_at: m[6] + 'T' + m[7] + '.000Z',
        released_at: m[9] ? m[9] + 'T00:00:00.000Z' : null,
        sources,
      });
    }
  }
  return { fetch, builds, done: fetch.length === 0, note: input.options?.note ?? undefined };
}
`;

/** A plan that never says done: every round asks for one more page. */
export const ENDLESS_PLAN_SOURCE = `
export default function plan(input: any): unknown {
  const count = Object.keys(input.read).length;
  return { fetch: ['site:page:more-' + count, 'site:page:more-' + (count + 1)], builds: [], done: false };
}
`;

/** A plan that lists exactly the builds its options name (to hand the driver builds no listing page could spell). */
export const STATIC_PLAN_SOURCE = `
export default function plan(input: any): unknown {
  const note = input.options?.note;
  return { fetch: [], builds: input.options?.builds ?? [], done: true, ...(typeof note === 'string' ? { note } : {}) };
}
`;

/** Producer of command entries from a synthetic catalog XML: catalog > group[name] > command[name] > param[name, type, min, max]. */
export const COMMANDS_SOURCE = `
function elements(node: any): any[] { return node.children.filter((c: any) => typeof c === 'object' && c !== null); }
function steps(list: any[]): string[] {
  const counts = new Map<string, number>();
  for (const el of list) counts.set(el.name, (counts.get(el.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return list.map((el) => { const k = (seen.get(el.name) ?? 0) + 1; seen.set(el.name, k); return (counts.get(el.name) ?? 0) > 1 ? el.name + '[' + k + ']' : el.name; });
}
export default function produce(input: any): unknown {
  const slot = input.slots.tree;
  if (slot === null) return { entries: [], warnings: ['没有命令目录'] };
  const root = slot.model.root;
  const entries: any[] = [];
  const groups = elements(root);
  const groupSteps = steps(groups);
  groups.forEach((group, g) => {
    if (group.name !== 'group') return;
    const commands = elements(group);
    const commandSteps = steps(commands);
    commands.forEach((command, c) => {
      if (command.name !== 'command') return;
      const words = [group.attributes.name, ...String(command.attributes.name).split(' ')];
      const params = elements(command).filter((p) => p.name === 'param').map((p) => {
        const out: any = { name: p.attributes.name, type: p.attributes.type === 'int' ? 'int' : 'string' };
        if (p.attributes.min !== undefined) out.minimum = Number(p.attributes.min);
        if (p.attributes.max !== undefined) out.maximum = Number(p.attributes.max);
        return out;
      });
      const help = command.attributes.help ?? '';
      entries.push({
        kind: 'definition',
        path: '/commands/' + words.join('/'),
        statement: words.join(' ') + params.map((p: any) => ' <' + p.name + ':' + p.type + '>').join('') + (help ? '\\n  ' + help : ''),
        data: { words, signatures: [{ id: '1', params }], ...(help ? { summary: help } : {}) },
        fragments: [{ parser: 'xml@1', selector: ['x', root.name, groupSteps[g], commandSteps[c]].join('/') }],
        applicability: null,
      });
    });
  });
  const extra: any[] = input.params.extra ?? [];
  return { entries: [...entries, ...extra], warnings: [] };
}
`;

/**
 * Producer of manual spans: every paragraph of a markdown manual is a span the code cannot place. Like the command
 * producer it declares the kind definition (K02 R[3]), so a catalog over that kind must name its producer.
 */
export const MANUAL_SOURCE = `
export default function manual(input: any): unknown {
  const slot = input.slots.manual;
  if (slot === null) return { entries: [], unplaced: [], warnings: ['没有手册'] };
  const model = slot.model;
  const unplaced: any[] = [];
  for (const block of model.blocks) {
    if (block.kind !== 'paragraph' || block.selector === null) continue;
    unplaced.push({ fragment: { slot: 'manual', parser: 'markdown@1', selector: block.selector }, section: model.sections[block.section].title, kind: 'definition', text: block.text });
  }
  const extra: any[] = input.params.extra ?? [];
  return { entries: extra, unplaced, warnings: [] };
}
`;

/** A second producer that returns exactly what its params say (entries, unplaced spans, warnings): adversarial outputs. */
export const EXTRA_SOURCE = `
export default function extra(input: any): unknown {
  const p = input.params ?? {};
  return { entries: p.entries ?? [], unplaced: p.unplaced ?? [], warnings: p.warnings ?? [] };
}
`;

/** A producer of many large entries over the command tree: \`wide\` leaves with \`data\` bytes each, \`deep\` big statements on /big. */
export const BULK_SOURCE = `
export default function bulk(input: any): unknown {
  const p = input.params ?? {};
  const entries: any[] = [];
  const fragments = [{ parser: 'xml@1', selector: 'x/catalog' }];
  for (let i = 0; i < (p.wide ?? 0); i++) {
    entries.push({ kind: 'definition', path: '/wide/n' + String(i).padStart(3, '0'), statement: 'wide ' + i, data: { blob: 'x'.repeat(p.data ?? 0) }, fragments, applicability: null });
  }
  for (let i = 0; i < (p.deep ?? 0); i++) {
    entries.push({ kind: 'definition', path: '/big', statement: 'big ' + String(i).padStart(3, '0') + ' ' + 'y'.repeat(p.statement ?? 0), data: {}, fragments, applicability: null });
  }
  return { entries, warnings: [] };
}
`;

/** A producer over the tree source that only returns what its params say. */
export function extraProducer(
  id: string,
  params: { entries?: unknown[]; unplaced?: unknown[]; warnings?: string[] },
  inputs: Record<string, unknown> = { tree: { source: 'tree' } },
  placement?: Placement,
) {
  return { id, title: '附加生产器', function: { module: 'functions/extra.ts' }, inputs, params, ...(placement !== undefined ? { placement } : {}) };
}

/**
 * A list producer over synthetic mind maps (kityminder@1 models in input.lists.cases): every node with a non-empty
 * `resource` tag list and a priority is a case, its children are the expected results; `[cmd: <group> <command>]` in the
 * text files it under /commands/<group>/<command> (else it has no path and goes to placement); `#<digits>` in the text are
 * linked defect ids. Params: `trace` adds a warning naming the batch and its documents; `foreign` makes the first entry of
 * each batch cite that digest; a document whose root text is THROW, or a model without mind-map nodes, makes it throw.
 */
export const CASES_SOURCE = `
export default function cases(input: any): unknown {
  const p = input.params ?? {};
  const list: any[] = input.lists?.cases ?? [];
  const entries: any[] = [];
  const warnings: string[] = [];
  if (p.trace === true) warnings.push('batch ' + input.batch.index + '/' + input.batch.of + ': ' + list.map((d) => d.model.nodes[0].data.id).join(','));
  if (p.identity === true) warnings.push('identity ' + list.map((d) => (typeof d.external === 'string' ? d.external : '-')).join(','));
  const tree = input.slots?.tree;
  if (p.withTree === true && tree) warnings.push('tree ' + tree.sha256.slice(0, 8));
  for (const doc of list) {
    const model = doc.model;
    const root = model.nodes[0].data;
    if (root.text === 'THROW') throw new Error('hostile document');
    model.nodes.forEach((node: any) => {
      const data = node.data;
      if (!Array.isArray(data.resource) || data.resource.length === 0 || data.priority === undefined) return;
      const m = /\\[cmd: ([a-z][a-z0-9]*) ([a-z][a-z0-9]*)\\]/.exec(node.text);
      const expected = node.children.map((c: number) => model.nodes[c].text);
      const defects = [...String(node.text).matchAll(/#(\\d+)/g)].map((x: any) => x[1]);
      const source = p.foreign !== undefined && entries.length === 0 ? p.foreign : doc.sha256;
      entries.push({
        kind: 'case',
        path: m === null ? null : '/commands/' + m[1] + '/' + m[2],
        statement: node.text + (expected.length > 0 ? '\\n期望：' + expected.join('；') : ''),
        data: { document: String(root.id), case: String(data.id), priority: data.priority, tags: data.resource, expected, defects, has_expected: expected.length > 0, module: root.module ?? null, line: root.line ?? null },
        fragments: [{ slot: 'cases', source, parser: 'kityminder@1', selector: node.selector }],
        applicability: null,
      });
    });
  }
  return { entries, warnings };
}
`;

/** The list producer of synthetic cases: the `cases` role of a build, in batches of `batch`. */
export function casesProducer(options: { batch?: number; optional?: boolean; params?: Record<string, unknown>; withTree?: boolean } = {}) {
  const cases = { source: 'cases', many: true, ...(options.batch === undefined ? {} : { batch: options.batch }), ...(options.optional === undefined ? {} : { optional: options.optional }) };
  return {
    id: 'cases',
    title: '用例',
    function: { module: 'functions/cases.ts' },
    inputs: options.withTree === true ? { cases, tree: { source: 'tree' } } : { cases },
    params: { ...(options.params ?? {}), ...(options.withTree === true ? { withTree: true } : {}) },
  };
}

export interface SyntheticCase {
  id: string;
  text: string;
  priority?: number;
  resource?: string[];
  expected?: string[];
}

export interface SyntheticCorpus {
  /** Command catalogs of two builds: the second changes the range of some commands. */
  catalogA: string;
  catalogB: string;
  /** Paths of the commands the second catalog changes (computed here, independently of the Hub). */
  changedPaths: string[];
  documents: Array<{ id: string; json: string }>;
  /** Every case with the command path it is filed under. */
  cases: Array<{ document: string; id: string; path: string; module: string; defects: string[] }>;
}

/**
 * A deterministic corpus for scale checks: `groups` x `commands` commands (`g<k> c<k>`, one int parameter), `documents`
 * mind maps of `cases` cases each, every case on one command spread over the catalog, a defect id on every tenth case;
 * the second catalog changes the range of `changed` commands spread evenly.
 */
export function syntheticCorpus(options: { documents: number; cases: number; groups: number; commands: number; changed: number }): SyntheticCorpus {
  const pad = (n: number, width: number): string => String(n).padStart(width, '0');
  const names: Array<{ group: string; command: string }> = [];
  for (let g = 0; g < options.groups; g++) for (let c = 0; c < options.commands; c++) names.push({ group: `g${pad(g, 3)}`, command: `c${pad(c, 4)}` });
  const step = Math.max(1, Math.floor(names.length / Math.max(1, options.changed)));
  const changed = new Set<number>();
  for (let k = 0; k < options.changed && k * step < names.length; k++) changed.add(k * step);
  const catalog = (b: boolean): string => {
    const groups: Record<string, Array<{ name: string; params: Array<{ name: string; type: 'int'; min: number; max: number }>; help: string }>> = {};
    names.forEach((n, i) => {
      (groups[n.group] ??= []).push({ name: n.command, params: [{ name: 'value', type: 'int', min: 0, max: b && changed.has(i) ? 900 : 600 }], help: `set ${n.command}` });
    });
    return catalogXml(groups);
  };
  const documents: SyntheticCorpus['documents'] = [];
  const cases: SyntheticCorpus['cases'] = [];
  for (let d = 0; d < options.documents; d++) {
    const id = `d${pad(d, 5)}`;
    const module = `M${d % 10}`;
    const list: SyntheticCase[] = [];
    for (let c = 0; c < options.cases; c++) {
      const target = names[(d * options.cases + c) * 7919 % names.length];
      const defects = (d + c) % 10 === 0 ? [String(60000 + ((d * 31 + c) % 500))] : [];
      const caseId = `${id}-${pad(c, 3)}`;
      list.push({
        id: caseId,
        text: `[cmd: ${target.group} ${target.command}] 用例 ${d}-${c} 检查取值${defects.map((x) => ` #${x}`).join('')}`,
        expected: c % 4 === 0 ? [] : [`返回 ${c}`, ...(c % 3 === 0 ? [`日志 ${c}`] : [])],
      });
      cases.push({ document: id, id: caseId, path: `/commands/${target.group}/${target.command}`, module, defects });
    }
    documents.push({ id: `store:mindmap:${id}`, json: mindMap({ id, module, line: '1.2' }, list) });
  }
  return { catalogA: catalog(false), catalogB: catalog(true), changedPaths: [...changed].map((i) => `/commands/${names[i].group}/${names[i].command}`).sort(), documents, cases };
}

/** A synthetic KityMinder mind map: the document root, one group node, the cases with their expected results. */
export function mindMap(doc: { id: string; text?: string; module?: string; line?: string }, cases: readonly SyntheticCase[]): string {
  const node = (c: SyntheticCase) => ({
    data: { id: c.id, text: c.text, priority: c.priority ?? 1, resource: c.resource ?? ['功能'] },
    children: (c.expected ?? []).map((text, k) => ({ data: { id: `${c.id}-e${k}`, text }, children: [] })),
  });
  const root = { id: doc.id, text: doc.text ?? `文档 ${doc.id}`, ...(doc.module === undefined ? {} : { module: doc.module }), ...(doc.line === undefined ? {} : { line: doc.line }) };
  return JSON.stringify({ root: { data: root, children: [{ data: { id: `${doc.id}-g`, text: '分组', priority: 1 }, children: cases.map(node) }] }, template: 'default', theme: 'fresh-blue', version: '1.4.43' });
}

export interface PackSpec {
  id?: string;
  version?: string;
  names?: string[];
  /** Product declaration overrides (producers, catalogs, sync). */
  declaration?: Record<string, unknown>;
  /** Files under functions/, by file name. */
  functions?: Record<string, string>;
}

export const DEFAULT_PRODUCERS = [{ id: 'commands', title: '命令目录', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } }];
export const DEFAULT_CATALOGS = [{ id: 'catalog@1', entry_kind: 'definition', producer: 'commands', complete: true, case_sensitive: false }];
export const DEFAULT_SYNC = { start: ['site:page:index'], plan: { module: 'functions/plan.ts' }, max_rounds: 6, max_reads: 50 };

/** Writes a synthetic product pack into a fresh real directory and returns its handle. */
export function writeProductPack(root: string, spec: PackSpec = {}): ProductHandle {
  const id = spec.id ?? 'acme';
  const version = spec.version ?? '1.0.0';
  const directory = realpathSync(mkdtempSync(join(root, `pack-${id}-`)));
  const functions = { 'plan.ts': PLAN_SOURCE, 'commands.ts': COMMANDS_SOURCE, 'manual.ts': MANUAL_SOURCE, 'extra.ts': EXTRA_SOURCE, 'bulk.ts': BULK_SOURCE, 'cases.ts': CASES_SOURCE, ...(spec.functions ?? {}) };
  for (const [name, source] of Object.entries(functions)) {
    const path = join(directory, 'functions', name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }
  const declaration = ProductDeclaration.parse({
    schema: 'product@1',
    id,
    title: '合成产品',
    names: spec.names ?? ['ACME', 'ZETA'],
    sync: DEFAULT_SYNC,
    catalogs: DEFAULT_CATALOGS,
    producers: DEFAULT_PRODUCERS,
    ...(spec.declaration ?? {}),
  });
  writeFileSync(join(directory, 'product.json'), JSON.stringify(declaration, null, 2));
  const digest = createHash('sha256').update(JSON.stringify({ id, version, declaration, functions })).digest('hex');
  return { id, version, digest, kind: 'product', directory, product: declaration };
}

// ---------------------------------------------------------------- fakes of the ports

export class FakePacks implements PacksPort {
  readonly handles = new Map<string, ProductHandle>();
  /** user id -> product line ids readable through an assigned pack. */
  readonly readers = new Map<string, Set<string>>();
  /** Withdrawn id@version strings (test-only): pack() answers null for them (a withdrawn publication). */
  readonly withdrawn = new Set<string>();

  add(handle: ProductHandle): void {
    this.handles.set(handle.product.id, handle);
  }

  /** Test-only: withdraw a version the way an owner's delisting does; pack() then answers null. */
  withdraw(id: string, version: string): boolean {
    this.withdrawn.add(`${id}@${version}`);
    return true;
  }

  async pack(ref: string): Promise<PackHandle | null> {
    if (this.withdrawn.has(ref)) return null;
    for (const handle of this.handles.values()) if (ref === handle.id || ref === `${handle.id}@${handle.version}`) return handle;
    return null;
  }

  async productByName(name: string): Promise<ProductHandle | null> {
    const folded = name.toLowerCase();
    for (const handle of this.handles.values()) if (handle.product.names.some((n) => n.toLowerCase() === folded)) return handle;
    return null;
  }

  async productById(id: string): Promise<ProductHandle | null> {
    return this.handles.get(id) ?? null;
  }

  async products(): Promise<ProductHandle[]> {
    return [...this.handles.values()];
  }

  async readableProducts(user: Principal): Promise<ReadonlySet<string>> {
    if (user.role === 'admin') return new Set(this.handles.keys());
    return this.readers.get(user.id) ?? new Set();
  }
}

export type FakeObject =
  | { bytes: string | Uint8Array; mediaType: string; readTier?: Extract<ReadTier, 'model_readable' | 'function_bytes_only'>; personal?: boolean }
  | { fail: string };

/** An external reader over in-memory objects: a read stores the bytes as a connector read with a shared credential. */
export class FakeExternal implements ExternalReaderPort {
  readonly objects = new Map<string, FakeObject>();
  readonly reads: string[] = [];
  readonly #kit: RecordsKit;
  /** Throws instead of answering for these ids (a broken adapter). */
  readonly throwing = new Set<string>();

  constructor(kit: RecordsKit) {
    this.#kit = kit;
  }

  set(id: string, object: FakeObject): void {
    this.objects.set(id, object);
  }

  async accepts(id: string): Promise<boolean> {
    return /^site:|^store:/.test(id);
  }

  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    if (this.throwing.has(id)) throw new Error('synthetic adapter failure');
    const object = this.objects.get(id);
    if (object === undefined) return { ok: false, id, reason: 'HTTP 404' };
    if ('fail' in object) return { ok: false, id, reason: object.fail };
    const bytes = typeof object.bytes === 'string' ? new TextEncoder().encode(object.bytes) : object.bytes;
    const artifact = await this.#kit.artifacts.ingest({
      bytes,
      mediaType: object.mediaType,
      origin: { read: { object: id } },
      author: { user: null },
      provenanceType: 'observed',
      // A personal credential: only the person who read it (B02 R[3]); a shared credential: admins.
      visibility: object.personal ? { readers: [context.principal.id], admins: false, packs: [], shareable: false } : { readers: [], admins: true, packs: [], shareable: false },
      ...(object.readTier ? { readTier: object.readTier } : {}),
    });
    return { ok: true, id, revision: null, artifacts: [{ name: 'original', artifact }], manifest: 'synthetic' };
  }
}

// ---------------------------------------------------------------- synthetic build site

export interface SiteBuild {
  name: string;
  built: string;
  released?: string;
  basedOn?: string;
  tree?: boolean;
}

export function listingPage(title: string, builds: SiteBuild[]): string {
  const rows = builds.map((b) => {
    const based = b.basedOn ? ` based on ${b.basedOn}` : '';
    const released = b.released ? ` Released on <font color=red>${b.released}</font>` : '';
    const tree = b.tree ? ` <a href=tree-${b.name}.xml>command tree</a>` : '';
    return `<p>${b.name} (build on ${b.built} ):${based}${released}${tree}</p>`;
  });
  return `<html><head><title>${title}</title></head><body><h1>${title}</h1>\n${rows.join('\n')}\n</body></html>`;
}

export function linkPage(title: string, hrefs: string[]): string {
  return `<html><head><title>${title}</title></head><body>${hrefs.map((h) => `<p><a href=${h}>${h}</a></p>`).join('\n')}</body></html>`;
}

/** A synthetic command catalog: groups of commands with typed parameters. */
export function catalogXml(groups: Record<string, Array<{ name: string; params?: Array<{ name: string; type: 'int' | 'string'; min?: number; max?: number }>; help?: string }>>): string {
  const body = Object.entries(groups)
    .map(([group, commands]) => {
      const inner = commands
        .map((c) => {
          const params = (c.params ?? []).map((p) => `<param name="${p.name}" type="${p.type}"${p.min === undefined ? '' : ` min="${p.min}"`}${p.max === undefined ? '' : ` max="${p.max}"`}/>`).join('');
          return `<command name="${c.name}"${c.help ? ` help="${c.help}"` : ''}>${params}</command>`;
        })
        .join('');
      return `<group name="${group}">${inner}</group>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><catalog>${body}</catalog>`;
}

export const BASE_CATALOG = {
  system: [
    { name: 'reboot', params: [{ name: 'delay', type: 'int' as const, min: 0, max: 600 }], help: 'restart the unit' },
    { name: 'show', params: [], help: 'show the state' },
  ],
  net: [
    { name: 'ping', params: [{ name: 'host', type: 'string' as const }], help: 'send echo requests' },
    { name: 'trace', params: [{ name: 'host', type: 'string' as const }], help: 'trace the route' },
  ],
};

/** The standard synthetic site: two lines, two name families, an alias by 'based on', an own-tree alias by name, a dead link. */
export function standardSite(external: FakeExternal): void {
  const html = 'text/html; charset=ISO-8859-1';
  external.set('site:page:index', { bytes: linkPage('index', ['hub-1-3.html', 'rel_acme_1_2.html', 'rel_zeta_1_2.html']), mediaType: html });
  external.set('site:page:hub-1-3', { bytes: linkPage('hub 1.3', ['rel_acme_1_3.html', 'rel_zeta_1_3.html', 'rel_acme_1_3_special.html']), mediaType: html });
  external.set('site:page:rel_acme_1_2', {
    bytes: listingPage('rel_acme_1_2', [
      { name: 'Rel_ACME_1_2_15', built: '2026-01-02 10:00:00', released: '2026-01-05', tree: true },
      { name: 'Rel_ACME_1_2_16', built: '2026-01-09 10:00:00', tree: true },
    ]),
    mediaType: html,
  });
  external.set('site:page:rel_zeta_1_2', {
    bytes: listingPage('rel_zeta_1_2', [{ name: 'Rel_ZETA_1_2_7', built: '2026-01-06 11:00:00', released: '2026-01-07', basedOn: 'Rel_ACME_1_2_15' }]),
    mediaType: html,
  });
  external.set('site:page:rel_acme_1_3', {
    bytes: listingPage('rel_acme_1_3', [{ name: 'Rel_ACME_1_3_20', built: '2026-02-01 09:00:00', released: '2026-02-03', tree: true }]),
    mediaType: html,
  });
  external.set('site:page:rel_zeta_1_3', {
    bytes: listingPage('rel_zeta_1_3', [{ name: 'Rel_ZETA_1_3_20', built: '2026-02-01 09:30:00', released: '2026-02-04', tree: true }]),
    mediaType: html,
  });
  // rel_acme_1_3_special is linked but missing: a dead link (HTTP 404).
  const xml = 'application/xml';
  external.set('site:tree:Rel_ACME_1_2_15', { bytes: catalogXml(BASE_CATALOG), mediaType: xml });
  external.set('site:tree:Rel_ACME_1_2_16', { bytes: catalogXml({ ...BASE_CATALOG, net: [...BASE_CATALOG.net, { name: 'arp', params: [] }] }), mediaType: xml });
  const v13 = catalogXml({ ...BASE_CATALOG, system: [...BASE_CATALOG.system, { name: 'upgrade', params: [{ name: 'image', type: 'string' }] }] });
  external.set('site:tree:Rel_ACME_1_3_20', { bytes: v13, mediaType: xml });
  // The own tree of the other family's build of the newest line: one byte differs (a trailing space), the content is equal.
  external.set('site:tree:Rel_ZETA_1_3_20', { bytes: `${v13} `, mediaType: xml });
}

// ---------------------------------------------------------------- one test's world

export interface World {
  kit: TestRecordsKit;
  admin: User;
  user: User;
  outsider: User;
  packs: FakePacks;
  external: FakeExternal;
  knowledge: Knowledge;
  product: ProductHandle;
  dir: string;
  close(): Promise<void>;
}

let isolation: boolean | undefined;

export async function sandboxIsolation(): Promise<boolean> {
  isolation ??= await osIsolationAvailable();
  return isolation;
}

export async function makeWorld(
  postgres: TemporaryPostgres,
  options: { pack?: PackSpec; jev?: JevClient | null; now?: () => Date; knowledge?: Partial<KnowledgeOptions>; records?: { limits?: Partial<Limits> } } = {},
): Promise<World> {
  const kit = await openTestRecords({ postgres, ...(options.now ? { now: options.now } : {}), ...(options.records?.limits ? { limits: options.records.limits } : {}) });
  const { user: admin } = await kit.principals.bootstrapAdmin('admin');
  const user = await kit.principals.createUser(admin, 'reader');
  const outsider = await kit.principals.createUser(admin, 'outsider');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hub-knowledge-')));
  const product = writeProductPack(dir, options.pack);
  const packs = new FakePacks();
  packs.add(product);
  packs.readers.set(user.id, new Set([product.product.id]));
  const external = new FakeExternal(kit);
  const knowledge = createKnowledge({
    records: kit,
    parsers: createDefaultRegistry(),
    packs,
    external,
    jev: options.jev ?? null,
    sandbox: { requireOsIsolation: await sandboxIsolation() },
    ...(options.now ? { clock: options.now } : {}),
    admin,
    ...(options.knowledge ?? {}),
  });
  return {
    kit,
    admin,
    user,
    outsider,
    packs,
    external,
    knowledge,
    product,
    dir,
    close: async () => {
      await kit.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export { startPostgres };

/** A synthetic product-wide document beside a released build on line 10.6. */
export async function makeUnversionedWorld(postgres: TemporaryPostgres, versioned = false, scopeOptions: {entries?:number;statementBytes?:number} = {}): Promise<World> {
  const build = { name: 'Synthetic_10_6', base: 'Synthetic_10_6', family: 'ACME', line: '10.6', platform: null, built_at: null, released_at: '2026-10-24T00:00:00.000Z', sources: { tree: 'site:tree:synthetic' } };
  const w = await makeWorld(postgres, { pack: { functions: {
    'plan.ts': `export default input => ({fetch:[],builds:[${JSON.stringify(build)}],...(input.options.scope === false ? {} : {scope:{docs:'site:tree:scope'}}),done:true});`,
    'scope.ts': `export default input => ({entries:${JSON.stringify(Array.from({length:scopeOptions.entries??1},(_,i)=>({path:'/docs',kind:'case',statement:scopeOptions.statementBytes?'x'.repeat(scopeOptions.statementBytes):'合成用例',data:{document:i===0?'synthetic-document':'synthetic-document-'+i,module:i===0?'network':'network-'+i,defects:['61061']},fragments:[{slot:'docs',parser:'xml@1',selector:'x/catalog'}],applicability:null})))},warnings:[]});`,
  }, declaration: { sync:{...DEFAULT_SYNC,options:{scope:!versioned}}, producers: [...DEFAULT_PRODUCERS, {id:'docs',title:'文档',unversioned:!versioned,function:{module:'functions/scope.ts'},inputs:{docs:versioned?{external:'site:tree:scope'}:{source:'docs'}}}] } } });
  w.external.set('site:tree:synthetic',{bytes:catalogXml(BASE_CATALOG),mediaType:'application/xml'});
  w.external.set('site:tree:scope',{bytes:'<catalog/>',mediaType:'application/xml'});
  await w.knowledge.syncProduct(w.product);
  return w;
}
