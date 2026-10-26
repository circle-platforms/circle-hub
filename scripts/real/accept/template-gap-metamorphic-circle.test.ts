// Synthetic independent category declarations, formatted through the real Hub text renderer.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { StartRunInput, StartRunOutput, UploadFileOutput, GetNodesOutput } from '../../../contracts/src/tools.ts';
import { toolText } from '../../../hub/server/text.ts';
import type { Turn } from '../scripted-model.ts';
import { caseNodesOf, parseMindMap } from '../gold/cases.ts';
import { parseItemLine, parseSummary, sha256Of, summaryOfGetNodes, truncationReference, uploadIdOf, default as build } from './template-gap-metamorphic-circle.ts';
import { readCategories, type MindTree } from '../gold/gap-metamorphic.ts';

const CATEGORIES = readCategories(JSON.parse(readFileSync(join(import.meta.dirname, '../../../packs/workflow/template-gap/tables/template-v3.json'), 'utf8')));
const leaf = (id: string, text: string): any => ({ data: { id, text }, children: [] });
const kase = (id: string, text: string, expected: string, tag = 'Configuration'): any => ({ data: { id, text, resource: [tag], priority: 2, __present: [tag.toLowerCase()] }, children: [leaf(`${id}e`, expected)] });
const group = (id: string, text: string, ...children: any[]): any => ({ data: { id, text }, children });
const declaredGroup = (id: string, present: string[], ...children: any[]): any => ({ data: { id, text: '合成分组', __present: present }, children });
const docOf = (...cases: any[]): { root: any } => ({ root: group('r', '合成文档', group('g', '合成分组', ...cases)) });
const turn = (index: number, toolResults: Turn['toolResults'] = []): Turn => ({ index, system: null, messages: [], tools: [], toolResults });
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function goldOf(): { gold: any; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gap-scenario-')); dirs.push(dir);
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ root: group('ra', '合成文档甲', declaredGroup('ga1', ['security'], kase('a1', '合成甲一', '成功', 'Functional')), kase('a2', '合成甲二', '成功', 'Configuration')) }));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ root: group('rb', '合成文档乙', declaredGroup('gb1', ['database'], kase('b1', '合成乙一', '成功', 'Stress')), kase('b2', '合成乙二', '成功', 'Configuration')) }));
  return { gold: { documents: [{ file: join(dir, 'a.json') }, { file: join(dir, 'b.json') }], maxCases: 80, batch: 2 }, dir };
}
interface CopyInfo { name: string; tree: MindTree; sha: string; document: number; kind: string; category?: string; ordinal?: number }
interface Answer { count: number; missing: Set<string> }
interface FakeOptions { mutate?: (info: CopyInfo, answer: Answer) => Answer; hide?: string; badUpload?: boolean; refuseStart?: boolean; dropRows?: boolean; dropSingleRow?: boolean; prelude?: string; corruptSummaryLength?: boolean }
function truth(tree: MindTree): Answer {
  const map = parseMindMap(tree); const raw: any[] = []; const walk = (node: any) => { raw.push(node); (node.children ?? []).forEach(walk); }; walk(tree.root);
  const cases = caseNodesOf(map); const present = new Set<string>();
  for (const node of cases) for (let at: number | null = node.index; at !== null; at = map.nodes[at]!.parent) for (const id of raw[at]?.data?.__present ?? []) present.add(id);
  return { count: cases.length, missing: new Set(CATEGORIES.map(c => c.id).filter(id => !present.has(id))) };
}
function summaryOf(answer: Answer): string {
  const missing = CATEGORIES.filter(c => answer.missing.has(c.id));
  const compose = (named: boolean) => `用例 ${answer.count} 个；${missing.length ? `缺 ${missing.length} 个模板类别${named ? '' : '（只列编号）'}：${missing.map(c => named ? `${c.label}（${c.id}）` : c.id).join('、')}` : '24 个模板类别都已覆盖'}；模板类别出现 ${24 - missing.length}/24 个；用例规则：标签或标记；其中 0 个只靠标记识别（没有标签）`;
  const named = compose(true); return named.length <= 480 ? named : compose(false);
}
function drive(scenario: ReturnType<typeof build>, answerText?: (file: string) => string, options: FakeOptions = {}) {
  const dir = dirs[dirs.length - 1]!; const work = join(dir, 'work'); scenario.prepare?.(work);
  const calls: { tool: string; input: Record<string, unknown> }[][] = []; const infos: CopyInfo[] = []; const accepted = new Map<string, CopyInfo>(); const full = new Map<string, string>();
  let results: Turn['toolResults'] = []; let seq = 0; let run = 0; let rawSummaryReads = 0;
  const trace = () => (++seq).toString(16).padStart(32, '0');
  for (let index = 0; index < 1000; index++) {
    const reply = scenario.respond(turn(index, results)) as any[];
    if (reply.length === 1 && reply[0]?.text === '检查完成。') return { calls, rawSummaryReads, done: reply[0].text as string, names: infos.map(info => info.name), infos, checks: scenario.check([]) };
    const tools = reply.filter(call => typeof call.tool === 'string') as { tool: string; input: Record<string, unknown> }[];
    if (!tools.length) return { calls, rawSummaryReads, done: String(reply[0]?.text ?? ''), names: infos.map(info => info.name), infos, checks: scenario.check([]) };
    calls.push(tools); results = [];
    for (const call of tools) {
      const token = trace(); let text: string; let isError = false;
      if (call.tool === 'hub_upload_file') {
        const name = String(call.input.file_path); assert.equal(isAbsolute(name), false); assert.equal(call.input.media_type, 'application/json');
        const bytes = readFileSync(join(work, name)); const sha = sha256Of(bytes); const tree = JSON.parse(bytes.toString()) as MindTree;
        const match = /^gap-doc([0-9]+)-([abdef])(?:-(.*))?$/.exec(String(tree.root.data.id)); const single = /^gap-doc([0-9]+)-c([0-9]+)$/.exec(String(tree.root.data.id));
        assert.ok(match || single, 'synthetic copy identity');
        const info: CopyInfo = { name, tree, sha, document: Number((match ?? single)![1]) - 1, kind: single ? 'c' : match![2]!, ...(single ? { ordinal: Number(single[2]) - 1 } : match?.[3] ? { category: match[3] } : {}) }; infos.push(info);
        const reported = options.badUpload ? 'f'.repeat(64) : sha; accepted.set(reported, info);
        const value = UploadFileOutput.parse({ call_result: 'ok', trace: token, errors: [], acceptance: 'accepted', reference: `src:${reported}`, sha256: reported, size: bytes.length, media_type: 'application/json', structure: { parser: 'kityminder@1', summary: { nodes: parseMindMap(tree).nodes.length } } });
        text = toolText('upload_file', value);
      } else if (call.tool === 'hub_start_run') {
        const parsed = StartRunInput.safeParse(call.input); const docs = parsed.success ? (parsed.data.inputs.documents as { reference: string }[]) : [];
        const copies = docs.map(doc => accepted.get(doc.reference?.slice(4)));
        if (!parsed.success || options.refuseStart || copies.some(copy => !copy) || new Set(copies.map(copy => copy?.tree.root.data.id)).size !== copies.length) {
          isError = true; text = toolText('start_run', { call_result: 'error', trace: token, errors: [{ code: 'SUBMISSION_SCHEMA_VIOLATION', message: '合成拒绝', fix: '核对输入' }] });
        } else {
          const record = `rec:${sha256Of(`synthetic-run-${++run}`)}`;
          const items = copies.filter((copy): copy is CopyInfo => !!copy).reverse().map((info, at) => {
            let answer = truth(info.tree); if (options.hide) answer.missing.add(options.hide); if (options.mutate) answer = options.mutate(info, answer);
            const summary = answerText?.(info.name) ?? summaryOf(answer); full.set(`${record}#/items/${at}/summary`, summary);
            return { id: uploadIdOf(info.sha), label: String(info.tree.root.data.text), summary, location: `src:${info.sha}`, fields: {} };
          });
          const value = StartRunOutput.parse({ call_result: 'ok', trace: token, errors: [], run: { run: `run_${run.toString(36).padStart(26, '0')}`, pack: 'template-gap@1.0.0', pack_digest: sha256Of('synthetic-pack'), target_basis: [], sources: [], requirements: [], items: options.dropRows ? [] : options.dropSingleRow && copies.some(c=>c?.kind==='c') ? items.filter(item=>item.id!==uploadIdOf(copies.find(c=>c?.kind==='c' && c.document===0)!.sha)) : items, instructions: '合成规程', instructions_digest: sha256Of('synthetic-instructions'), started_at: '2026-01-01T00:00:00.000Z' }, result: { reference: `rec:${sha256Of(`synthetic-result-${run}`)}`, counts: { delivered: items.length, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 } } });
          text = toolText('start_run', value, { paging: true, record });
        }
      } else {
        assert.equal(call.tool, 'hub_get_nodes'); const reference = String(call.input.reference); const summary = full.get(reference);
        if (summary === undefined) { isError = true; text = toolText('get_nodes', { call_result: 'error', trace: token, errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用' }] }); }
        else {
          text = toolText('get_nodes', GetNodesOutput.parse({ call_result: 'ok', trace: token, errors: [], content: { reference, read_tier: 'model_readable', readable: true, text: summary } }), { paging: true });
          if (options.corruptSummaryLength) text = text.replace(/原文（\d+ 个字符）/, '原文（1 个字符）');
        }
      }
      if (call.tool === 'hub_get_nodes' && !isError && text.split('\n').some(line=>line.startsWith('用例 '))) rawSummaryReads++;
      results.push({ id: `tool-${seq}`, text: (options.prelude ?? '') + text, isError });
    }
    if (tools.every(call => call.tool === 'hub_upload_file')) results.reverse();
  }
  throw new Error('synthetic scenario did not finish');
}

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
  const ref = `rec:${'a'.repeat(64)}#/items/0`;
  assert.equal(truncationReference(`用例 2 个…（共 480 个字符，全文 ${ref}）`), ref);
  assert.equal(truncationReference('用例 2 个；24 个模板类别都已覆盖'), null);
  const summary = '用例 2 个；24 个模板类别都已覆盖';
  const text = `内容 ${ref}/summary：模型可读\n原文（1 行）：\n${summary}\n追踪 synthetic`;
  assert.equal(summaryOfGetNodes(text, `${ref}/summary`), summary);
  assert.equal(summaryOfGetNodes(JSON.stringify(text), `${ref}/summary`), summary);
  assert.equal(summaryOfGetNodes('别的形状'), null);
});

test('full summary accepts only recognized client preludes and checks declared UTF-16 character counts', () => {
  const reference = `rec:${'a'.repeat(64)}#/items/0/summary`;
  const summary = '用例 2 个；24 个模板类别都已覆盖；合成😀';
  for (const prefix of ['', '\n', 'Hook allowed this call.\n\n']) {
    const text = `${prefix}内容 ${reference}：模型可读\n原文（${summary.length} 个字符）：\n${summary}\n追踪 ${'1'.repeat(32)}`;
    assert.equal(summaryOfGetNodes(text, reference), summary);
    assert.equal(summaryOfGetNodes(JSON.stringify(text), reference), summary);
    assert.equal(summaryOfGetNodes(text.replace(`（${summary.length} 个字符）`, `（${summary.length + 1} 个字符）`), reference), null);
    assert.equal(summaryOfGetNodes(text.replace('模型可读', '只保留')), null);
  }
  for (const prefix of ['Unrecognized prelude\n', 'Hook allowed this call.\nUnrecognized prelude\n', 'Hook allowed this call. extra\n']) {
    assert.equal(summaryOfGetNodes(`${prefix}内容 ${reference}：模型可读\n原文（${summary.length} 个字符）：\n${summary}\n追踪 synthetic`, reference), null);
  }
});

test('the scenario walks the three phases with batch-bounded replies', () => {
  const { gold } = goldOf(); gold.batch = 4; const scenario = build(gold); const result = drive(scenario);
  assert.equal(result.done, '检查完成。'); assert.ok(result.checks.every(check => check.ok), JSON.stringify(result.checks.filter(check => !check.ok)));
  for (const batch of result.calls) assert.ok(batch.length <= gold.batch);
  const counts = Object.fromEntries(['a','b','c','d','e','f'].map(kind => [kind, result.infos.filter(info => info.kind === kind).length]));
  assert.deepEqual(counts, { a: 2, b: 2, c: 4, d: 6, e: 6, f: 4 });
});

test('hook-prefixed real-shaped results complete all phases and full-summary reads', () => {
  const { gold } = goldOf(); gold.batch = 4;
  const result = drive(build(gold), undefined, { prelude: 'Hook allowed this call.\n\n' });
  assert.ok(result.rawSummaryReads >= 4);
  assert.equal(result.done, '检查完成。');
  assert.ok(result.checks.every(check => check.ok), JSON.stringify(result.checks.filter(check => !check.ok)));
});

test('a wrong summary character count names the missing full text and reference-based recovery', () => {
  const { gold } = goldOf(); gold.batch = 4;
  const scenario = build(gold);
  const result = drive(scenario, undefined, { prelude: 'Hook allowed this call.\n\n', corruptSummaryLength: true });
  assert.ok(result.rawSummaryReads >= 4);
  assert.ok(result.checks.some(check => !check.ok));
  const report = JSON.stringify(scenario.sections);
  assert.match(report, /缺少与原文声明 1 个字符一致的完整摘要（实际 \d+ 个字符）/);
  assert.match(report, /下一步.*rec:[a-f0-9]{64}#\/items\/\d+\/summary.*hub_get_nodes 重读/);
});
test('a refused start records the batch as unknown, and the scenario still finishes', () => {
  const { gold } = goldOf(); const scenario = build(gold); const result = drive(scenario, undefined, { refuseStart: true });
  assert.equal(result.done, '检查完成。'); assert.equal(result.checks.find(check => check.name.endsWith('副本回答完整'))?.ok, false);
  assert.ok(scenario.sections?.some(section => section.lines.some(line => line.includes('开始运行被拒'))));
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

test('check() flags a missed order-independence against a passing honest baseline', () => {
  const { gold } = goldOf(); const result = drive(build(gold), undefined, { mutate: (info, answer) => { if (info.kind === 'b') answer.missing.add('security'); return answer; } });
  assert.equal(result.checks.find(check => check.name.endsWith('换序'))?.ok, false);
  assert.equal(result.checks.find(check => check.name.endsWith('上传字节'))?.ok, true);
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

function lying(options: FakeOptions, target: string) {
  const { gold } = goldOf(); const honest = drive(build(gold)); assert.ok(honest.checks.every(check => check.ok));
  const wrong = drive(build(gold), undefined, options);
  assert.equal(wrong.checks.find(check => check.name.endsWith(target))?.ok, false);
  return wrong;
}
test('a lying Hub: b loses one category the original names (order independence caught)', () => {
  lying({ mutate: (info, answer) => { if (info.kind === 'b') answer.missing.add('security'); return answer; } }, '换序');
});
test('a lying Hub: a single-case copy drops the type-label category its own tag must show', () => {
  const result = lying({ hide: 'functional' }, '类型名标签');
  assert.equal(result.checks.filter(check => !check.ok).length, 1); assert.ok(result.checks.find(check => !check.ok)!.name.endsWith('类型名标签'));
});
test('a lying Hub: the original case count is one short', () => {
  lying({ mutate: (info, answer) => ({ ...answer, count: ['a','b'].includes(info.kind) ? answer.count - 1 : answer.count }) }, '原件用例数');
});
test('a lying Hub: a single-case answer loses a category declared by its ancestor', () => {
  lying({ mutate: (info, answer) => { if (info.document === 0 && info.kind === 'c' && info.ordinal === 0) answer.missing.add('security'); return answer; } }, '拆分');
});
test('a lying Hub: after the join the target category is still missing', () => {
  lying({ mutate: (info, answer) => { if (info.kind === 'f') answer.missing.add(info.category!); return answer; } }, '加入');
});
test('a lying Hub: an upload source does not match the bytes written', () => { lying({ badUpload: true }, '上传字节'); });
test('a finding names an anonymous case and run when a single-case answer cannot be had', () => {
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, undefined, { mutate: (info, answer) => ({ ...answer, count: info.document === 0 && info.kind === 'c' && info.ordinal === 1 ? 9 : answer.count }) });
  assert.equal(result.checks.find(check => check.name.endsWith('单用例副本用例数'))?.ok, false);
  assert.ok(scenario.sections?.some(section => section.lines.some(line => line.includes('结果不可核对'))));
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
    full.set(`${reference}/summary`, `用例 ${2} 个；24 个模板类别都已覆盖`);
    return `- upload-${sha.slice(0, 12)} | 合成 | 用例 99 个；缺…（共 480 个字符，全文 ${reference}） | 位置 /`;
  });
  let reply = scenario.respond(turn(2, [{ id: 'run', text: rows.join('\n'), isError: false }])) as any[];
  let index = 3; let reads = 0;
  while (reply[0]?.tool === 'hub_get_nodes') {
    const reference = String(reply[0].input.reference); reads++;
    reply = scenario.respond(turn(index++, [{ id: 'full', text: `内容 ${reference}：模型可读\n本页字符 0-${full.get(reference)!.length}\n${full.get(reference)}\n追踪 ${index}`, isError: false }])) as any[];
  }
  assert.equal(reads, 4);
  assert.equal(scenario.check([]).find(check => check.name.endsWith('原件用例数'))?.ok, true);
});

test('review 7: full-summary reads match their reference and exclude tier, page metadata and trace', () => {
  const reference = `rec:${'b'.repeat(64)}#/items/0/summary`;
  const summary = '用例 2 个；24 个模板类别都已覆盖';
  const reply = (trace: string) => `内容 ${reference}：模型可读\n原文（1 行）：\n${JSON.stringify(summary)}\n追踪 ${trace}`;
  assert.equal(summaryOfGetNodes(reply('first'), reference), summary);
  assert.equal(summaryOfGetNodes(reply('second'), reference), summary);
  assert.equal(summaryOfGetNodes(reply('first'), reference.replace('/0/', '/1/')), null);
});

test('review 8: a promoted tagged group makes the deletion copy not done instead of uploading it', async () => {
  const { outerCaseNodes } = await import('../gold/gap-metamorphic.ts');
  const { gold, dir } = goldOf();
  writeFileSync(join(dir, 'a.json'), JSON.stringify({ root: group('r', '合成', { data: { id: 'g', text: '组', resource: ['Configuration'], priority: 1 }, children: [kase('a1', '甲', '成功', 'Functional')] }, kase('a2', '乙', '成功', 'Configuration')) }));
  const scenario = build(gold as never);
  const result = drive(scenario, file => {
    const tree = JSON.parse(readFileSync(join(dir, 'work', file), 'utf8'));
    const missing = tree.root.data.id === 'gap-doc1-c2' ? '缺 1 个模板类别：功能测试（functional）' : '24 个模板类别都已覆盖';
    return `用例 ${outerCaseNodes(tree).length} 个；${missing}`;
  });
  const roots = result.names.map(file => String(JSON.parse(readFileSync(join(dir, 'work', file), 'utf8')).root.data.id));
  assert.ok(!roots.includes('gap-doc1-d-functional'));
  scenario.check([]); assert.ok(scenario.sections?.some(section => section.lines.some(line => line.includes('前提不成立'))));
});

test('review 10: upload replies match by source digest even when their order is reversed', () => {
  const { gold, dir } = goldOf(); (gold as { batch: number }).batch = 4;
  const scenario = build(gold as never); scenario.prepare?.(join(dir, 'work'));
  const uploads = scenario.respond(turn(0)) as any[];
  const results = uploads.map((call, i) => ({ id: `u${i}`, text: `已上传 src:${sha256Of(readFileSync(join(dir, 'work', String(call.input.file_path))))}`, isError: false })).reverse();
  scenario.respond(turn(1, results));
  assert.equal(scenario.check([]).find(check => check.name.endsWith('上传字节'))?.ok, true);
});
test('review 10: a later refusal cannot erase failed upload evidence or bind those failed copies', () => {
  const { gold, dir } = goldOf(); const scenario = build(gold as never); scenario.prepare?.(join(dir, 'work'));
  let results: Turn['toolResults'] = []; const failed = new Set<string>(); const bound: string[] = [];
  for (let index = 0; index < 100; index++) {
    const reply = scenario.respond(turn(index, results)) as any[];
    if (reply[0]?.text === '检查完成。') break;
    results = reply.map((call, i) => {
      if (call.tool === 'hub_upload_file') { failed.add(sha256Of(readFileSync(join(dir, 'work', String(call.input.file_path))))); return { id: `u${i}`, text: `已上传 src:${'f'.repeat(64)}`, isError: false }; }
      if (call.tool === 'hub_start_run') bound.push(...call.input.inputs.documents.map((d: { reference: string }) => d.reference.slice(4)));
      return { id: `r${i}`, text: '调用结果：出错', isError: true };
    });
  }
  assert.equal(scenario.check([]).find(check => check.name.endsWith('上传字节'))?.ok, false);
  assert.ok(bound.every(sha => !failed.has(sha)));
});

test('review 9: absent Hub outputs cannot pass any result-dependent check', () => {
  const { gold, dir } = goldOf(); const scenario = build(gold as never); scenario.prepare?.(join(dir, 'work'));
  let results: Turn['toolResults'] = []; let starts = 0;
  for (let index = 0; index < 100; index++) {
    const reply = scenario.respond(turn(index, results)) as any[]; if (reply[0]?.text === '检查完成。') break;
    results = reply.map((call, i) => {
      if (call.tool === 'hub_upload_file') return { id: `u${i}`, text: `已上传 src:${sha256Of(readFileSync(join(dir, 'work', String(call.input.file_path))))}`, isError: false };
      if (call.tool === 'hub_start_run') starts++;
      return { id: `r${i}`, text: '调用结果：出错', isError: true };
    });
  }
  assert.ok(starts > 0);
  const checks = scenario.check([]);
  assert.ok(!checks.some(check => check.ok && !['上传字节', '对话没有被压缩'].some(name => check.name.endsWith(name))));
  assert.equal(checks.find(check => check.name.endsWith('副本回答完整'))?.ok, false);
});
test('review 9: missing or malformed category output is not interpreted as complete coverage', () => {
  assert.equal(parseSummary('用例 1 个；没有类别结果', CATEGORIES).valid, false);
  assert.equal(parseSummary('用例 1 个；缺 2 个模板类别：功能测试（functional）', CATEGORIES).valid, false);
  assert.equal(parseSummary('用例 1 个；缺 1 个模板类别：不存在（not_in_table）', CATEGORIES).valid, false);
});

test('review 11: reports identify a failed case by ordinal and copy hash, never node text or ids', () => {
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, undefined, { mutate: (info, answer) => ({ ...answer, count: info.document === 0 && info.kind === 'c' && info.ordinal === 1 ? 9 : answer.count }) });
  const sha = result.infos.find(info => info.document === 0 && info.kind === 'c' && info.ordinal === 1)!.sha.slice(0, 12);
  const lines = scenario.sections!.flatMap(section => section.lines);
  assert.ok(lines.some(line => line.includes('用例 2') && line.includes(sha)));
  assert.doesNotMatch(JSON.stringify({ checks: result.checks, sections: scenario.sections }), /合成文档甲|合成甲二|\ba2\b/);
  assert.ok(result.names.every(name => /^[0-9]+\.json$/.test(name)));
});

test('review 14: evidence is per document and copy, and category tallies compare each membership', () => {
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, undefined, { mutate: (info, answer) => { if (info.document === 0 && info.kind === 'b') answer.missing.add('security'); return answer; } });
  const ordered = result.checks.filter(check => check.name.endsWith('换序'));
  assert.equal(ordered.length, 2); assert.equal(ordered[0]?.ok, false); assert.equal(ordered[1]?.ok, true);
  const sha = result.infos.find(info => info.document === 0 && info.kind === 'b')!.sha.slice(0, 12);
  assert.match(ordered[0]!.actual, new RegExp(sha)); assert.match(ordered[0]!.actual, /多出.*security/); assert.match(ordered[0]!.actual, /少掉/);
  const lines = scenario.sections!.flatMap(section => section.lines);
  assert.match(lines.find(line => line.startsWith('security（'))!, /b 相符 1 不符 1/);
  assert.match(lines.find(line => line.startsWith('database（'))!, /b 相符 2 不符 0/);
});

test('review 16: invalid gold records a field-specific refusal before any tool call', () => {
  const { gold, dir } = goldOf(); writeFileSync(join(dir, 'notes.json'), JSON.stringify({ root: group('notes', '合成说明') }));
  const inputs = [
    { value: {}, field: 'documents' }, { value: { ...gold, documents: [] }, field: 'documents' },
    { value: { ...gold, batch: 0 }, field: 'batch' }, { value: { ...gold, batch: undefined }, field: 'batch' },
    { value: { ...gold, maxCases: undefined }, field: 'maxCases' }, { value: { ...gold, maxCases: 1 }, field: 'maxCases' },
    { value: { ...gold, documents: [{ file: join(dir, 'notes.json') }, gold.documents[1]] }, field: '用例' },
  ];
  for (const { value, field } of inputs) {
    const scenario = build(value as never); const reply = scenario.respond(turn(0)) as any[];
    assert.ok(reply.length > 0 && reply.every(item => typeof item.text === 'string'));
    const checks = scenario.check([]); assert.ok(checks.some(check => !check.ok && check.actual.includes(field)));
    assert.ok(!JSON.stringify(checks).includes(dir));
  }
});

test('review 17: words and protocol code names inside a document label do not reject a successful run', () => {
  const { gold } = goldOf();
  for (const document of gold.documents) { const tree = JSON.parse(readFileSync(document.file, 'utf8')); tree.root.data.text = '合成出错处理 no_case CREDENTIAL_IN_UPLOAD'; writeFileSync(document.file, JSON.stringify(tree)); }
  const result = drive(build(gold)); assert.ok(result.checks.every(check => check.ok), JSON.stringify(result.checks.filter(check => !check.ok)));
});

test('review 18: a complete id-only form is not a clip and an unrecognized clip ends with a recorded failure', () => {
  assert.equal(truncationReference('用例 1 个；缺 1 个模板类别（只列编号）：security'), null);
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, () => '用例 2 个；缺 12 个模板类别：集成测试（integration）、兼容性…（共 353 个字符）');
  assert.match(result.done, /停止|不符/); assert.ok(result.checks.some(check => !check.ok && check.name.includes('读取格式')));
  assert.ok(result.infos.every(info => ['a','b'].includes(info.kind)));
  assert.match(JSON.stringify(scenario.sections), /下一步|修复/);
});

