// What a model reads in the knowledge text files of a run download (knowledge/<top node>.txt) and copies quotes from. The Hub
// checks a quote against the text its reference resolves to, byte for byte (quote@1: an exact contiguous substring; for
// tree:<root>/<path>@<entry> that text is the entry's statement, hub/knowledge/read.ts), so every line the model may copy has to
// be the statement's own line: whatever the download adds for the reader (the reference, the conditions) goes on a line of its
// own. Run 34's writer copied «· Demo(config)#sdns dnssec keygen …» out of manual.txt, bullet included, and the Hub refused the
// quote. The order of the lines is the one the Hub's export lists (a node's entries by kind, statement and digest, hub/knowledge/
// read.ts #entriesAt: the tree records no document order); the download must not reorder or regroup them.
// The files are written by the real download tools of both packs against a synthetic Hub; the quote checks are the real ones
// (hub/refs verifyQuote and the rules interpreter quote@1) over the text the real reference resolution returns.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { createDefaultRegistry, resolveReference, verifyQuote, type TreeReader } from '../../../../hub/refs/api.ts';
import { getInterpreter, type CheckRequest } from '../../../../hub/rules/api.ts';
import { authoringBrief, canonicalPath, nodeBlock, type BriefNode } from '../functions/authoring-brief.ts';
import { SUBAGENT_ROLES } from '../functions/subagent-roles.ts';
import { main as caseCompileMain } from './download-run.ts';
import { main as recomposeMain } from '../recompose/tools/download-run.ts';

const RUN = 'run_01m7jde17f2037dgmgtwmt3zd3';
const TOKEN = 'synthetic-token-1234';
const ROOT = createHash('sha256').update('synthetic root of the knowledge text test').digest('hex');
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');

interface SyntheticEntry { kind: 'behaviour' | 'definition'; statement: string; applicability?: string; fragments?: string[] }
interface SyntheticNode { path: string; children: string[]; entries: SyntheticEntry[] }

/** One paragraph of a manual: long, mixed Chinese and ASCII, full-width punctuation and a bold markup run inside quotation marks. */
const PARAGRAPH = [
  '在设备中，SDNS动态域名负责处理A、AAAA、CNAME、MX和DNSKEY类型的DNS解析请求，如果请求的动态域名不存在或者请求为动态域名的其他类型，则交给全域名解析功能负责处理。',
  '使用全域名解析功能前需要启用SDNS功能（通过命令“**sdns on**”）。',
  ...Array.from({ length: 24 }, (_, i) => `第${i + 1}条说明：合成手册句，用来把这一段拉长到一千字以上，包含 ASCII 词 weight、policy、pool，也包含全角标点“”（）；以及星号 * 与下划线 _name_。`),
].join('');

// The lines of an example block in the order the manual gives them, which is not their dictionary order: keygen zsk comes before
// keygen ksk, and `show` comes between the lines that start with `sdns`.
const EXAMPLE = [
  'sdns dnssec keygen www.example.com zsk',
  'sdns dnssec keygen www.example.com ksk',
  'show sdns dnssec keygen',
  'sdns dnssec keypub www.example.com zsk\n"Kwww.example.com.+005+00942+zsk+RSASHA1+1024"',
  'sdns dnssec zonesig www.example.com',
];

// The same block as the Hub exports it: sorted by statement, which is not the manual's order, but each entry says the lines it stands on in
// its source (the chapter file the manual is cited by): the manual gives the lines of EXAMPLE in the order EXAMPLE has them.
const SOURCE = 'ab'.repeat(32), OTHER_SOURCE = 'cd'.repeat(32);
const LINES = ['l/10', 'l/11', 'l/12', 'l/13-14', 'l/15'];
const SEQUENCE = [...EXAMPLE].sort().map((statement): SyntheticEntry => ({ kind: 'behaviour', statement, fragments: [`src:${SOURCE}/text@1/${LINES[EXAMPLE.indexOf(statement)]}`] }));
// A node whose entries come from two source files, one of them without a line range of a text source: left in the Hub's order.
const MIXED = [
  { kind: 'behaviour' as const, statement: 'mixed b second in the export', fragments: [`src:${SOURCE}/text@1/l/5`] },
  { kind: 'behaviour' as const, statement: 'mixed c third in the export', fragments: [`src:${SOURCE}/xml@1/x/catalog/command[1]`] },
  { kind: 'behaviour' as const, statement: 'mixed a first in the source', fragments: [`src:${OTHER_SOURCE}/text@1/l/1`] },
];

