// Tiny synthetic packs for the assembly's tests, written into temporary directories with a correct pack.json (the runs
// package's pack builder): a workflow pack over KityMinder mind maps (a fact requirement with a structure check and a
// judgment requirement with a membership check, each check with a positive and a negative sample), the connectors'
// synthetic agile and build-site system packs, and a product pack whose sync walks the synthetic build site and whose
// producer reads its command trees. Every name and text is invented; nothing here is product content.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGILE_FUNCTIONS, BUILDSITE_FUNCTIONS, FUNCTIONS_DIR, agileSystem, buildSiteFiles, buildSiteSystem, commandTree, type StaticFile } from '../../connectors/testing/api.ts';
import { writePack, type PackDescription } from '../../runs/api.ts';

export const REVIEW_PACK = 'demo-check';
export const AGILE_PACK = 'demo-agile';
export const SITE_PACK = 'demo-site';
export const PRODUCT_PACK = 'demo';
export const XML_PACK = 'xml-format';
/** The product line's names: the build site lists builds under both. */
export const PRODUCT_NAMES = ['DEMO', 'ALT'];

// ---------------------------------------------------------------- workflow pack

const PROJECT_SOURCE = `// Synthetic projection: a case is a node with a non-empty resource tag list; its children are its expected results.
interface Node { id: string | null; text: string; data: Record<string, unknown>; children: number[]; parent: number | null; selector: string }
interface Bound { slot: string; external: string | null; parser: string; model: { nodes?: Node[] } | null }

export default function project(input: unknown): unknown {
  const inputs = ((input as { inputs?: Bound[] }).inputs ?? []) as Bound[];
  const subject = inputs.find((i) => i.slot === 'map');
  if (subject === undefined || subject.parser !== 'kityminder@1' || subject.model === null || !Array.isArray(subject.model.nodes)) {
    return { error: { code: 'demo-check.invalid_input', message: '被检查的不是脑图', fix: '给一份 KityMinder 脑图' }, warnings: [] };
  }
  const nodes = subject.model.nodes;
  const external = typeof subject.external === 'string' ? subject.external : '';
  const document = external.split(':')[2] ?? nodes[0]?.id ?? 'doc';
  const items: unknown[] = [];
  nodes.forEach((node, index) => {
    const tags = Array.isArray(node.data.resource) ? node.data.resource.filter((t): t is string => typeof t === 'string') : [];
    if (tags.length === 0) return;
    const path: string[] = [];
    for (let p = node.parent; p !== null; p = nodes[p].parent) path.unshift(nodes[p].text);
    items.push({
      id: document + ':' + (node.id ?? '@' + index),
      label: node.text,
      summary: node.children.length + ' 个期望结果',
      location: { parser: 'kityminder@1', selector: node.selector },
      fields: { path, title: node.text, tags, expected: node.children.map((c) => nodes[c].text) },
    });
  });
  if (items.length === 0) return { error: { code: 'demo-check.no_case', message: '文档里没有用例节点', fix: '给用例节点加上 resource 标签' }, warnings: [] };
  return { items, warnings: [] };
}
`;