test('review 19: only documents with matching original counts enter the single-case phase', () => {
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, undefined, { mutate: (info, answer) => ({ ...answer, count: info.document === 0 && info.kind === 'a' ? answer.count - 1 : answer.count }) });
  assert.equal(result.infos.filter(info => info.document === 0 && info.kind === 'c').length, 0);
  assert.ok(result.infos.some(info => info.document === 1 && info.kind === 'c'));
  assert.ok(scenario.sections?.some(section => section.lines.some(line => line.includes('原件') && line.includes('独立计数'))));
});

test('review 20: nested tagged cases contribute types and counts inside the outer single-case copy', () => {
  const { gold } = goldOf(); const path = gold.documents[0].file; const tree = JSON.parse(readFileSync(path, 'utf8'));
  tree.root.children[0].children[0].children.push(kase('nested-private', '合成嵌套', '成功', 'Negative')); writeFileSync(path, JSON.stringify(tree));
  const honest = drive(build(gold)); assert.ok(honest.checks.every(check => check.ok), JSON.stringify(honest.checks.filter(check => !check.ok)));
  const wrong = drive(build(gold), undefined, { hide: 'negative' });
  assert.equal(wrong.checks.find(check => check.name.startsWith('第 1 份') && check.name.endsWith('类型名标签'))?.ok, false);
  assert.equal(wrong.checks.filter(check => !check.ok).length, 1);
});


