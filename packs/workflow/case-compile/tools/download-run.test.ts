// Decision 160 step 1: the whole run on local disk before anything is submitted, so the model reads it with file tools instead
// of one Hub call per item. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main } from './download-run.ts';
import { main as recomposeMain } from '../recompose/tools/download-run.ts';

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'synthetic-token-1234';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const mindmap = Buffer.from('{"root":{"data":{"text":"合成脑图"}}}'), contract = Buffer.from('{"contract":1}'), secret = Buffer.from('{"profile":1}');

async function hub(options: { tamper?: boolean; runAnswer?: (run: Record<string, unknown>) => unknown; knowledge?: { bytes: Uint8Array; digest?: string } } = {}) {
  const items = Array.from({ length: 12 }, (_, index) => ({ id: `case-${index}`, fields: { atoms: [{ id: 'a1', kind: 'intent', content: `合成意图 ${index}` }] } }));
  const run = {
    run: RUN, items,
    sources: [
      { slot: 'subject', role: 'input', reference: `src:${sha(mindmap)}`, label: '合成脑图' },
      { role: 'expected', reference: `src:${sha(mindmap)}/kityminder@1/n/abc123` },
      { slot: 'contract', role: 'expected', reference: `src:${sha(contract)}`, media_type: 'application/json' },
      { slot: 'profile', role: 'expected', reference: `src:${sha(secret)}` },
      { role: 'expected', reference: `rec:${'d'.repeat(64)}` },
    ],
  };
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? '');
    if (request.headers.authorization !== `Bearer ${TOKEN}`) { response.statusCode = 401; response.end('需要有效的 Bearer 令牌\n'); return; }
    if (request.url === `/run-export/${RUN}/run`) { response.end(JSON.stringify(options.runAnswer ? options.runAnswer(run) : { schema: 'run-export@1', run })); return; }
    if (request.url === `/run-export/${RUN}`) { response.statusCode = 409; response.end('这个运行还没有已受理的提交\n'); return; }
    if (request.url === `/run-export/${RUN}/knowledge` && options.knowledge) { response.setHeader('content-digest', `sha-256=:${options.knowledge.digest ?? createHash('sha256').update(options.knowledge.bytes).digest('base64')}:`); response.end(options.knowledge.bytes); return; }
    const found = /^\/run-export\/[^/]+\/sources\/([0-9a-f]{64})$/.exec(request.url ?? '');
    if (found?.[1] === sha(secret)) { response.statusCode = 403; response.end('这份原件在你的读取层级不给字节\n'); return; }
    const bytes = [mindmap, contract].find((value) => found?.[1] === sha(value));
    if (bytes) { response.end(options.tamper && bytes === contract ? Buffer.from('{"contract":2}') : bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, paths, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
async function outputOf(run: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [], err: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout), stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { code: await run(), stdout: out.join(''), stderr: err.join('') }; } finally { process.stdout.write = stdout; process.stderr.write = stderr; }
}