export function reviewPack(version = '1.0.0'): PackDescription {
  return {
    id: REVIEW_PACK,
    version,
    kind: 'workflow',
    title: '合成用例检查',
    description: '装配测试用的合成工作流包',
    files: {
      'workflow.json': {
        schema: 'workflow@1',
        inputs: [{ slot: 'map', role: 'subject', description: '被检查的脑图', accepts: ['application/json', 'agile:mindmap'], required: true, many: false }],
        parameters: [],
        product: { catalogs: [] },
        subject: 'map',
        projection: { module: 'functions/project.ts' },
      },
      'requirements.json': {
        schema: 'requirements@1',
        requirements: [
          {
            key: 'titles',
            name: '标题与期望',
            description: '每个用例有标题和至少一个期望结果',
            target: 'item',
            required: true,
            done_rule: 'gating',
            layers: ['static'],
            accepted_producer: 'fact',
            checks: ['titles'],
            error_handling: [],
          },
          {
            key: 'notes',
            name: '检查意见',
            description: '对每个用例的意见',
            target: 'item',
            required: false,
            done_rule: 'bookkeeping',
            layers: ['static'],
            accepted_producer: 'judgment',
            checks: ['codes'],
            error_handling: [],
          },
        ],
      },
      'checks.json': {
        schema: 'checks@1',
        checks: [
          { id: 'titles', interpreter: 'structure@1', table: 'tables/titles.json', applies: 'run', judges: 'subject', tier: 'blocking' },
          { id: 'codes', interpreter: 'membership@1', table: 'tables/codes.json', applies: 'item', judges: 'artifact_under_verification', tier: 'advisory' },
        ],
      },
      'slots.schema.json': {
        schema: 'slots@1',
        item: {
          notes: {
            codes: [
              { code: 'gap', label: '缺口' },
              { code: 'typo', label: '错字' },
            ],
            min: 0,
          },
        },
        run: {},
      },
      'SKILL.md': '# 合成用例检查\n\n逐个用例给出意见，没有意见时给空列表。\n',
      'functions/project.ts': PROJECT_SOURCE,
      'tables/titles.json': {
        schema: 'structure@1',
        origin: '决定：合成测试包 demo-check 的 titles 要求项',
        tier: 'blocking',
        basis: '要求项 titles：每个用例有标题和至少一个期望结果',
        nodes: '$.items[*]',
        item: '/id',
        location: '/location',
        rules: [
          {
            fields: [
              { path: '/fields/title', required: true, type: 'string' },
              { path: '/fields/expected', required: true, type: 'array', minItems: 1, items: { required: true, type: 'string' } },
            ],
          },
        ],
      },
      'tables/codes.json': {
        schema: 'membership@1',
        origin: '决定：合成测试包 demo-check 的意见码来自声明的集合',
        item: '/item',
        values: ['$.slots.notes[*].code'],
        set: { name: 'notes.codes' },
      },
      'samples/positive/titles-good.json': {
        id: 'titles_good',
        source: 'author',
        check: 'titles',
        subject: { items: [{ id: 'a', fields: { title: '标题', expected: ['结果'] } }] },
        expect: [{ verdict: 'support', item: 'a' }],
      },
      'samples/negative/titles-bad.json': {
        id: 'titles_bad',
        source: 'author',
        check: 'titles',
        subject: {
          items: [
            { id: 'a', fields: { title: '', expected: ['结果'] } },
            { id: 'b', fields: { title: '有', expected: ['结果'] } },
          ],
        },
        expect: [
          { verdict: 'refute', code: 'core.structure.required_empty', item: 'a' },
          { verdict: 'support', item: 'b' },
        ],
      },
      'samples/positive/codes-good.json': {
        id: 'codes_good',
        source: 'author',
        check: 'codes',
        subject: { item: 'x', slots: { notes: [{ code: 'gap' }] } },
        expect: [{ verdict: 'support', item: 'x' }],
      },
      'samples/negative/codes-bad.json': {
        id: 'codes_bad',
        source: 'author',
        check: 'codes',
        subject: { item: 'x', slots: { notes: [{ code: 'other' }] } },
        expect: [{ verdict: 'refute', code: 'core.membership.not_in_set', item: 'x' }],
      },
    },
  };
}

export const LOCATE_PACK = 'demo-locate';
export const DOCS_PACK = 'demo-docs';

const DOCS_PROJECT = `// Synthetic projection for the named-documents tests: the bound named document is a JSON object
// { items: [{ title, expected }] }; each item becomes a case.
interface DocItem { title?: unknown; expected?: unknown }
export default function project(input: unknown): unknown {
  const inputs = ((input as { inputs?: Array<{ slot: string; model: { items?: DocItem[] } | null }> }).inputs ?? []);
  const spec = inputs.find((i) => i.slot === 'spec');
  const items = Array.isArray(spec?.model?.items) ? (spec?.model?.items as DocItem[]) : [];
  if (items.length === 0) return { error: { code: 'demo-docs.no_items', message: '文档里没有条目', fix: '给一份带 items 数组的 JSON 文档' }, warnings: [] };
  return {
    items: items.map((item, index) => ({
      id: 'doc-item-' + (index + 1),
      label: String(item.title ?? ''),
      summary: (Array.isArray(item.expected) ? item.expected.length : 0) + ' 个期望结果',
      location: { parser: 'json@1', selector: 'p/items/' + index + '/title' },
      fields: { title: typeof item.title === 'string' ? item.title : '', expected: Array.isArray(item.expected) ? item.expected : [] },
    })),
    warnings: [],
  };
}
`;

/**
 * A workflow pack over named documents (the C4 tests): like locatePack but its subject is a `doc:doc` external
 * object, parsed with the core JSON parser; the same fact requirement, check, table and samples.
 */
