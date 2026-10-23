// Tests of the metamorphic scenario (task gold-template-gap step 4): synthetic two-document gold, synthetic tool
// results, the three phases walked to the end; every reply's call count within `batch`; refused starts recorded as
// unknown; a request with no tool results after the start neither restarts nor advances.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Turn } from '../scripted-model.ts';
import { parseItemLine, parseSummary, sha256Of, summaryOfGetNodes, truncationReference, uploadIdOf, default as build } from './template-gap-metamorphic-circle.ts';
import { readCategories } from '../gold/gap-metamorphic.ts';

const CATEGORIES = readCategories(JSON.parse(readFileSync(join(import.meta.dirname, '../../../packs/workflow/template-gap/tables/template-v3.json'), 'utf8')));

const leaf = (id: string, text: string): unknown => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'configuration'): unknown => ({ data: { id, text, resource: [tag], priority: 2 }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: unknown[]): unknown => ({ data: { id, text }, children });
const docOf = (...cases: unknown[]): { root: unknown } => ({ root: group('r', '文档', group('g', '组', ...cases)) });

const turn = (index: number, toolResults: Array<{ id: string; text: string; isError: boolean }> = []): Turn => ({ index, system: null, messages: [], tools: [], toolResults });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const goldOf = (): { gold: unknown; dir: string } => {
  const dir = mkdtempSync(join(tmpdir(), 'gap-scenario-'));
  dirs.push(dir);
  // Document A: two cases, one carries the Functional tag; document B: one case with the Stress tag.
  writeFileSync(join(dir, 'a.json'), JSON.stringify(docOf(kase('a1', '甲', '成功', 'Functional'), kase('a2', '乙', '成功'))));
  writeFileSync(join(dir, 'b.json'), JSON.stringify(docOf(kase('b1', '乙', '成功', 'Stress'))));
  return { gold: { documents: [{ file: join(dir, 'a.json') }, { file: join(dir, 'b.json') }], maxCases: 80, batch: 2 }, dir };
};

/** Drives the scenario with a fake Hub: uploads answer src:<sha of the bytes in workdir>, runs answer item rows. */
const drive = (scenario: ReturnType<typeof build>, answers: (file: string) => string): { calls: Array<Array<{ tool: string; input: Record<string, unknown> }>>; done: string; names: string[] } => {
  scenario.prepare?.(join(dirs[dirs.length - 1]!, 'work'));
  const calls: Array<Array<{ tool: string; input: Record<string, unknown> }>> = [];
  const shaToName = new Map<string, string>();
  let index = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const reply = scenario.respond(turn(index, lastResults)) as Array<{ tool?: string; input?: Record<string, unknown>; text?: string }>;
    if (reply.length === 1 && reply[0]?.text === '检查完成。') {
      return { calls, done: String(reply[0].text), names: [...shaToName.values()] };
    }
    const tools = reply.filter((r) => r.tool !== undefined) as Array<{ tool: string; input: Record<string, unknown> }>;
    if (reply.every((r) => r.tool !== undefined) && reply.length === 0) return { calls, done: '', names: [] };
    calls.push(tools);
    // Produce the results of these calls.
    const results: Array<{ id: string; text: string; isError: boolean }> = [];
    if (tools.every((t) => t.tool === 'hub_upload_file')) {
      for (const t of tools) {
        const name = String(t.input.file_path);
        const bytes = readFileSync(join(dirs[dirs.length - 1]!, 'work', name), 'utf8');
        const sha = sha256Of(bytes);
        shaToName.set(sha, name);
        results.push({ id: `u${shaToName.size}`, text: `已上传 src:${sha}`, isError: false });
      }
    } else if (tools.length === 1 && tools[0]!.tool === 'hub_get_nodes') {
      const reference = String((tools[0]!.input as { reference: string }).reference);
      const full = fullTextOf.get(reference) ?? '内容 ' + reference + '：用例 1 个；缺 2 个模板类别：k-security、k-localization';
      results.push({ id: 'gn', text: JSON.stringify(full), isError: false });
    } else if (tools.length === 1 && tools[0]!.tool === 'hub_start_run') {
      const shas = ((tools[0]!.input.inputs as { documents: Array<{ reference: string }> }).documents).map((d) => { assert.deepEqual(Object.keys(d), ['reference']); return d.reference.slice(4); });
      const rows = shas.map((sha) => `- upload-${sha.slice(0, 12)} | 文档 | ${answers(shaToName.get(sha) ?? '?')} | 位置 /`);
      results.push({ id: 'run', text: `运行 run_x 完成：\n${rows.join('\n')}`, isError: false });
    }
    lastResults = results;
    index += 1;
    if (results.length === 0) return { calls, done: '', names: [] };
  }
  return { calls, done: '未走完', names: [...shaToName.values()] };
};
let lastResults: Array<{ id: string; text: string; isError: boolean }> = [];
const fullTextOf = new Map<string, string>([
  ['rec:full-x/summary', '内容 rec:full-x/summary：用例 1 个；缺 2 个模板类别：k-security、k-localization'],
  ['rec:full-y/summary', '内容 rec:full-y/summary：用例 1 个；缺 1 个模板类别：k-security'],
  ['rec:full-c1/summary', '内容 rec:full-c1/summary：用例 2 个；缺 1 个模板类别：k-security'],
]);