const NODES: SyntheticNode[] = [
  { path: '/', children: ['commands', 'manual'], entries: [] },
  { path: '/commands', children: ['widget'], entries: [] },
  { path: '/commands/widget', children: [], entries: [
    { kind: 'definition', statement: 'widget health interval <seconds:int 1..60>\n  Set the health interval\n  seconds: 合成参数说明' },
    { kind: 'definition', statement: 'widget health interval <seconds:int 1..60> [<mode:string>]', applicability: '合成条件：构建 Fixture_Build_A 起' },
  ] },
  { path: '/manual', children: ['guide'], entries: [] },
  { path: '/manual/guide', children: ['example', 'mixed', 'overview', 'sequence'], entries: [] },
  { path: '/manual/guide/example', children: [], entries: EXAMPLE.map((statement) => ({ kind: 'behaviour' as const, statement })) },
  { path: '/manual/guide/mixed', children: [], entries: MIXED },
  { path: '/manual/guide/sequence', children: [], entries: SEQUENCE },
  { path: '/manual/guide/overview', children: [], entries: [
    { kind: 'behaviour', statement: PARAGRAPH },
    { kind: 'behaviour', statement: '* 动态DNS ACL规则\n\n系统会在功能开启后生成动态规则（通过“ddos dns on”启用）。\n\n* 第二段\n\n    缩进的代码行 --option "value"' },
    { kind: 'behaviour', statement: '(none) | “quoted” | **bold** | `code` | <angle> | [square] | {curly}' },
  ] },
];

const referenceOf = (path: string, entry: SyntheticEntry): string => `tree:${ROOT}${path}@${digest(entry.kind + '\u0000' + entry.statement)}`;

/** The export a run download gets: a head line, then one node a line, each entry with its statement and reference. */
function exportBytes(): Buffer {
  const lines = NODES.map((node) => JSON.stringify({
    path: node.path,
    reference: `tree:${ROOT}${node.path}`,
    name: node.path.split('/').at(-1) ?? '',
    level: node.children.length ? 'branch' : 'leaf',
    digest: digest(node.path),
    children: node.children.map((name) => ({ name, path: `${node.path === '/' ? '' : node.path}/${name}`, digest: digest(name) })),
    entries: node.entries.map((entry) => ({ entry: referenceOf(node.path, entry).split('@')[1], kind: entry.kind, statement: entry.statement, reference: referenceOf(node.path, entry), ...(entry.applicability === undefined ? {} : { applicability: entry.applicability }), ...(entry.fragments === undefined ? {} : { fragments: entry.fragments }), data: { form: 'text' } })),
  }));
  const head = { schema: 'run-knowledge@1', run: RUN, root: ROOT, composition: null, nodes: NODES.length, entries: NODES.reduce((n, node) => n + node.entries.length, 0) };
  return Buffer.from([JSON.stringify(head), ...lines].join('\n') + '\n');
}

