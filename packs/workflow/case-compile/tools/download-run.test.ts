// Decision 160 step 1: the whole run on local disk before anything is submitted, so the model reads it with file tools instead
// of one Hub call per item. Synthetic Hub stub only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { main as importedMain } from './download-run.ts';
import { loadPriorDeviceHistory } from './authoring-brief.ts';
import { readSourceManifest } from '../functions/source-materials.ts';
import { main as recomposeMain } from '../recompose/tools/download-run.ts';

// The tests of the fetch itself run it inside the download; the detached form a real download uses has its own test below.
const main: typeof importedMain = (argv, token, brief, retry, history) => importedMain(argv, token, brief, { ...retry, sourceCacheDirectory: false }, { inline: true, ...history });

const RUN = 'run_01aaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN = 'synthetic-token-1234';
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const mindmap = Buffer.from('{"root":{"data":{"text":"合成脑图"}}}'), contract = Buffer.from('{"contract":1}'), secret = Buffer.from('{"profile":1}');

type Extra = (url: string, response: import('node:http').ServerResponse) => boolean;
async function hub(options: { tamper?: boolean; runAnswer?: (run: Record<string, unknown>) => unknown; knowledge?: { bytes: Uint8Array; digest?: string }; late?: unknown; extra?: Extra } = {}) {
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
    if (options.extra?.(request.url ?? '', response)) return;
    if (request.url === `/run-export/${RUN}/run`) { response.end(JSON.stringify(options.runAnswer ? options.runAnswer(run) : { schema: 'run-export@1', run })); return; }
    if (request.url === `/run-export/${RUN}`) { response.statusCode = 409; response.end('这个运行还没有已受理的提交\n'); return; }
    if (request.url === `/run-export/${RUN}/late` && options.late !== undefined) { const bytes = Buffer.from(JSON.stringify(options.late)); response.setHeader('content-digest', `sha-256=:${createHash('sha256').update(bytes).digest('base64')}:`); response.end(bytes); return; }
    if (request.url === `/run-export/${RUN}/knowledge` && options.knowledge) { response.setHeader('content-digest', `sha-256=:${options.knowledge.digest ?? createHash('sha256').update(options.knowledge.bytes).digest('base64')}:`); response.end(options.knowledge.bytes); return; }
    const found = /^\/run-export\/[^/]+\/sources\/([0-9a-f]{64})$/.exec(request.url ?? '');
    if (found?.[1] === sha(secret)) { response.statusCode = 403; response.end('这份原件在你的读取层级不给字节\n'); return; }
    const bytes = [mindmap, contract].find((value) => found?.[1] === sha(value));
    if (bytes) { response.end(options.tamper && bytes === contract ? Buffer.from('{"contract":2}') : bytes); return; }
    response.statusCode = 404; response.end('没有这个运行或原件\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/mcp`, paths, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
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
  // A Hub without the history route (404) leaves the download whole and says the history is unavailable; `written` counts the run's own files.
  assert.deepEqual(JSON.parse(stdout), { run: RUN, out, items: 12, sources: 2, withheld: [sha(secret)], knowledge: null, written: 16, briefs: 0, history: { status: 'unavailable_from_hub', runs: 0, downloaded: 0, file: join(out, 'history.json'), reason: 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口' } });
  const none = JSON.parse(await readFile(join(out, 'history.json'), 'utf8'));
  assert.deepEqual([none.schema, none.run, none.status, none.reason, none.answer, none.returns], ['device-history@1', RUN, 'unavailable', 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口', null, []]);
  assert.deepEqual(JSON.parse(await readFile(join(out, '..', 'history', 'history.json'), 'utf8')), none, 'the compile keeps the same answer beside the run directory');
  assert.equal(h.paths.filter((path) => path.startsWith(`/run-export/${RUN}/history`)).join(), `/run-export/${RUN}/history?limit=6`, 'asked once, for six runs at most');
  assert.ok(h.paths.includes(`/run-export/${RUN}/knowledge`), 'the locked knowledge root is asked for once; this run locked none');
  assert.ok(!h.paths.includes(`/run-export/${RUN}`), 'only the run alone is asked for, which needs no accepted result');
  assert.equal(h.paths.filter((path) => path.endsWith(sha(mindmap))).length, 1, 'a fragment of an original already fetched is not fetched again');
  const record = await readFile(join(out, 'run.json'), 'utf8');
  assert.equal(JSON.parse(record).run, RUN); assert.ok(record.split('\n').length > 50, 'indented, so a file reader goes line by line');
  assert.deepEqual(await readdir(join(out, 'items')), Array.from({ length: 12 }, (_, index) => `${String(index).padStart(2, '0')}.json`));
  assert.equal(JSON.parse(await readFile(join(out, 'items', '07.json'), 'utf8')).fields.atoms[0].content, '合成意图 7');
  assert.deepEqual(await readFile(join(out, 'sources', 'subject')), mindmap);
  assert.deepEqual(await readFile(join(out, 'sources', 'contract.json')), contract);
  const bindings = JSON.parse(await readFile(join(out, 'sources.json'), 'utf8'));
  assert.equal(bindings.length, 5);
  assert.deepEqual(bindings[1], { slot: null, role: 'expected', reference: `src:${sha(mindmap)}/kityminder@1/n/abc123`, label: null, media_type: null, file: 'sources/subject', sha256: sha(mindmap) });
  assert.deepEqual(bindings[3], { slot: 'profile', role: 'expected', reference: `src:${sha(secret)}`, label: null, media_type: null, file: null, sha256: sha(secret), withheld: '你的读取层级不给这份原件的字节' });
  assert.equal(bindings[4].file, null, 'a record reference has no original to download');
  const again = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(again.code, 1); assert.match(again.stderr, /输出位置不是空的普通目录/);
});

test('bytes that do not match the bound digest write nothing at all', async (t) => {
  const h = await hub({ tamper: true }); t.after(h.close); const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 1); assert.match(stderr, /来源字节与运行绑定摘要不一致/);
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
    `· 引用 tree:${ROOT}/widgets/health@${ENTRY}`, 'widget health interval <seconds:int 1..60>', '  Set the health interval', '  seconds: 合成参数说明',
    `· 引用 tree:${ROOT}/widgets/health@${'f'.repeat(64)}  适用 合成条件`, '合成手册句：间隔缺省为 5 秒。', '', '',
  ].join('\n'), 'a heading line with the reference and the conditions, then the statement as it is; nothing in front of any of its lines');
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
  assert.ok(brief.includes('## 这条用例的计划文件外壳') && brief.includes('"item": "case-6"'), 'and the envelope of that case’s plan file');
  assert.ok(brief.includes(`# /widgets/health\n· 引用 tree:${ROOT}/widgets/health@${ENTRY}\nwidget health interval <seconds:int 1..60>\n  Set the health interval\n  seconds: 合成参数说明\n`), 'the entry the record references, word for word with its reference');
  // A brief that cannot be written does not undo a download that is already on disk.
  const third = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const failed = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', third], async () => TOKEN, async () => { throw new Error('合成故障'); }));
  assert.equal(failed.code, 0, failed.stderr);
  assert.deepEqual([JSON.parse(failed.stdout).briefs, JSON.parse(failed.stdout).briefs_note], [0, '脚本编写所需的原始用例和手册未保存。原因合成故障；其余原始资料已下载，请从原始资料继续脚本编写']);
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

test('writes references.json and prints run_reference when run-export@1 includes it', async (t) => {
  const ref = `rec:${'c'.repeat(64)}`;
  const h = await hub({ runAnswer: (run) => ({ schema: 'run-export@1', run_reference: ref, run }) }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const first = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(first.code, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).run_reference, ref);
  assert.equal(JSON.parse(first.stdout).written, 17);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'references.json'), 'utf8')), { schema: 'run-references@1', run: RUN, run_reference: ref });
  const other = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'recompose');
  const second = await outputOf(() => recomposeMain(['--hub', h.url, '--run', RUN, '--out', other], async () => TOKEN));
  assert.equal(second.code, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).run_reference, ref);
  assert.deepEqual(JSON.parse(await readFile(join(other, 'references.json'), 'utf8')), { schema: 'run-references@1', run: RUN, run_reference: ref });
});