export function docsPack(version = '1.0.0'): PackDescription {
  const base = locatePack(version);
  const files = { ...(base.files as PackDescription['files']) };
  files['workflow.json'] = {
    schema: 'workflow@1',
    inputs: [{ slot: 'spec', role: 'subject', description: '被检查的命名文档', accepts: ['doc:doc'], required: true, many: false }],
    parameters: [],
    product: { catalogs: [] },
    subject: 'spec',
    projection: { module: 'functions/project.ts' },
  };
  files['functions/project.ts'] = DOCS_PROJECT;
  return { ...base, id: DOCS_PACK, title: '合成命名文档检查', description: '命名文档测试用的合成工作流包，输入是命名文档', files };
}

/**
 * The review pack with its fact requirement only (titles), so that start_run computes the result itself (a production run):
 * the same projection, check, table and samples, no slots.
 */
export function locatePack(version = '1.0.0'): PackDescription {
  const review = reviewPack(version);
  const requirements = (review.files['requirements.json'] as { requirements: { key: string }[] }).requirements.filter((r) => r.key === 'titles');
  const checks = (review.files['checks.json'] as { checks: { id: string }[] }).checks.filter((c) => c.id === 'titles');
  const files: Record<string, unknown> = { ...review.files };
  for (const path of ['tables/codes.json', 'samples/positive/codes-good.json', 'samples/negative/codes-bad.json']) delete files[path];
  return {
    ...review,
    id: LOCATE_PACK,
    title: '合成用例定位',
    description: '装配测试用的合成工作流包，只有事实要求项',
    files: {
      ...(files as PackDescription['files']),
      'requirements.json': { schema: 'requirements@1', requirements },
      'checks.json': { schema: 'checks@1', checks },
      'slots.schema.json': { schema: 'slots@1', item: {}, run: {} },
      'SKILL.md': '# 合成用例定位\n\n结果由 Hub 在 start_run 时算出；提交只用来补充评论。\n',
    },
  };
}

// ---------------------------------------------------------------- system packs (the connectors' synthetic systems)

async function functionFiles(names: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) out[`functions/${name}`] = await readFile(new URL(name, FUNCTIONS_DIR), 'utf8');
  return out;
}

export async function agilePack(version = '1.0.0'): Promise<PackDescription> {
  return {
    id: AGILE_PACK,
    version,
    kind: 'system',
    title: '合成敏捷测试平台',
    description: '装配测试用的合成系统包',
    files: { 'system.json': agileSystem(), ...(await functionFiles(AGILE_FUNCTIONS)) },
  };
}

export async function sitePack(version = '1.0.0'): Promise<PackDescription> {
  return {
    id: SITE_PACK,
    version,
    kind: 'system',
    title: '合成构建站',
    description: '装配测试用的合成系统包',
    files: { 'system.json': buildSiteSystem(), ...(await functionFiles(BUILDSITE_FUNCTIONS)) },
  };
}

// ---------------------------------------------------------------- product pack

const PLAN_SOURCE = `// Synthetic sync plan: index -> hub pages -> listing pages of the synthetic build site; tolerant of dead links.
const ENTRY = /^(Rel_([A-Z]+)_(\\d+)_(\\d+)_(\\d+)_(\\d+))\\s+\\(build on\\s+(\\d{4}-\\d\\d-\\d\\d) (\\d\\d:\\d\\d:\\d\\d)\\s*\\):\\s*(?:based on (\\S+)\\s*)?(?:Released on (\\d{4}-\\d\\d-\\d\\d))?/;

export default function plan(input: any): unknown {
  const read = input.read ?? {};
  const lines: string[] | null = Array.isArray(input.options?.lines) ? input.options.lines : null;
  const fetch: string[] = [];
  const builds: any[] = [];
  const seen = new Set<string>();
  for (const id of Object.keys(read).sort()) {
    const page = read[id];
    if (!page.ok || page.parser !== 'html@1' || page.model === null) continue;
    const links: { href: string | null }[] = page.model.links ?? [];
    const trees = new Set<string>();
    for (const link of links) {
      const href = link.href;
      if (typeof href !== 'string') continue;
      if (/^[a-z0-9_]+\\.html$/.test(href)) {
        const target = 'buildsite:listing:' + href;
        if (!(target in read) && !fetch.includes(target)) fetch.push(target);
      }
      const tree = /^builds\\/([A-Za-z0-9_]+)\\/command_tree-/.exec(href);
      if (tree !== null) trees.add(tree[1]);
    }
    for (const block of page.model.blocks ?? []) {
      for (const text of String(block.text).split('\\n')) {
        const m = ENTRY.exec(text.trim());
        if (m === null || seen.has(m[1])) continue;
        const line = m[3] + '.' + m[4] + '.' + m[5];
        if (lines !== null && !lines.includes(line)) continue;
        seen.add(m[1]);
        builds.push({
          name: m[1],
          family: m[2],
          line,
          base: m[9] ?? m[1],
          platform: null,
          built_at: m[7] + 'T' + m[8] + '.000Z',
          released_at: m[10] ? m[10] + 'T00:00:00.000Z' : null,
          sources: trees.has(m[1]) ? { tree: 'buildsite:command-tree:' + m[1] } : {},
        });
      }
    }
  }
  return { fetch, builds, done: fetch.length === 0 };
}
`;