/** A Hub that answers the run and its locked knowledge root, and nothing else. */
async function hub() {
  const bytes = exportBytes();
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('需要有效的 Bearer 令牌\n'); return; }
    if (request.url === `/run-export/${RUN}/run`) { response.end(JSON.stringify({ schema: 'run-export@1', run: { run: RUN, items: [], sources: [] } })); return; }
    if (request.url === `/run-export/${RUN}/knowledge`) { response.setHeader('content-digest', `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`); response.end(bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

type Download = (argv: string[], token: () => Promise<string>, brief?: unknown, retry?: unknown) => Promise<number>;
/** What the download tool of one pack writes under knowledge/, by file name. */
async function downloaded(tool: 'case-compile' | 'recompose'): Promise<Map<string, string>> {
  const h = await hub();
  try {
    const out = join(await mkdtemp(join(tmpdir(), 'cc-knowledge-text-')), 'run');
    const run: Download = tool === 'recompose' ? recomposeMain as Download : ((argv, token, brief, retry) => (caseCompileMain as Download)(argv, token, brief, { ...(retry as object), sourceCacheDirectory: false }));
    const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = (() => true) as typeof process.stdout.write; process.stderr.write = (() => true) as typeof process.stderr.write;
    let code: number;
    try { code = await run(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN); } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
    assert.equal(code, 0, `${tool} download exits 0`);
    const files = new Map<string, string>();
    for (const name of await readdir(join(out, 'knowledge'))) files.set(name, await readFile(join(out, 'knowledge', name), 'utf8'));
    return files;
  } finally { await h.close(); }
}

/** What the Hub's reference resolution gives for an entry address: the entry's statement (hub/knowledge/read.ts, TreeRead.text). */
const trees: TreeReader = {
  read: (_root, path, entry) => {
    for (const node of NODES) if (node.path === path) for (const e of node.entries) if (entry !== null && referenceOf(node.path, e).endsWith('@' + entry)) return { text: e.statement, mediaType: 'text/plain', readTier: 'model_readable', grounds: [] };
    return null;
  },
  readEntry: () => null,
};
const reader = { user: 'usr_synthetic', role: 'user' as const };

/** The Hub's two quote checks over a reference: hub/refs verifyQuote on the resolved text and the rules interpreter quote@1 over the same text. */
async function hubAccepts(reference: string, quote: string): Promise<boolean> {
  const resolved = await resolveReference(reference, { reader, parsers: createDefaultRegistry(), trees });
  assert.equal(resolved.resolved, true, reference);
  const refs = verifyQuote(resolved, quote);
  assert.notEqual(refs, null, 'the text is readable');
  const table = { schema: 'quote@1', origin: '合成', quotes: [{ select: '$.quotes[*]', text: '/text', reference: '/reference' }] };
  const text = resolved.resolved ? resolved.text ?? undefined : undefined;
  const request: CheckRequest = { interpreter: 'quote@1', table, subject: { quotes: [{ text: quote, reference }] }, sources: { text: (asked: string) => (asked === reference ? text : undefined) }, context: {} };
  const [outcome] = getInterpreter('quote@1')!.run(request);
  assert.equal(outcome.verdict === 'support', refs, 'the two checks agree');
  return refs === true;
}

/** The lines of one node's block in a text file: from its `# <path>` line to the blank line before the next one. */
function blockOf(lines: string[], path: string): string[] {
  const start = lines.indexOf(`# ${path}`);
  assert.ok(start >= 0, `${path} is in the files`);
  let end = lines.findIndex((line, at) => at > start && line.startsWith('# /'));
  if (end < 0) end = lines.length;
  while (end > start + 1 && lines[end - 1] === '') end--;
  return lines.slice(start, end);
}

/** The text files a model reads (nodes.jsonl and index.json are data files, not read as text). */
const textOf = (files: Map<string, string>): string => [...files].filter(([name]) => name.endsWith('.txt')).map(([, text]) => text).join('');

for (const tool of ['case-compile', 'recompose'] as const) describe(`what a model copies out of the knowledge text files the ${tool} download writes`, () => {
  test('every statement is in the files byte for byte on lines of its own, so a copied line is the Hub\'s text', async () => {
    const text = textOf(await downloaded(tool));
    for (const node of NODES) for (const entry of node.entries) {
      assert.ok(text.includes('\n' + entry.statement + '\n'), `statement of ${node.path} is not on lines of its own: ${JSON.stringify(entry.statement.slice(0, 60))}`);
    }
    assert.ok(PARAGRAPH.length > 1000 && text.includes('\n' + PARAGRAPH + '\n'), 'a long paragraph is whole, not cut and not marked with an ellipsis');
    assert.ok(!text.includes('…'), 'nothing is shortened for display');
  });

  test('a quote copied from a rendered line, or from several lines of one statement, passes the Hub\'s quote check for that entry', async () => {
    const lines = textOf(await downloaded(tool)).split('\n');
    for (const node of NODES) for (const entry of node.entries) {
      const reference = referenceOf(node.path, entry);
      const own = entry.statement.split('\n');
      // The model greps for the first line of the statement and copies the whole line it finds, then the lines below it.
      const at = lines.findIndex((line) => line.includes(own[0]));
      assert.ok(at >= 0, own[0]);
      for (let span = 1; span <= own.length; span++) {
        const quote = lines.slice(at, at + span).join('\n');
        assert.equal(await hubAccepts(reference, quote), true, `${node.path}: ${JSON.stringify(quote.slice(0, 80))}`);
      }
      // A piece out of the middle of a line is still a quote of the statement.
      const middle = own[0].slice(Math.floor(own[0].length / 3), Math.floor(own[0].length / 3) + 12).trim();
      if (middle) assert.equal(await hubAccepts(reference, middle), true, middle);
    }
  });

  test('the lines of a node keep the order the export lists them in: the download neither sorts nor regroups them', async () => {
    const lines = textOf(await downloaded(tool)).split('\n');
    const positions = EXAMPLE.map((statement) => lines.findIndex((line) => line.includes(statement.split('\n')[0])));
    assert.ok(positions.every((at) => at >= 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'the example block stays in the order it came in');
    assert.notDeepEqual([...EXAMPLE].sort(), EXAMPLE, 'the fixture is not in dictionary order');
    // The lines of the block are contiguous in the node: nothing but their own lines and their reference lines between the first and the last.
    const ownLine = (line: string): boolean => EXAMPLE.some((statement) => statement.split('\n').some((part) => line.includes(part)));
    const between = lines.slice(positions[0], positions.at(-1)! + 1).filter((line) => !ownLine(line) && !line.includes('tree:'));
    assert.deepEqual(between, [], 'no other text is mixed into the block');
  });

  test('entries that say the lines they stand on come back in the order of those lines, with the lines on their heading', async () => {
    assert.deepEqual(SEQUENCE.map((entry) => entry.statement), [...EXAMPLE].sort(), 'the export lists them as the Hub sorts them');
    const block = blockOf(textOf(await downloaded(tool)).split('\n'), '/manual/guide/sequence');
    const firsts = EXAMPLE.map((statement) => block.findIndex((line) => line === statement.split('\n')[0]));
    assert.ok(firsts.every((at) => at > 0), 'every statement is there on lines of its own');
    assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, 'in the order of the manual, not the Hub\'s');
    const expected = ['行 10', '行 11', '行 12', '行 13-14', '行 15'];
    firsts.forEach((at, i) => {
      assert.ok(block[at - 1].startsWith('· 引用 tree:') && block[at - 1].includes(`  源 ${SOURCE.slice(0, 12)} ${expected[i]}`), `heading of ${i}: ${block[at - 1].slice(-60)}`);
      assert.ok(!block[at].includes('源 ') && !block[at].startsWith('· 引用'), 'and the statement under it is untouched');
    });
  });

  test('a node whose entries do not all have a line range of one text source, or come from two files, is not reordered by guesswork', async () => {
    const block = blockOf(textOf(await downloaded(tool)).split('\n'), '/manual/guide/mixed');
    const texts = block.filter((line) => line.startsWith('mixed '));
    assert.deepEqual(texts, MIXED.map((entry) => entry.statement), 'the Hub\'s order stays');
  });

  test('the reference of an entry is on a line of its own that is not part of the text, and each entry has one', async () => {
    const lines = textOf(await downloaded(tool)).split('\n');
    for (const node of NODES) for (const entry of node.entries) {
      const reference = referenceOf(node.path, entry);
      const holders = lines.filter((line) => line.includes(reference));
      assert.equal(holders.length, 1, reference);
      assert.ok(!entry.statement.split('\n').includes(holders[0]), 'the line that holds the reference is no line of the statement');
      assert.ok(!holders[0].includes(entry.statement.split('\n')[0]), 'and it does not hold a statement line either');
    }
  });

  test('the authoring brief shows a node exactly as the download writes it into the file', async () => {
    const files = await downloaded(tool);
    const briefNodes: BriefNode[] = NODES.map((node) => ({
      path: node.path,
      children: node.children.map((name) => ({ name, path: `${node.path === '/' ? '' : node.path}/${name}` })),
      entries: node.entries.map((entry) => ({ kind: entry.kind, statement: entry.statement, reference: referenceOf(node.path, entry), ...(entry.applicability === undefined ? {} : { applicability: entry.applicability }), ...(entry.fragments === undefined ? {} : { fragments: entry.fragments }) })),
    }));
    for (const node of briefNodes.filter((candidate) => ['/manual/guide/example', '/manual/guide/sequence', '/manual/guide/mixed', '/manual/guide/overview'].includes(candidate.path) || candidate.path.startsWith('/commands/widget'))) {
      const file = files.get(`${node.path.split('/')[1]}.txt`)!;
      assert.ok(file.includes(nodeBlock(node).join('\n') + '\n'), `the brief's block of ${node.path} is not the downloaded one`);
    }
  });
});

describe('the words that explain the files to a model', () => {
  test('the skill texts and the writer and recomposer roles name the heading line, and the brief says it is no part of the text', async () => {
    const { ENTRY_HEADING } = await import('../functions/knowledge-text.ts').catch(() => ({ ENTRY_HEADING: undefined as string | undefined }));
    const heading = ENTRY_HEADING?.trim();
    assert.equal(heading, '· 引用', 'the pack names its heading line');
    const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    for (const text of [read('SKILL.md'), read('recompose/SKILL.md')]) assert.ok(text.includes(heading), 'a SKILL.md names the heading line');
    for (const key of ['recompose', 'plan'] as const) {
      const role = SUBAGENT_ROLES.find((candidate) => candidate.key === key)!;
      assert.ok(role.body.includes(heading), `the ${key} role names the heading line`);
      assert.ok(role.body.includes('不是手册') || role.body.includes('不是原文'), `the ${key} role says what is not the text`);
    }
    // The brief a writer reads first names the heading line and what stands under it, and quotes the node the record points to as the file has it.
    const nodes = new Map(NODES.map((node): [string, BriefNode] => [canonicalPath(node.path), {
      path: node.path,
      children: node.children.map((name) => ({ name, path: `${node.path === '/' ? '' : node.path}/${name}` })),
      entries: node.entries.map((entry) => ({ kind: entry.kind, statement: entry.statement, reference: referenceOf(node.path, entry) })),
    }]));
    const example = NODES.find((node) => node.path === '/manual/guide/example')!;
    const cited = referenceOf(example.path, example.entries[0]);
    const item = { id: 'doc-1:c-1', fields: { title: '合成用例', recomposition: { record: { atoms: [], ledgers: { adapted: [{ atom: 'a1', commands: [], equivalence_refs: [cited] }] } } } } };
    const brief = authoringBrief(item, '00', { root: ROOT, nodes, lines: new Map() }, null)!;
    assert.ok(brief.text.includes('· 引用 tree:…') && brief.text.includes('那是标注，不是原文') && brief.text.includes('按这个原文行号排列') && brief.text.includes('不是手册里的先后'), 'the brief head says what the heading line is, what the source lines on it are for, and when the order is not the manual\'s');
    assert.ok(brief.text.includes(nodeBlock(nodes.get(canonicalPath(example.path))!).join('\n')), 'and quotes the node as the file has it');
  });
});