test('download-run and recompose download-run retry 503 Retry-After and ECONNREFUSED and report wait/attempts on 60s exhaustion', async (t) => {
  const h = await hub({}); t.after(h.close);
  for (const [label, entry] of [['compile', main], ['recompose', recomposeMain]] as const) {
    let calls = 0;
    let nowMs = 0;
    const pauses: number[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      calls++;
      if (calls === 1) return new Response('Hub 正在重启', { status: 503, headers: { 'retry-after': '5' } });
      if (calls === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
      return globalThis.fetch(input, init);
    };
    const out = join(await mkdtemp(join(tmpdir(), `cc-dl-retry-${label}-`)), 'out');
    const ok = await outputOf(() => entry(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN, ...(entry === main ? [undefined] : []), {
      timing: { now: () => nowMs, pause: async (ms) => { pauses.push(ms); nowMs += ms; } },
      fetch: fetchStub,
    }));
    assert.equal(ok.code, 0, `${label}: ${ok.stderr}`);
    assert.deepEqual(pauses, [5_000, 2_000], label);
    assert.equal(JSON.parse(ok.stdout).run, RUN, label);

    let failNow = 0;
    const failPauses: number[] = [];
    const failDir = join(await mkdtemp(join(tmpdir(), `cc-dl-fail-${label}-`)), 'out');
    const fail = await outputOf(() => entry(['--hub', h.url, '--run', RUN, '--out', failDir], async () => TOKEN, ...(entry === main ? [undefined] : []), {
      timing: { now: () => failNow, pause: async (ms) => { failPauses.push(ms); failNow += ms; } },
      fetch: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); },
    }));
    assert.equal(fail.code, 1, label);
    assert.deepEqual(failPauses, [2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000, 8_000, 6_000], label);
    assert.match(fail.stderr, /^暂时不可用：Hub 不可达（ECONNREFUSED），已等待 60 秒并尝试 10 次仍未恢复。请.*。$/m, label);
    await assert.rejects(readdir(failDir), `${label}: nothing written after retry exhaustion`);
  }
});

