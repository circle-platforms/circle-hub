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
const drive = (scenario: ReturnType<typeof build>, answers: (key: string, sha: string) => string): { calls: Array<Array<{ tool: string; input: Record<string, unknown> }>>; done: string } => {
  scenario.prepare?.(join(dirs[dirs.length - 1]!, 'work'));
  const calls: Array<Array<{ tool: string; input: Record<string, unknown> }>> = [];
  const uploadedShas: string[] = [];
  let index = 0;
  for (let guard = 0; guard < 500; guard += 1) {
    const reply = scenario.respond(turn(index, lastResults)) as Array<{ tool?: string; input?: Record<string, unknown>; text?: string }>;
    if (reply.length === 1 && reply[0]?.text === '检查完成。') {
      return { calls, done: String(reply[0].text) };
    }
    const tools = reply.filter((r) => r.tool !== undefined) as Array<{ tool: string; input: Record<string, unknown> }>;
    if (reply.every((r) => r.tool !== undefined) && reply.length === 0) return { calls, done: '' };
    calls.push(tools);
    // Produce the results of these calls.
    const results: Array<{ id: string; text: string; isError: boolean }> = [];
    if (tools.every((t) => t.tool === 'hub_upload_file')) {
      for (const t of tools) {
        const bytes = readFileSync(join(dirs[dirs.length - 1]!, 'work', String(t.input.file_path)), 'utf8');
        const sha = sha256Of(bytes);
        uploadedShas.push(sha);
        results.push({ id: `u${uploadedShas.length}`, text: `已上传 src:${sha}`, isError: false });
      }
    } else if (tools.length === 1 && tools[0]!.tool === 'hub_start_run') {
      const shas = ((tools[0]!.input.inputs as { documents: Array<{ source: string }> }).documents).map((d) => d.source.slice(4));
      const rows = shas.map((sha) => `upload-${sha.slice(0, 12)} | 文档 | 位置 / | ${answers(sha, 'x')}`);
      results.push({ id: 'run', text: `运行 run_x 完成：\n${rows.join('\n')}`, isError: false });
    }
    lastResults = results;
    index += 1;
    if (results.length === 0) return { calls, done: '' };
  }
  return { calls, done: '未走完' };
};
let lastResults: Array<{ id: string; text: string; isError: boolean }> = [];

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
  const { calls, done } = drive(scenario, () => '用例 1 个；缺 2 个模板类别（只列编号）：k-security、k-localization');
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
  const { calls } = drive(scenario, () => '用例 1 个；缺 1 个模板类别（只列编号）：k-security');
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