const COMMANDS_SOURCE = `// Synthetic producer: commands > scope > menu[name] > item[name] > arguments > arg, one definition entry per item.
type El = { name: string; attributes: Record<string, string>; children: Array<El | string> };
const elements = (node: El): El[] => node.children.filter((c): c is El => typeof c === 'object' && c !== null);
function steps(list: El[]): string[] {
  const counts = new Map<string, number>();
  for (const el of list) counts.set(el.name, (counts.get(el.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return list.map((el) => {
    const k = (seen.get(el.name) ?? 0) + 1;
    seen.set(el.name, k);
    return (counts.get(el.name) ?? 0) > 1 ? el.name + '[' + k + ']' : el.name;
  });
}

export default function produce(input: any): unknown {
  const slot = input.slots?.tree;
  if (!slot || !slot.model || !slot.model.root) return { entries: [], warnings: ['没有命令树'] };
  const root: El = slot.model.root;
  const entries: unknown[] = [];
  const scopes = elements(root);
  const scopeSteps = steps(scopes);
  scopes.forEach((scope, s) => {
    if (scope.name !== 'scope') return;
    const menus = elements(scope);
    const menuSteps = steps(menus);
    menus.forEach((menu, m) => {
      if (menu.name !== 'menu') return;
      const items = elements(menu);
      const itemSteps = steps(items);
      items.forEach((item, i) => {
        if (item.name !== 'item') return;
        const words = [...String(menu.attributes.name ?? '').split(' '), ...String(item.attributes.name ?? '').split(' ')].filter((w) => w !== '');
        if (words.length === 0) return;
        const args = elements(item).filter((e) => e.name === 'arguments').flatMap((a) => elements(a)).filter((e) => e.name === 'arg');
        const params = args.map((arg) => {
          const limit = /^\\[(\\d+) - (\\d+)\\]$/.exec(arg.attributes.limit ?? '');
          const type = limit !== null ? 'int' : 'string';
          return { name: arg.attributes.name ?? 'value', type, ...(limit !== null ? { minimum: Number(limit[1]), maximum: Number(limit[2]) } : {}), ...(arg.attributes.optional === 'true' ? { optional: true } : {}) };
        });
        const help = item.attributes.help ?? '';
        entries.push({
          kind: 'definition',
          path: '/commands/' + words.join('/'),
          statement: words.join(' ') + params.map((p) => ' <' + p.name + '>').join('') + (help ? '\\n  ' + help : ''),
          data: { words, signatures: [{ id: '1', params }], ...(help ? { summary: help } : {}) },
          fragments: [{ parser: 'xml@1', selector: ['x', root.name, scopeSteps[s], menuSteps[m], itemSteps[i]].join('/') }],
          applicability: null,
        });
      });
    });
  });
  return { entries, warnings: [] };
}
`;

const NOTES_SOURCE = `// Synthetic producer: one defect entry per scope, always without a path, for the no-placement tests.
type El = { name: string; attributes: Record<string, string>; children: Array<El | string> };
const elements = (node: El): El[] => node.children.filter((c): c is El => typeof c === 'object' && c !== null);

export default function produce(input: any): unknown {
  const slot = input.slots?.tree;
  if (!slot || !slot.model || !slot.model.root) return { entries: [], warnings: ['没有命令树'] };
  const root: El = slot.model.root;
  const scopes = elements(root).filter((el) => el.name === 'scope');
  const entries: unknown[] = scopes.map((scope, index) => ({
    kind: 'defect',
    path: null,
    statement: '合成发布说明条目 ' + String(scope.attributes.name ?? index),
    data: {},
    fragments: [{ parser: 'xml@1', selector: ['x', root.name, scopes.length > 1 ? 'scope[' + (index + 1) + ']' : 'scope'].join('/') }],
    applicability: null,
  }));
  return { entries, warnings: [] };
}
`;