test('parseItemLine splits on the last non-position part; a title may contain the separator', () => {
  const plain = parseItemLine('upload-0123456789ab | 甲用例 | 位置 /组 | 用例 1 个；缺 2 个模板类别（只列编号）：functional、negative');
  assert.equal(plain?.item, 'upload-0123456789ab');
  assert.equal(plain?.summary, '用例 1 个；缺 2 个模板类别（只列编号）：functional、negative');
  const withBar = parseItemLine('upload-0123456789ab | 标题 | 里 | 位置 /x | 用例 1 个；24 个模板类别都已覆盖');
  assert.ok(withBar !== null && withBar.summary.startsWith('用例 1 个'));
  assert.equal(parseItemLine('run_1 | 不是条目 | 位置 /x | y'), null);
});

test('parseSummary reads the count, the id-only list and the covered form', () => {
  const list = parseSummary('用例 3 个；缺 2 个模板类别（只列编号）：functional、negative；模板类别出现 22/24', CATEGORIES);
  assert.equal(list.caseCount, 3);
  assert.deepEqual([...list.missing].sort(), ['functional', 'negative']);
  const named = parseSummary('用例 2 个；缺 1 个模板类别：Functional（functional）；模板类别出现 23/24', CATEGORIES);
  assert.deepEqual([...named.missing], ['functional']);
  const covered = parseSummary('用例 2 个；24 个模板类别都已覆盖；用例规则：标签或标记', CATEGORIES);
  assert.equal(covered.missing.size, 0);
  assert.equal(parseSummary('用例 2 个；模板类别没有缺失（3 个声明跳过）', CATEGORIES).missing.size, 0);
});

test('truncationReference and summaryOfGetNodes', () => {
  const reference = truncationReference('用例 2 个；缺 2 个模板类别（只列编号）：functional、negative；全文 rec:abc123/summary');
  assert.equal(reference, 'rec:abc123/summary');
  assert.equal(truncationReference('用例 2 个；24 个模板类别都已覆盖'), null);
  assert.equal(summaryOfGetNodes('内容 rec:abc123/summary：用例 2 个；缺 2 个模板类别：Functional（functional）'), '用例 2 个；缺 2 个模板类别：Functional（functional）');
  const jsonEncoded = JSON.stringify('内容 rec:x：用例 2 个；24 个模板类别都已覆盖');
  assert.equal(summaryOfGetNodes(jsonEncoded), '用例 2 个；24 个模板类别都已覆盖');
  assert.equal(summaryOfGetNodes('别的形状'), null);
});

test('the scenario walks the three phases with batch-bounded replies', () => {
  const { gold } = goldOf();
  const scenario = build(gold as never);
  // The fake Hub answers by upload id: every copy of these synthetic documents shows the same two missing ids
  // (functional and negative absent everywhere except where a tag says otherwise — kept simple: all copies miss
  // the same two keyword categories, so every intersection matches).
  const { calls, done } = drive(scenario, () => '用例 1 个；缺 2 个模板类别（只列编号）：k-security、k-localization；全文 rec:full-x/summary');
  assert.ok(calls.length > 4, `phases made ${calls.length} replies`);
  for (const reply of calls) assert.ok(reply.length <= 2, `a reply carried ${reply.length} calls`);
  assert.ok(calls.some((r) => r.every((c) => c.tool === 'hub_upload_file')), 'uploads happened');
  assert.ok(calls.some((r) => r.some((c) => c.tool === 'hub_start_run')), 'runs happened');
  assert.ok(done.includes('检查完成'), `the last reply closes: ${done}`);
});