test('download-run and recompose download-run reject empty stdin without token with same-line heredoc guidance', async (t) => {
  const h = await hub(); t.after(h.close);
  for (const [label, entry] of [['plan', main], ['recompose', recomposeMain]] as const) {
    for (const rawToken of ['', '   \n\t ']) {
      const out = join(await mkdtemp(join(tmpdir(), `cc-dl-notok-${label}-`)), 'run');
      const res = await outputOf(() => entry(['--hub', h.url, '--run', RUN, '--out', out], async () => rawToken));
      assert.equal(res.code, 1, label);
      assert.match(res.stderr, /^参数无效：标准输入里没有令牌/, label);
      assert.match(res.stderr, /切勿在 <<'EOF' 前换行/, label);
      await assert.rejects(readdir(out), `${label}: nothing written without token`);
    }
  }
});

// A plan run whose recomposition result is bound after its start (workflow.json from_runs.after_start): the download also keeps the
// Hub's late answer (GET /run-export/<run>/late, run-late@1) as late.json, and the cases already accepted get their brief with it.
test('a run with a recomposition bound after its start keeps the late answer as late.json and briefs the cases already accepted', async (t) => {
  const bytes = ndjson(knowledgeLines());
  const record = { atoms: [], ledgers: { adapted: [{ atom: 'a1', commands: [], equivalence_refs: [`tree:${ROOT}/widgets/health@${ENTRY}`] }] } };
  const marker = (index: number) => ({ slot: 'recomposition_result', run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', source: 'src:' + 'a'.repeat(64), node: `n/${index}` });
  const late = {
    schema: 'run-late@1', run: RUN, run_reference: 'rec:' + 'c'.repeat(64), resolved_at: '2026-11-17T00:00:00.000Z',
    late: { inputs: [{ slot: 'recomposition_result', run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', reference: 'rec:' + 'd'.repeat(64) }], refresh: 'e'.repeat(64) },
    items: [
      { id: 'case-0', late: { recomposition: { record, receipt: 'rec:' + 'd'.repeat(64), late: true, record_sha256: 'f'.repeat(64) } } },
      { id: 'case-6', late: { recomposition_problem: '等这一条单条提交并被受理', recomposition_waiting: { run: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb', result: 'rec:' + 'd'.repeat(64), state: 'pending', item: 'case-6' } } },
    ],
  };
  const withMarker = (item: Record<string, unknown>, index: number) => index % 6 ? item : { ...item, fields: { title: `合成用例 ${index}`, recomposition_late: marker(index) } };
  const h = await hub({ knowledge: { bytes }, late, runAnswer: (run) => ({ schema: 'run-export@1', run: { ...run, items: (run.items as Array<Record<string, unknown>>).map(withMarker) } }) }); t.after(h.close);
  const out = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const { code, stdout, stderr } = await outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', out], async () => TOKEN));
  assert.equal(code, 0, stderr);
  const report = JSON.parse(stdout);
  assert.deepEqual(JSON.parse(await readFile(join(out, 'late.json'), 'utf8')), late, 'the Hub\'s answer as it came');
  assert.deepEqual([report.late.accepted, report.late.waiting, report.briefs, report.written], [1, 1, 1, 16 + 5 + 1 + 1]);
  assert.match(report.late.note, /refresh-late\.ts/);
  assert.deepEqual(await readdir(join(out, 'briefs')), ['00.md'], 'only the case whose record is accepted has a brief; the waiting one gets it from refresh-late');
  assert.ok((await readFile(join(out, 'briefs', '00.md'), 'utf8')).includes(`"record_sha256": "${'f'.repeat(64)}"`), 'the envelope names the record by its digest');
  // A late answer of another run is refused before anything is written.
  const forged = await hub({ late: { ...late, run: 'run_01zzzzzzzzzzzzzzzzzzzzzzzz' } }); t.after(forged.close);
  const refused = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  const answer = await outputOf(() => main(['--hub', forged.url, '--run', RUN, '--out', refused], async () => TOKEN));
  assert.equal(answer.code, 1);
  assert.match(answer.stderr, /不是运行 run_01aaaaaaaaaaaaaaaaaaaaaaaa 的 run-late@1 答复/);
  await assert.rejects(readdir(refused), 'nothing was written');
  // A run that binds nothing after its start has no late route (404): nothing more is written than before.
  const plain = await hub({}); t.after(plain.close);
  const without = join(await mkdtemp(join(tmpdir(), 'cc-download-')), 'run');
  assert.equal((await outputOf(() => main(['--hub', plain.url, '--run', RUN, '--out', without], async () => TOKEN))).code, 0);
  await assert.rejects(readFile(join(without, 'late.json')));
});

// ---------------------------------------------------------------- the earlier device verifications of the document (Hub decision 182)

const V1 = `run_01${'b'.repeat(24)}`, V2 = `run_01${'c'.repeat(24)}`, V3 = `run_01${'d'.repeat(24)}`, P1 = `run_01${'e'.repeat(24)}`;
const CASE = '990000000000000301';
const caseLog = (run: string) => Buffer.from(`合成运行日志 ${run}\n`), caseSession = (run: string) => Buffer.from(`seat#widget health interval pool-a 60\nok ${run}\nseat#\n`);
const jobOf = (run: string) => sha(Buffer.from(`job ${run}`));
/** A Hub that lists `runs` as earlier verifications of RUN's document and serves the jobs and files of each; `jobs` overrides one run's job listing. */
function historyRoutes(runs: string[], jobs: Record<string, (response: import('node:http').ServerResponse) => void> = {}, historyAnswer?: (response: import('node:http').ServerResponse) => void): Extra {
  const files = new Map(runs.flatMap((run) => [caseLog(run), caseSession(run)]).map((bytes) => [sha(bytes), bytes]));
  return (url, response) => {
    if (url.startsWith(`/run-export/${RUN}/history`)) {
      if (historyAnswer) { historyAnswer(response); return true; }
      response.end(JSON.stringify({ schema: 'run-history@1', run: RUN, subjects: ['toy:mindmap:docq7'], limit: 6, complete: true, runs: runs.map((run, at) => ({ run, started_at: `2026-11-1${9 - at}T00:00:00.000Z`, build: 'synthetic-build-7', jobs: [{ job: jobOf(run), plan_run: P1, ended_at: `2026-11-1${9 - at}T01:00:00.000Z`, outcome: 'effective', rows: [{ item: CASE, dynamic_terminal: at ? 'fail' : 'pass' }] }] })) }));
      return true;
    }
    const listing = /^\/run-export\/(run_\w+)\/jobs$/.exec(url);
    if (listing && runs.includes(listing[1])) {
      const run = listing[1];
      if (jobs[run]) { jobs[run](response); return true; }
      response.end(JSON.stringify({ schema: 'run-jobs@1', run, jobs: [{ job: jobOf(run), verification_run: run, plan_run: P1, items: [CASE], sha256: 'd'.repeat(64), ended: 'done', outcome: 'effective', frozen: false, result: `src:${'9'.repeat(64)}`, device_return: null,
        rows: [{ item: CASE, dynamic_terminal: run === runs[0] ? 'pass' : 'fail', evidence: { log: `src:${sha(caseLog(run))}`, sessions: { 'dev-a.txt': `src:${sha(caseSession(run))}` } } }] }] }));
      return true;
    }
    const source = /^\/run-export\/(run_\w+)\/sources\/([0-9a-f]{64})$/.exec(url);
    if (source && runs.includes(source[1]) && files.has(source[2])) { response.end(files.get(source[2])); return true; }
    return false;
  };
}
/** Runs the download from `workdir`, as the lead does: every path it prints and stores is then relative to the working directory. */
async function fromWorkdir<T>(workdir: string, work: () => Promise<T>): Promise<T> {
  const before = process.cwd();
  process.chdir(workdir);
  try { return await work(); } finally { process.chdir(before); }
}

test('the first download of a compile asks once for the earlier device verifications and saves their returns; later downloads reuse them', async (t) => {
  const h = await hub({ extra: historyRoutes([V1, V2]) }); t.after(h.close);
  const workdir = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const first = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN)));
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).history, { status: 'fetched', runs: 2, downloaded: 2, file: join('plan-run', 'history.json') });
  const kept = JSON.parse(await readFile(join(workdir, 'plan-run', 'history.json'), 'utf8'));
  assert.deepEqual([kept.schema, kept.run, kept.status, kept.answer.schema, kept.answer.runs.map((run: { run: string }) => run.run), kept.returns], ['device-history@1', RUN, 'fetched', 'run-history@1', [V1, V2], [{ run: V1, dir: join('history', V1) }, { run: V2, dir: join('history', V2) }]], 'where the returns are is said from the working directory');
  assert.deepEqual(kept.answer.runs[0].jobs[0], { job: jobOf(V1), plan_run: P1, ended_at: '2026-11-19T01:00:00.000Z', outcome: 'effective', rows: [{ item: CASE, dynamic_terminal: 'pass' }] });
  assert.deepEqual(JSON.parse(await readFile(join(workdir, 'history', 'history.json'), 'utf8')), kept);
  for (const run of [V1, V2]) {
    const folder = join(workdir, 'history', run, jobOf(run).slice(0, 12), 'cases', CASE);
    assert.deepEqual(await readFile(join(folder, 'log.txt')), caseLog(run));
    assert.deepEqual(await readFile(join(folder, 'dev-a.txt')), caseSession(run));
    const index = JSON.parse(await readFile(join(workdir, 'history', run, 'index.json'), 'utf8'));
    assert.deepEqual([index.schema, index.run, index.jobs[0].rows[0].item, index.jobs[0].rows[0].log], ['device-returns@1', run, CASE, join(jobOf(run).slice(0, 12), 'cases', CASE, 'log.txt')]);
  }
  const asked = () => h.paths.filter((path) => path.includes('/history') || path.endsWith('/jobs')).length;
  assert.deepEqual(h.paths.filter((path) => path.includes('/history')), [`/run-export/${RUN}/history?limit=6`]);
  const requests = asked();

  // A second download in the same working directory, as the lead's own call: the history beside it is taken, nothing is asked.
  const second = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run-again'], async () => TOKEN)));
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout).history, { status: 'reused', runs: 2, downloaded: 2, file: join('plan-run-again', 'history.json') });
  assert.deepEqual(JSON.parse(await readFile(join(workdir, 'plan-run-again', 'history.json'), 'utf8')), kept);
  // The pipeline's call for a reworked round names the compile's history directory: the new run directory gets the same file.
  const reworked = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', join('rework', 'round-2', 'plan-run'), '--history-reuse', 'history'], async () => TOKEN)));
  assert.equal(reworked.code, 0, reworked.stderr);
  assert.deepEqual(JSON.parse(reworked.stdout).history, { status: 'reused', runs: 2, downloaded: 2, file: join('rework', 'round-2', 'plan-run', 'history.json') });
  assert.deepEqual(JSON.parse(await readFile(join(workdir, 'rework', 'round-2', 'plan-run', 'history.json'), 'utf8')), kept);
  await assert.rejects(readdir(join(workdir, 'rework', 'round-2', 'history')), 'nothing is fetched beside the reworked run');
  assert.equal(asked(), requests, 'neither later download asked the Hub for the history or for a job again');
});

test('a reworked round whose compile fetched no history asks for none and says so', async (t) => {
  const h = await hub({ extra: historyRoutes([V1]) }); t.after(h.close);
  const workdir = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const reworked = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', join('rework', 'round-2', 'plan-run'), '--history-reuse', 'history'], async () => TOKEN)));
  assert.equal(reworked.code, 0, reworked.stderr);
  const report = JSON.parse(reworked.stdout).history;
  assert.deepEqual([report.status, report.runs, report.downloaded], ['unavailable_from_hub', 0, 0]);
  assert.match(report.reason, /这次编译开始时没有取到上机历史（history\/history\.json 不存在），返工新开的运行不再向 Hub 取/);
  assert.equal(JSON.parse(await readFile(join(workdir, 'rework', 'round-2', 'plan-run', 'history.json'), 'utf8')).status, 'unavailable');
  assert.deepEqual(h.paths.filter((path) => path.includes('/history') || path.endsWith('/jobs')), [], 'the Hub is not asked');
  await assert.rejects(readdir(join(workdir, 'history')));
  // A compile whose first fetch failed keeps that answer for its reworked rounds, and a later plain download asks again.
  const failing = await hub({}); t.after(failing.close);
  const other = await mkdtemp(join(tmpdir(), 'cc-history-'));
  assert.equal(JSON.parse((await fromWorkdir(other, () => outputOf(() => main(['--hub', failing.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN)))).stdout).history.status, 'unavailable_from_hub');
  const kept = JSON.parse((await fromWorkdir(other, () => outputOf(() => main(['--hub', failing.url, '--run', RUN, '--out', join('rework', 'round-2', 'plan-run'), '--history-reuse', 'history'], async () => TOKEN)))).stdout).history;
  assert.deepEqual([kept.status, kept.reason], ['unavailable_from_hub', 'Hub 没有历次上机验证的查询接口（答复 404）：这台 Hub 的版本早于这个接口']);
  assert.equal(failing.paths.filter((path) => path.includes('/history')).length, 1);
  const again = JSON.parse((await fromWorkdir(other, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run-again'], async () => TOKEN)))).stdout).history;
  assert.deepEqual([again.status, again.runs, again.downloaded], ['fetched', 1, 1]);
});

test('a history that does not answer in time, an answer of another shape and returns that cannot be read never fail the download', async (t) => {
  // The route does not answer within the time the history may take: the run is on disk, the history says why it is not.
  const silent = await hub({ extra: historyRoutes([V1], {}, () => { /* never answers */ }) }); t.after(silent.close);
  const slow = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const timedOut = await fromWorkdir(slow, () => outputOf(() => main(['--hub', silent.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN, undefined, undefined, { budgetMs: 300 })));
  assert.equal(timedOut.code, 0, timedOut.stderr);
  const late = JSON.parse(timedOut.stdout);
  assert.deepEqual([late.items, late.history.status, late.history.runs], [12, 'unavailable_from_hub', 0]);
  assert.match(late.history.reason, /^向 Hub 取历次上机验证没有成功：Hub [0-9.]+ 秒内没有答复/);
  assert.equal((await readdir(join(slow, 'plan-run', 'items'))).length, 12);
  assert.equal(JSON.parse(await readFile(join(slow, 'plan-run', 'history.json'), 'utf8')).status, 'unavailable');

  // An answer that is not run-history@1 of this run is not taken.
  const odd = await hub({ extra: historyRoutes([V1], {}, (response) => { response.end(JSON.stringify({ schema: 'run-history@1', run: V3, runs: [] })); }) }); t.after(odd.close);
  const strange = JSON.parse((await fromWorkdir(await mkdtemp(join(tmpdir(), 'cc-history-')), () => outputOf(() => main(['--hub', odd.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN)))).stdout).history;
  assert.deepEqual([strange.status, strange.reason], ['unavailable_from_hub', 'Hub 对历次上机验证的答复不是 run-history@1，没有采用']);

  // Three runs listed: the first is saved, the second cannot be read, the third has no job any more. What was fetched is kept.
  const partial = await hub({ extra: historyRoutes([V1, V2, V3], { [V2]: (response) => { response.statusCode = 500; response.end('合成故障\n'); }, [V3]: (response) => { response.end(JSON.stringify({ schema: 'run-jobs@1', run: V3, jobs: [] })); } }) }); t.after(partial.close);
  const some = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const held = await fromWorkdir(some, () => outputOf(() => main(['--hub', partial.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN)));
  assert.equal(held.code, 0, held.stderr);
  assert.deepEqual(JSON.parse(held.stdout).history, { status: 'fetched', runs: 3, downloaded: 1, file: join('plan-run', 'history.json') });
  const returns = JSON.parse(await readFile(join(some, 'plan-run', 'history.json'), 'utf8')).returns as Array<{ run: string; dir: string | null; reason?: string }>;
  assert.deepEqual(returns.map((row) => [row.run, row.dir]), [[V1, join('history', V1)], [V2, null], [V3, null]]);
  assert.match(returns[1].reason!, /Hub 答复 500/);
  assert.match(returns[2].reason!, /尚未开始上机验证/);
  assert.deepEqual((await readdir(join(some, 'history'))).sort(), [V1, 'history.json'].sort(), 'a run that could not be read leaves no folder');

  // The time runs out while the returns are read, one run at a time: the first is not finished, the next is not started.
  const stalled = await hub({ extra: historyRoutes([V1, V2], { [V1]: () => { /* the job listing never answers */ } }) }); t.after(stalled.close);
  const spent = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const cut = await fromWorkdir(spent, () => outputOf(() => main(['--hub', stalled.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN, undefined, undefined, { budgetMs: 1000, parallel: 1 })));
  assert.equal(cut.code, 0, cut.stderr);
  assert.deepEqual(JSON.parse(cut.stdout).history, { status: 'fetched', runs: 2, downloaded: 0, file: join('plan-run', 'history.json') });
  const unfinished = JSON.parse(await readFile(join(spent, 'plan-run', 'history.json'), 'utf8')).returns as Array<{ run: string; dir: string | null; reason?: string }>;
  assert.deepEqual(unfinished, [{ run: V1, dir: null, reason: '取上机历史的总时限 1 秒已到，这一次的设备输出没有下载完' }, { run: V2, dir: null, reason: '取上机历史的总时限 1 秒已到，这一次的设备输出没有下载' }]);
  assert.deepEqual(stalled.paths.filter((path) => path === `/run-export/${V2}/jobs`), [], 'nothing is asked after the time is spent');
});

test('a real download does not wait for the history: it starts the fetch, says so in the run directory, and a task generated later reads what the fetch kept', async (t) => {
  const h = await hub({ extra: historyRoutes([V1, V2]) }); t.after(h.close);
  const workdir = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const started: Array<{ argv: string[]; token: string }> = [];
  const start = (argv: string[], token: string) => { started.push({ argv, token }); };
  const first = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN, undefined, undefined, { inline: false, start })));
  assert.equal(first.code, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).history, { status: 'fetching', runs: 0, downloaded: 0, file: join('plan-run', 'history.json') });
  assert.deepEqual(started, [{ argv: ['--hub', h.url, '--run', RUN, '--out', 'plan-run', '--history-fetch', 'yes'], token: TOKEN }], 'this tool again, the token on standard input only');
  assert.deepEqual(h.paths.filter((path) => path.includes('/history') || path.endsWith('/jobs')), [], 'the download itself asked nothing about the history');
  const pending = JSON.parse(await readFile(join(workdir, 'plan-run', 'history.json'), 'utf8'));
  assert.deepEqual([pending.status, pending.reason, pending.pending], ['unavailable', '下载这个运行时已在后台向 Hub 取历次上机验证，生成这份任务时还没有取完。', { shared: 'history' }]);
  const before = await fromWorkdir(workdir, () => loadPriorDeviceHistory('plan-run', CASE, workdir));
  assert.deepEqual([before.status, before.unavailable_reason], ['unavailable_from_hub', '下载这个运行时已在后台向 Hub 取历次上机验证，生成这份任务时还没有取完。']);
  // A second download while the fetch is under way starts no second one; its run directory points at the same place.
  const second = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run-again'], async () => TOKEN, undefined, undefined, { inline: false, start })));
  assert.deepEqual([JSON.parse(second.stdout).history.status, started.length], ['fetching', 1]);
  // The started fetch: only the history, into the run directory that is already there.
  const fetch = await fromWorkdir(workdir, () => outputOf(() => main(started[0]!.argv, async () => started[0]!.token)));
  assert.equal(fetch.code, 0, fetch.stderr);
  assert.deepEqual(JSON.parse(fetch.stdout), { run: RUN, history: { status: 'fetched', runs: 2, downloaded: 2, file: join('plan-run', 'history.json') } });
  assert.equal(JSON.parse(await readFile(join(workdir, 'plan-run', 'history.json'), 'utf8')).status, 'fetched', 'the file that said the fetch was under way is replaced');
  await assert.rejects(readFile(join(workdir, 'history', 'fetching.json')), 'the mark of a fetch under way is gone');
  for (const directory of ['plan-run', 'plan-run-again']) {
    const after = await fromWorkdir(workdir, () => loadPriorDeviceHistory(directory, CASE, workdir));
    assert.deepEqual([after.status, after.entries.map((entry) => entry.verification_run)], ['available', [V1, V2]], `${directory}: the task reads what the fetch kept`);
  }
  // A later download beside it takes the kept history at once; a fetch that died leaves a mark that is not believed for ever.
  const third = await fromWorkdir(workdir, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run-third'], async () => TOKEN, undefined, undefined, { inline: false, start })));
  assert.deepEqual([JSON.parse(third.stdout).history.status, started.length], ['reused', 1]);
  const dead = await mkdtemp(join(tmpdir(), 'cc-history-'));
  await mkdir(join(dead, 'history'), { recursive: true });
  await writeFile(join(dead, 'history', 'fetching.json'), JSON.stringify({ run: RUN, started_ms: Date.now() - 10 * 60_000 }));
  const again = await fromWorkdir(dead, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN, undefined, undefined, { inline: false, start })));
  assert.deepEqual([JSON.parse(again.stdout).history.status, started.length], ['fetching', 2], 'a mark older than the fetch may take is replaced and the fetch started again');
  // A fetch that cannot be started is said, and the download still succeeds.
  const broken = await mkdtemp(join(tmpdir(), 'cc-history-'));
  const failed = await fromWorkdir(broken, () => outputOf(() => main(['--hub', h.url, '--run', RUN, '--out', 'plan-run'], async () => TOKEN, undefined, undefined, { inline: false, start: () => { throw new Error('synthetic: no process'); } })));
  assert.equal(failed.code, 0, failed.stderr);
  assert.deepEqual([JSON.parse(failed.stdout).history.status, JSON.parse(failed.stdout).history.reason], ['unavailable_from_hub', '取上机历史的后台进程没有起来：synthetic: no process']);
  await assert.rejects(readFile(join(broken, 'history', 'fetching.json')));
});