export function productPack(version = '1.0.0', options: { unplaced?: boolean } = {}): PackDescription {
  return {
    id: PRODUCT_PACK,
    version,
    kind: 'product',
    title: '合成产品线',
    description: '装配测试用的合成产品包',
    files: {
      'product.json': {
        schema: 'product@1',
        id: PRODUCT_PACK,
        title: '合成产品线',
        names: PRODUCT_NAMES,
        sync: { start: ['buildsite:listing:index.html'], plan: { module: 'functions/plan.ts' }, max_rounds: 6, max_reads: 50 },
        catalogs: [{ id: 'commands@1', entry_kind: 'definition', producer: 'commands', complete: true, case_sensitive: false }],
        producers: [
          { id: 'commands', title: '命令树', function: { module: 'functions/commands.ts' }, inputs: { tree: { source: 'tree' } } },
          // A producer that declares its path-less entries placeable by the bot; the Hub never places them itself.
          ...(options.unplaced === true
            ? [{ id: 'notes', title: '发布说明', function: { module: 'functions/notes.ts' }, inputs: { tree: { source: 'tree' } }, placement: 'judgment_allowed' }]
            : []),
        ],
      },
      'functions/plan.ts': PLAN_SOURCE,
      'functions/commands.ts': COMMANDS_SOURCE,
      ...(options.unplaced === true ? { 'functions/notes.ts': NOTES_SOURCE } : {}),
    },
  };
}

/**
 * The synthetic build site for the sync tests: the connectors' site, the newer unreleased build's tree with one command
 * more (so two produced roots differ), and a released build on the older line whose listed command tree does not exist
 * (its production fails).
 */
export function syncSiteFiles(): Record<string, StaticFile> {
  const files = buildSiteFiles();
  const newer = 'Rel_DEMO_2_1_0_6';
  const tree = commandTree(newer).replace('    </menu>', '      <item name="reset" help="reset every widget"/>\n    </menu>');
  files[`/builds/${newer}/command_tree-${newer}.xml`] = { body: Buffer.from(tree, 'utf8'), type: 'application/xml' };
  // A released build of the 2.1.0 line with no tree of its own and no base text: known by name only.
  const bare = 'Rel_DEMO_2_1_0_7';
  const listing = files['/rel_demo_2_1.html'];
  listing.body = Buffer.concat([
    listing.body,
    Buffer.from(
      `<html><body>${bare} (build on  2025-08-01 09:00:00 ): <font color=red>Released on 2025-08-03</font><br></body></html>`,
      'latin1',
    ),
  ]);
  const missing = 'Rel_DEMO_2_0_0_9';
  files['/rel_demo_2_0.html'] = {
    body: Buffer.from(
      `<html><body>${missing} (build on  2025-06-01 09:00:00 ): <font color=red>Released on 2025-06-03</font><br>` +
        `<a href=builds/${missing}/command_tree-${missing}.xml>command_tree-${missing}.xml</a><br></body></html>`,
      'latin1',
    ),
    type: 'text/html; charset=ISO-8859-1',
  };
  return files;
}

/** Writes the packs under `root` and returns their directories by pack id. */
export async function writeTestPacks(root: string): Promise<Record<'review' | 'agile' | 'site' | 'product' | 'xml' | 'html', string>> {
  const xmlSource = fileURLToPath(new URL('../../../packs/skill/xml-format/', import.meta.url));
  const xmlManifest = JSON.parse(await readFile(join(xmlSource, 'pack.json'), 'utf8'));
  const xmlFiles: Record<string, Uint8Array> = {};
  for (const row of xmlManifest.files) xmlFiles[row.path] = await readFile(join(xmlSource, row.path));
  const xmlStaged = await writePack(join(root, 'xml-format'), { ...xmlManifest, files: xmlFiles });
  const htmlSource = fileURLToPath(new URL('../../../packs/skill/html-format/', import.meta.url));
  const htmlManifest = JSON.parse(await readFile(join(htmlSource, 'pack.json'), 'utf8'));
  const htmlFiles: Record<string, Uint8Array> = {};
  for (const row of htmlManifest.files) htmlFiles[row.path] = await readFile(join(htmlSource, row.path));
  const htmlStaged = await writePack(join(root, 'html-format'), { ...htmlManifest, files: htmlFiles });
  return {
    review: (await writePack(join(root, REVIEW_PACK), reviewPack())).dir,
    agile: (await writePack(join(root, AGILE_PACK), await agilePack())).dir,
    site: (await writePack(join(root, SITE_PACK), await sitePack())).dir,
    product: (await writePack(join(root, PRODUCT_PACK), productPack())).dir,
    xml: xmlStaged.dir,
    html: htmlStaged.dir,
  };
}