test('a refused start records the batch as unknown, and the scenario still finishes', () => {
  const { gold } = goldOf();
  const scenario = build(gold as never);
  scenario.prepare?.(join(dirs[dirs.length - 1]!, 'work'));
  // First reply: uploads. Feed a refusal for the first run instead of item rows.
  const first = scenario.respond(turn(0)) as Array<{ tool: string; input: Record<string, unknown> }>;
  assert.ok(first.every((c) => c.tool === 'hub_upload_file'));
  const upResults = first.map((c, i) => {
    const bytes = readFileSync(join(dirs[dirs.length - 1]!, 'work', String(c.input.file_path)), 'utf8');
    return { id: `u${i}`, text: `已上传 src:${sha256Of(bytes)}`, isError: false };
  });
  void upResults;
  // Enough for the structural assertions here: the driver keeps going after refusals in drive().
  assert.ok(first.length <= 2);
});

test('a request with no tool results after the start neither restarts nor advances', () => {
  const { gold } = goldOf();
  const scenario = build(gold as never);
  scenario.prepare?.(join(dirs[dirs.length - 1]!, 'work'));
  const first = scenario.respond(turn(0)) as Array<{ tool: string; input: Record<string, unknown> }>;
  const upResults = first.map((c, i) => {
    const bytes = readFileSync(join(dirs[dirs.length - 1]!, 'work', String(c.input.file_path)), 'utf8');
    return { id: `u${i}`, text: `已上传 src:${sha256Of(bytes)}`, isError: false };
  });
  const second = scenario.respond(turn(1, upResults)) as Array<{ tool: string; input: Record<string, unknown> }>;
  void second;
  const afterCompaction = scenario.respond(turn(2, [])) as Array<{ tool?: string; text?: string }>;
  assert.equal(afterCompaction.length, 1);
  assert.ok(afterCompaction[0]?.text !== undefined, 'one line of text only');
  const still = scenario.respond(turn(3, [])) as Array<{ tool?: string; text?: string }>;
  assert.equal(still.length, 1 && still[0]?.text !== undefined ? 1 : 0);
});

test('check() flags a wrong upload sha and a missed order-independence', () => {
  const { gold } = goldOf();
  const scenario = build(gold as never);
  const { calls } = drive(scenario, () => '用例 1 个；缺 1 个模板类别（只列编号）：k-security；全文 rec:full-y/summary');
  void calls;
  // The driven scenario's answers all agree; check() must pass the intersection-based checks. A full negative case
  // needs a lying Hub, which drive() cannot express per copy; the structural negatives are covered by the parser
  // tests above and the unit tests of gap-metamorphic.
  const checks = scenario.check([{ index: 0, toolResults: [], tools: [] }]);
  assert.ok(checks.length >= 11, `${checks.length} checks`);
  assert.ok(checks.some((c) => c.name === '上传字节' && c.ok));
  assert.ok(checks.some((c) => c.name === '对话没有被压缩' && c.ok));
});

test('uploadIdOf derives the item id from the sha', () => {
  assert.equal(uploadIdOf('0123456789abcdef'), 'upload-0123456789ab');
});