test('review 21: a real preparation failure removes its isolated token home before the runner exits', () => {
  const root = mkdtempSync(join(tmpdir(), 'gap-runner-cleanup-')); dirs.push(root); const temp = join(root, 'tmp'); mkdirSync(temp);
  const module = join(root, 'scenario.ts'); const gold = join(root, 'gold.json'); const out = join(root, 'out');
  writeFileSync(gold, '{}');
  writeFileSync(module, `export default function () { return { name: 'synthetic', area: '合成', prompt: '', respond: () => [{text:'done'}], check: () => [], prepare: () => { throw new Error('Synthetic preparation failure'); } }; }`);
  const token = 's'.repeat(43);
  const child = spawnSync(process.execPath, ['scripts/real/accept-circle.ts', '--scenario', module, '--gold', gold, '--out', out, '--hub-url', 'http://127.0.0.1:1/mcp'], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: root, TMPDIR: temp, HUB_REAL_TOKEN: token } });
  assert.notEqual(child.status, 0); assert.match(child.stderr, /Synthetic preparation failure/);
  assert.ok(!(child.stdout + child.stderr).includes(token));
  assert.deepEqual(readdirSync(temp), []);
});

test('review 22: explicit screen count lines include phases, categories and not-done reasons', async () => {
  const { gold } = goldOf(); gold.batch = 4; const scenario = build(gold); const result = drive(scenario);
  const lines = (scenario as typeof scenario & { countLines?: string[] }).countLines ?? [];
  assert.ok(lines.includes('第 1 段：上传 4，运行 1'));
  assert.ok(lines.includes('第 2 段：上传 4，运行 1'));
  assert.ok(lines.includes('第 3 段：上传 16，运行 4'));
  assert.equal(lines.filter(line => CATEGORIES.some(category => line.startsWith(category.id + '（'))).length, 24);
  assert.ok(lines.some(line => line.startsWith('没做：')));
  const { summaryLines } = await import('../accept-circle.ts');
  const output = summaryLines(result.checks, lines).join('\n');
  assert.match(output, /共 [0-9]+ 项核对/); assert.doesNotMatch(output, /合成文档甲|合成甲一|\ba1\b/);
  assert.deepEqual(summaryLines([{ area: '合成', name: '合成核对', ok: true, expected: 'PRIVATE-SYNTHETIC', actual: 'PRIVATE-SYNTHETIC' }]), ['相符：合成核对', '共 1 项核对，1 项相符，0 项不符']);
});