test('a run with nothing submitted yet lands on disk: the record, one file per item and every bound original, checked', async (t) => {
  const h = await hub(); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stdout } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout), { run: RUN, out, items: 12, sources: 2, withheld: [sha(secret)], knowledge: null, written: 16, briefs: 0 });
  assert.ok(h.paths.includes(`/run-export/${RUN}/knowledge`), 'the locked knowledge root is asked for once; this run locked none');
  assert.ok(!h.paths.includes(`/run-export/${RUN}`), 'only the run alone is asked for, which needs no accepted result');
  assert.equal(h.paths.filter((path) => path.endsWith(sha(mindmap))).length, 1, 'a fragment of an original already fetched is not fetched again');
  const record = await readFile(join(out, 'run.json'), 'utf8');
  assert.equal(JSON.parse(record).run, RUN); assert.ok(record.split('\n').length > 50, 'indented, so a file reader goes line by line');
  assert.deepEqual(await readdir(join(out, 'items')), Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}.json`));
  assert.equal(JSON.parse(await readFile(join(out, 'items', '07.json'), 'utf8')).fields.atoms[0].content, '合成意图 7');
  assert.deepEqual(await readFile(join(out, 'sources', sha(mindmap))), mindmap);
  assert.deepEqual(await readFile(join(out, 'sources', sha(contract))), contract);
  const bindings = JSON.parse(await readFile(join(out, 'sources.json'), 'utf8'));
  assert.equal(bindings.length, 5);
  assert.deepEqual(bindings[1], { slot: null, role: 'expected', reference: `src:${sha(mindmap)}/kityminder@1/n/abc123`, label: null, media_type: null, file: `sources/${sha(mindmap)}` });
  assert.deepEqual(bindings[3], { slot: 'profile', role: 'expected', reference: `src:${sha(secret)}`, label: null, media_type: null, file: null, withheld: '你的读取层级不给这份原件的字节' });
  assert.equal(bindings[4].file, null, 'a record reference has no original to download');
  const again = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(again.code, 1); assert.match(again.stderr, /已有文件.*不覆盖/);
});

test('bytes that do not match the bound digest write nothing at all', async (t) => {
  const h = await hub({ tamper: true }); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 1); assert.match(stderr, /字节与运行绑定的摘要不符，什么都没有写入/);
  await assert.rejects(readdir(out), 'the directory is not even made');
});

test('another run in the answer, a malformed export or a placeholder token are refused before anything is written', async (t) => {
  const other = await hub({ runAnswer: (run) => ({ schema: 'run-export@1', run: { ...run, run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb' } }) }); t.after(other.close);
  const out = await mkdtemp(join(tmpdir(), 'cc-download-'));
  assert.match((await outputOf(() => main(['--hub', other.url, '--run', RUN, '--out', join(out, 'a')], async () => TOKEN))).stderr, /不是 --run 指定的/);
  const malformed = await hub({ runAnswer: () => ({ schema: 'something-else' }) }); t.after(malformed.close);
  assert.match((await outputOf(() => main(['--hub', malformed.url, '--run', RUN, '--out', join(out, 'b')], async () => TOKEN))).stderr, /运行导出不合式/);
  assert.match((await outputOf(() => main(['--hub', malformed.url, '--run', RUN, '--out', join(out, 'c')], async () => '%HUB_TOKEN%'))).stderr, /没有存密钥 HUB_TOKEN/);
  assert.deepEqual(await readdir(out), []);
});

test('a directory that already holds something is refused; recompose ships the same tool', async (t) => {
  const h = await hub(); t.after(h.close); const out = await mkdtemp(join(tmpdir(), 'cc-download-'));
  await writeFile(join(out, 'notes.txt'), '已有');
  const { code, stderr } = await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 1); assert.match(stderr, /notes\.txt.*不覆盖/);
  assert.deepEqual(await readdir(out), ['notes.txt'], 'a refused directory is left as it was');
  const fresh = join(out, 'fresh');
  assert.equal((await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', fresh], async () => TOKEN))).code, 0);
  assert.equal((await readdir(join(fresh, 'items'))).length, 12);
});

// Model K05 and D06 R[2]: lock the root, fetch the subtree in one batch, verify the references at delivery. The run download
// brings the locked root with it, as files to read and search locally, for the recomposition stage and the authoring stage alike.
const ROOT = 'a'.repeat(64), ENTRY = 'e'.repeat(64);
const knowledgeLines = (run = RUN) => [
  { schema: 'run-knowledge@1', run, root: ROOT, composition: null, nodes: 4, entries: 3 },
  { path: '/', reference: `tree:${ROOT}/`, name: '', level: 'trunk', digest: ROOT, children: [{ name: 'widgets', path: '/widgets', digest: 'b'.repeat(64) }, { name: '手册 一', path: '/%E6%89%8B%E5%86%8C%20%E4%B8%80', digest: 'c'.repeat(64) }], entries: [] },
  { path: '/widgets', reference: `tree:${ROOT}/widgets`, name: 'widgets', level: 'branch', digest: 'b'.repeat(64), children: [{ name: 'health', path: '/widgets/health', digest: 'd'.repeat(64) }], entries: [] },
  { path: '/widgets/health', reference: `tree:${ROOT}/widgets/health`, name: 'health', level: 'leaf', digest: 'd'.repeat(64), children: [], entries: [
    { entry: ENTRY, kind: 'definition', statement: 'widget health interval <seconds:int 1..60>\n  Set the health interval\n  seconds: 合成参数说明', reference: `tree:${ROOT}/widgets/health@${ENTRY}`, data: { words: ['widget', 'health', 'interval'] } },
    { entry: 'f'.repeat(64), kind: 'behaviour', statement: '合成手册句：间隔缺省为 5 秒。', reference: `tree:${ROOT}/widgets/health@${'f'.repeat(64)}`, applicability: '合成条件', data: {} },
  ] },
  { path: '/%E6%89%8B%E5%86%8C%20%E4%B8%80', reference: `tree:${ROOT}/%E6%89%8B%E5%86%8C%20%E4%B8%80`, name: '手册 一', level: 'leaf', digest: 'c'.repeat(64), children: [], entries: [{ entry: '9'.repeat(64), kind: 'behaviour', statement: '合成章节正文', reference: `tree:${ROOT}/%E6%89%8B%E5%86%8C%20%E4%B8%80@${'9'.repeat(64)}`, data: {} }] },
];
const ndjson = (lines: unknown[]) => Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

test('the knowledge root the run locked comes with the run as files to read and search, each entry word for word with its reference', async (t) => {
  const bytes = ndjson(knowledgeLines());
  const h = await hub({ knowledge: { bytes } }); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stdout, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.deepEqual(report.knowledge, { root: ROOT, composition: null, nodes: 4, entries: 3, sha256: sha(bytes), files: ['root.txt', 'widgets.txt', `subtree-${sha(Buffer.from('%E6%89%8B%E5%86%8C%20%E4%B8%80')).slice(0, 12)}.txt`] });
  assert.equal(report.written, 16 + 5, 'the batch as received, one text file per top-level node, and the index');
  assert.equal(report.briefs, 0, 'no item of this run carries a recomposition record, so there is nothing to brief');
  await assert.rejects(readdir(join(out, 'briefs')));
  assert.equal(h.paths.filter((path) => path.endsWith('/knowledge')).length, 1, 'one request for the whole root');
  assert.deepEqual(await readFile(join(out, 'knowledge', 'nodes.jsonl')), bytes, 'the Hub\'s answer byte for byte');
  assert.equal(await readFile(join(out, 'knowledge', 'widgets.txt'), 'utf8'), [
    '# /widgets', '  子节点 1 个：health', '',
    '# /widgets/health',
    '· widget health interval <seconds:int 1..60>', '  Set the health interval', '  seconds: 合成参数说明', `  引用 tree:${ROOT}/widgets/health@${ENTRY}`,
    '· 合成手册句：间隔缺省为 5 秒。', '  适用 合成条件', `  引用 tree:${ROOT}/widgets/health@${'f'.repeat(64)}`, '', '',
  ].join('\n'));
  assert.match(await readFile(join(out, 'knowledge', 'root.txt'), 'utf8'), /^# \/\n  子节点 2 个：widgets、手册 一\n/);
  const index = JSON.parse(await readFile(join(out, 'knowledge', 'index.json'), 'utf8'));
  assert.deepEqual([index.run, index.root, index.nodes, index.entries, index.sha256, index.files.map((f: { file: string }) => f.file)], [RUN, ROOT, 4, 3, sha(bytes), report.knowledge.files]);
  // The recomposition stage ships the same download, so it gets the same files.
  const other = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const second = await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', other], async () => TOKEN));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(await readFile(join(other, 'knowledge', 'widgets.txt')), await readFile(join(out, 'knowledge', 'widgets.txt')));
});

// The reference implementation builds each writer's brief before the writer starts; here the download does, for every item
// that carries a recomposition record (tools/authoring-brief.ts has the brief's own tests).
test('items that carry a recomposition record get their authoring brief with the download', async (t) => {
  const bytes = ndjson(knowledgeLines());
  const withRecord = (item: Record<string, unknown>, index: number) => index % 6 ? item : { ...item, fields: { title: `合成用例 ${index}`, recomposition: { record: { atoms: [], ledgers: { adapted: [{ atom: 'a1', commands: [], equivalence_refs: [`tree:${ROOT}/widgets/health@${ENTRY}`] }] } } } } };
  const h = await hub({ knowledge: { bytes }, runAnswer: (run) => ({ schema: 'run-export@1', run: { ...run, items: (run.items as Array<Record<string, unknown>>).map(withRecord) } }) }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stdout, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.deepEqual([report.briefs, report.written], [2, 16 + 5 + 2]);
  assert.deepEqual(await readdir(join(out, 'briefs')), ['00.md', '06.md']);
  const brief = await readFile(join(out, 'briefs', '06.md'), 'utf8');
  assert.match(brief, /^# 编写简报 06：合成用例 6\n/);
  assert.ok(brief.includes(`# /widgets/health\n· widget health interval <seconds:int 1..60>\n  Set the health interval\n  seconds: 合成参数说明\n  引用 tree:${ROOT}/widgets/health@${ENTRY}\n`), 'the entry the record references, word for word with its reference');
  // A brief that cannot be written does not undo a download that is already on disk.
  const third = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const failed = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', third], async () => TOKEN, async () => { throw new Error('合成故障'); }));
  assert.equal(failed.code, 0, failed.stderr);
  assert.deepEqual([JSON.parse(failed.stdout).briefs, JSON.parse(failed.stdout).briefs_note], [0, '编写简报没有写出（合成故障）；运行已完整下载，照常读 items/ 和 knowledge/']);
  assert.equal((await readdir(join(third, 'items'))).length, 12);
  // The recomposition stage's own download writes no briefs: its items are what a record is made from.
  const other = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  assert.equal((await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', other], async () => TOKEN))).code, 0);
  await assert.rejects(readdir(join(other, 'briefs')));
});

test('a knowledge batch whose bytes do not match the digest, or that is another run\'s or cut short, writes nothing at all', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-download-'));
  for (const [name, knowledge, message] of [
    ['forged', { bytes: ndjson(knowledgeLines()), digest: createHash('sha256').update('other').digest('base64') }, /知识根的字节与 Hub 给的摘要不符/],
    ['other-run', { bytes: ndjson(knowledgeLines('run_01zzzzzzzzzzzzzzzzzzzzzzzz')) }, /不是 --run 指定的/],
    ['short', { bytes: ndjson(knowledgeLines().slice(0, 3)) }, /行数与首行不符/],
    ['not-json', { bytes: Buffer.from('not json\n') }, /不是逐行的 UTF-8 JSON/],
  ] as const) {
    const h = await hub({ knowledge }); t.after(h.close);
    const result = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', join(dir, name)], async () => TOKEN));
    assert.equal(result.code, 1, name); assert.match(result.stderr, message, name);
    await assert.rejects(readdir(join(dir, name)), name + ': nothing was written');
  }
});