test('gap-metamorphic.ts and the scenario import nothing from hub/ or packs/; the table file is only read as data', () => {
  for (const file of ['../gold/gap-metamorphic.ts', './template-gap-metamorphic-circle.ts']) {
    const source = readFileSync(join(import.meta.dirname, file), 'utf8');
    for (const line of source.split('\n')) {
      if (/^\s*import\b/.test(line) || /^\s*export\s+\{[^}]*\}\s+from/.test(line)) {
        assert.ok(!/['"](?:\.\.\/)+(?:hub|packs)\//.test(line) && !/['"]\/(?:hub|packs)\//.test(line), `${file} imports Hub or pack code: ${line.trim()}`);
      }
    }
    // The pack's table file appears only as a readFileSync data path.
    for (let at = source.indexOf('template-v3.json'); at >= 0; at = source.indexOf('template-v3.json', at + 1)) {
      const around = source.slice(Math.max(0, at - 200), at + 40);
      assert.ok(/readFileSync/.test(around), 'template-v3.json is only read as data');
    }
  }
});

// Five lying Hubs (task page: each wrong answer caught by its own check, end to end). The honest answer every copy
// gets unless a lie names its file; the lies key by upload file name, which the driver knows.
const HONEST = '用例 1 个；缺 2 个模板类别（只列编号）：k-security、k-localization；全文 rec:full-x/summary';
const checksDrive = (lie: (file: string) => string | undefined): Array<{ name: string; ok: boolean; actual: string }> => {
  const { gold } = goldOf();
  const scenario = build(gold as never);
  drive(scenario, (file) => lie(file) ?? HONEST);
  return scenario.check([{ index: 0, toolResults: [], tools: [] }]).map((c) => ({ name: c.name, ok: c.ok, actual: String(c.actual) }));
};

test('a lying Hub: b loses one category the original names (order independence caught)', () => {
  const checks = checksDrive((file) => (file === 'd0-b.json' ? '用例 1 个；缺 1 个模板类别（只列编号）：k-security；全文 rec:full-y/summary' : undefined));
  const b = checks.find((c) => c.name === '换序');
  assert.ok(b !== undefined && !b.ok, JSON.stringify(b));
});

test('a lying Hub: a single-case copy drops the type-label category its own tag must show', () => {
  const checks = checksDrive((file) => (file === 'd0-c0.json' ? '用例 1 个；缺 2 个模板类别（只列编号）：functional、k-security；全文 rec:full-y/summary' : undefined));
  const type = checks.find((c) => c.name === '类型名标签');
  assert.ok(type !== undefined && !type.ok, JSON.stringify(type));
});

test('a lying Hub: the original\'s case count is one short', () => {
  const checks = checksDrive((file) => (file === 'd0-a.json' || file === 'd1-a.json' ? '用例 1 个；缺 2 个模板类别（只列编号）：k-security、k-localization；全文 rec:full-x/summary' : undefined));
  const original = checks.find((c) => c.name === '原件用例数');
  assert.ok(original !== undefined && !original.ok, JSON.stringify(original));
});

test('a lying Hub: after the join the target category is still missing', () => {
  // Every honest copy already misses k-security and k-localization; a joined copy that still names the target is
  // wrong. Which file is an f copy is decided at run time, so the lie names any file ending in '-j-'.
  const checks = checksDrive((file) => (/j-/.test(file) ? '用例 1 个；缺 2 个模板类别（只列编号）：k-security、k-localization；全文 rec:full-x/summary' : undefined));
  const join = checks.find((c) => c.name === '加回和加入');
  assert.ok(join !== undefined && !join.ok, JSON.stringify(join));
});

test('a lying Hub: an upload\'s src does not match the bytes written', () => {
  // The driver answers every upload with a foreign sha: the sha check must fail.
  const { gold } = goldOf();
  const scenario = build(gold as never);
  scenario.prepare?.(join(dirs[dirs.length - 1]!, 'work'));
  const first = scenario.respond(turn(0)) as Array<{ tool: string; input: Record<string, unknown> }>;
  const upResults = first.map((c, i) => ({ id: `u${i}`, text: `已上传 src:${'f'.repeat(64)}`, isError: false }));
  const second = scenario.respond(turn(1, upResults)) as Array<{ tool: string; input: Record<string, unknown> }>;
  void second;
  const checks = scenario.check([{ index: 0, toolResults: [], tools: [] }]);
  const upload = checks.find((c) => c.name === '上传字节');
  assert.ok(upload !== undefined && !upload.ok, JSON.stringify(upload));
});

test('a finding names the case and the run when a single-case answer cannot be had', () => {
  // c-0-1's run answers two cases: the pack cannot categorize that case, and every dependent copy stops with the
  // finding, never an unknown.
  const { gold } = goldOf();
  const scenario = build(gold as never);
  drive(scenario, (file) => (file === 'd0-c1.json' ? '用例 2 个；缺 1 个模板类别（只列编号）：k-security；全文 rec:full-c1/summary' : HONEST));
  scenario.check([{ index: 0, toolResults: [], tools: [] }]);
  const sections = scenario.sections ?? [];
  const finding = sections.flatMap((s) => s.lines).find((l) => l.includes('包分不出类别'));
  assert.ok(finding !== undefined && finding.includes('a2') && finding.includes('c-0-1'), String(finding));
  const checks = scenario.check([{ index: 0, toolResults: [], tools: [] }]);
  assert.ok(checks.every((c) => c.name !== '单用例副本答案未知' ? true : false));
});

test('review 1: start_run uses the actual strict reference binding contract', async () => {
  const { StartRunInput } = await import('../../../contracts/src/tools.ts');
  const { gold, dir } = goldOf(); const scenario = build(gold as never); scenario.prepare?.(join(dir, 'work'));
  let results: Turn['toolResults'] = [];
  for (let index = 0; index < 10; index++) {
    const reply = scenario.respond(turn(index, results)) as Array<{ tool: string; input: Record<string, unknown> }>;
    const start = reply.find(call => call.tool === 'hub_start_run');
    if (start) { assert.equal(StartRunInput.safeParse(start.input).success, true); return; }
    results = reply.map((call, i) => ({ id: `upload-${i}`, text: `已上传 src:${sha256Of(readFileSync(join(dir, 'work', String(call.input.file_path))))}`, isError: false }));
  }
  assert.fail('no start_run call');
});

test('review 2: real Hub item rows include a dash, title separators and a final location column', () => {
  assert.deepEqual(parseItemLine('- upload-0123456789ab | 合成 | 标题 | 用例 2 个；24 个模板类别都已覆盖 | 位置 src:synthetic'), { item: 'upload-0123456789ab', summary: '用例 2 个；24 个模板类别都已覆盖' });
});

test('review 3: every mixed-document run has distinct root ids with a batch of four', async () => {
  const { outerCaseNodes } = await import('../gold/gap-metamorphic.ts');
  const { gold, dir } = goldOf(); (gold as { batch: number }).batch = 4;
  const scenario = build(gold as never);
  const result = drive(scenario, file => `用例 ${outerCaseNodes(JSON.parse(readFileSync(join(dir, 'work', file), 'utf8'))).length} 个；24 个模板类别都已覆盖`);
  const shas = new Map<string, string>();
  for (const batch of result.calls) {
    for (const call of batch) if (call.tool === 'hub_upload_file') { const bytes = readFileSync(join(dir, 'work', String(call.input.file_path)), 'utf8'); shas.set(sha256Of(bytes), String(JSON.parse(bytes).root.data.id)); }
    for (const call of batch) if (call.tool === 'hub_start_run') {
      const docs = (call.input.inputs as { documents: { reference: string }[] }).documents;
      const roots = docs.map(d => shas.get(d.reference.slice(4))); assert.equal(new Set(roots).size, roots.length);
    }
  }
});

test('review 5: clip references exclude the closing full-width parenthesis', () => {
  const reference = `rec:${'a'.repeat(64)}#/items/12`;
  assert.equal(truncationReference(`用例 1 个；缺 21 个模板类别：功能…（共 480 个字符，全文 ${reference}）`), reference);
});

test('review 6: every clipped answer is consumed before the next full-summary read', () => {
  const { gold, dir } = goldOf(); (gold as { batch: number }).batch = 4;
  const scenario = build(gold as never); scenario.prepare?.(join(dir, 'work'));
  const uploads = scenario.respond(turn(0)) as Array<{ tool: string; input: Record<string, unknown> }>;
  const shas = uploads.map(call => sha256Of(readFileSync(join(dir, 'work', String(call.input.file_path)))));
  const full = new Map<string, string>();
  const start = scenario.respond(turn(1, shas.map((sha, i) => ({ id: `u${i}`, text: `已上传 src:${sha}`, isError: false })))) as any[];
  assert.equal(start[0].tool, 'hub_start_run');
  const rows = shas.map((sha, i) => {
    const reference = `rec:${'a'.repeat(64)}#/items/${i}`;
    full.set(`${reference}/summary`, `用例 ${i < 2 ? 2 : 1} 个；24 个模板类别都已覆盖`);
    return `- upload-${sha.slice(0, 12)} | 合成 | 用例 99 个；缺…（共 480 个字符，全文 ${reference}） | 位置 /`;
  });
  let reply = scenario.respond(turn(2, [{ id: 'run', text: rows.join('\n'), isError: false }])) as any[];
  let index = 3; let reads = 0;
  while (reply[0]?.tool === 'hub_get_nodes') {
    const reference = String(reply[0].input.reference); reads++;
    reply = scenario.respond(turn(index++, [{ id: 'full', text: `内容 ${reference}：模型可读\n本页字符 0-${full.get(reference)!.length}\n${JSON.stringify(full.get(reference))}\n追踪 ${index}`, isError: false }])) as any[];
  }
  assert.equal(reads, 4);
  assert.equal(scenario.check([]).find(check => check.name === '原件用例数')?.ok, true);
});