test('closure unknown phase-two batch never feeds phase-three copies or agreement-looking evidence', () => {
 const {gold}=goldOf();gold.batch=20;const scenario=build(gold);const result=drive(scenario,undefined,{dropSingleRow:true});
 assert.equal(result.infos.filter(info=>['d','e','f'].includes(info.kind)).length,0);
 const lines=scenario.sections?.flatMap(s=>s.lines).join('\n') ?? '';assert.match(lines,/单用例副本答案未知/);
 for(const check of result.checks.filter(c=>c.name.includes('单用例副本用例数'))){assert.ok(!/用例 \d+\/\d+/.test(check.actual));assert.ok(check.actual.includes('条目数与这一批的份数不符'));}
});

test('closure every anonymous unknown count names its own executable next action', () => {
 for(const options of [{badUpload:true},{dropRows:true},{refuseStart:true},{mutate:(info:CopyInfo,answer:Answer)=>({...answer,count:info.kind==='a'?99:answer.count})}]) {
  const {gold}=goldOf();const scenario=build(gold);drive(scenario,undefined,options);
  const skipped=(scenario.countLines ?? []).filter(line=>line.startsWith('没做：'));
  assert.ok(skipped.length);for(const line of skipped)assert.ok(line.includes('下一步'),line);
  const text=scenario.sections?.flatMap(s=>s.lines).join('\n') ?? '';
  if('badUpload' in options)assert.match(text,/上传被拒[\s\S]*下一步[\s\S]*上传应答/);
 }
});

test('closure honest three-phase driver exercises raw summary string records', () => {
 const {gold}=goldOf();const run=drive(build(gold));assert.ok(run.checks.every(check=>check.ok));
 assert.ok(run.rawSummaryReads>0,'at least one complete summary uses the real raw-string record layout');
});

test('c3 every per-category not-done line names a cause-specific recovery',()=>{
 for(const options of [{},{dropSingleRow:true}]){
  const {gold}=goldOf();gold.batch=20;const scenario=build(gold);drive(scenario,undefined,options);
  const lines=scenario.sections?.find(s=>s.title==='没做的副本（按原因）')?.lines ?? [];assert.ok(lines.length);
  for(const line of lines)assert.ok(line.includes('下一步'),line);
  for(const line of lines.filter(l=>/^第 \d+ 份文档.*单用例副本答案未知/.test(l))){assert.match(line,/下一步重读或重跑第 2 段/);assert.doesNotMatch(line,/换用/);}
 }
});
