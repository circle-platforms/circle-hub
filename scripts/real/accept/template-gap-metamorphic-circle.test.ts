// Synthetic independent category declarations, formatted through the real Hub text renderer.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
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
interface FakeOptions { mutate?: (info: CopyInfo, answer: Answer) => Answer; hide?: string; badUpload?: boolean; refuseStart?: boolean; dropRows?: boolean }
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
  let results: Turn['toolResults'] = []; let seq = 0; let run = 0;
  const trace = () => (++seq).toString(16).padStart(32, '0');
  for (let index = 0; index < 1000; index++) {
    const reply = scenario.respond(turn(index, results)) as any[];
    if (reply.length === 1 && reply[0]?.text === '检查完成。') return { calls, done: reply[0].text as string, names: infos.map(info => info.name), infos, checks: scenario.check([]) };
    const tools = reply.filter(call => typeof call.tool === 'string') as { tool: string; input: Record<string, unknown> }[];
    if (!tools.length) return { calls, done: String(reply[0]?.text ?? ''), names: infos.map(info => info.name), infos, checks: scenario.check([]) };
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
          const value = StartRunOutput.parse({ call_result: 'ok', trace: token, errors: [], run: { run: `run_${run.toString(36).padStart(26, '0')}`, pack: 'template-gap@1.0.0', pack_digest: sha256Of('synthetic-pack'), target_basis: [], sources: [], requirements: [], items: options.dropRows ? [] : items, instructions: '合成规程', instructions_digest: sha256Of('synthetic-instructions'), started_at: '2026-01-01T00:00:00.000Z' }, result: { reference: `rec:${sha256Of(`synthetic-result-${run}`)}`, counts: { delivered: items.length, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 } } });
          text = toolText('start_run', value, { paging: true, record });
        }
      } else {
        assert.equal(call.tool, 'hub_get_nodes'); const reference = String(call.input.reference); const summary = full.get(reference);
        if (summary === undefined) { isError = true; text = toolText('get_nodes', { call_result: 'error', trace: token, errors: [{ code: 'SOURCE_UNAVAILABLE', message: '对你不可用' }] }); }
        else text = toolText('get_nodes', GetNodesOutput.parse({ call_result: 'ok', trace: token, errors: [], content: { reference, read_tier: 'model_readable', readable: true, text: JSON.stringify(summary) } }), { paging: true });
      }
      results.push({ id: `tool-${seq}`, text, isError });
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
  const text = `内容 ${ref}/summary：模型可读\n原文（1 行）：\n${JSON.stringify(summary)}\n追踪 synthetic`;
  assert.equal(summaryOfGetNodes(text, `${ref}/summary`), summary);
  assert.equal(summaryOfGetNodes(JSON.stringify(text), `${ref}/summary`), summary);
  assert.equal(summaryOfGetNodes('别的形状'), null);
});

test('the scenario walks the three phases with batch-bounded replies', () => {
  const { gold } = goldOf(); gold.batch = 4; const scenario = build(gold); const result = drive(scenario);
  assert.equal(result.done, '检查完成。'); assert.ok(result.checks.every(check => check.ok), JSON.stringify(result.checks.filter(check => !check.ok)));
  for (const batch of result.calls) assert.ok(batch.length <= gold.batch);
  const counts = Object.fromEntries(['a','b','c','d','e','f'].map(kind => [kind, result.infos.filter(info => info.kind === kind).length]));
  assert.deepEqual(counts, { a: 2, b: 2, c: 4, d: 6, e: 6, f: 4 });
});
test('a refused start records the batch as unknown, and the scenario still finishes', () => {
  const { gold } = goldOf(); const scenario = build(gold); const result = drive(scenario, undefined, { refuseStart: true });
  assert.equal(result.done, '检查完成。'); assert.equal(result.checks.find(check => check.name === '副本回答完整')?.ok, false);
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
  assert.equal(result.checks.find(check => check.name === '换序')?.ok, false);
  assert.equal(result.checks.find(check => check.name === '上传字节')?.ok, true);
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
  assert.equal(wrong.checks.find(check => check.name === target)?.ok, false);
  return wrong;
}
test('a lying Hub: b loses one category the original names (order independence caught)', () => {
  lying({ mutate: (info, answer) => { if (info.kind === 'b') answer.missing.add('security'); return answer; } }, '换序');
});
test('a lying Hub: a single-case copy drops the type-label category its own tag must show', () => {
  const result = lying({ hide: 'functional' }, '类型名标签');
  assert.deepEqual(result.checks.filter(check => !check.ok).map(check => check.name), ['类型名标签']);
});
test('a lying Hub: the original case count is one short', () => {
  lying({ mutate: (info, answer) => ({ ...answer, count: ['a','b'].includes(info.kind) ? answer.count - 1 : answer.count }) }, '原件用例数');
});
test('a lying Hub: a single-case answer loses a category declared by its ancestor', () => {
  lying({ mutate: (info, answer) => { if (info.document === 0 && info.kind === 'c' && info.ordinal === 0) answer.missing.add('security'); return answer; } }, '拆分');
});
test('a lying Hub: after the join the target category is still missing', () => {
  lying({ mutate: (info, answer) => { if (info.kind === 'f') answer.missing.add(info.category!); return answer; } }, '加回和加入');
});
test('a lying Hub: an upload source does not match the bytes written', () => { lying({ badUpload: true }, '上传字节'); });
test('a finding names an anonymous case and run when a single-case answer cannot be had', () => {
  const { gold } = goldOf(); const scenario = build(gold);
  const result = drive(scenario, undefined, { mutate: (info, answer) => ({ ...answer, count: info.document === 0 && info.kind === 'c' && info.ordinal === 1 ? 9 : answer.count }) });
  assert.equal(result.checks.find(check => check.name === '单用例副本用例数')?.ok, false);
  assert.ok(scenario.sections?.some(section => section.lines.some(line => line.includes('包分不出类别'))));
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
    reply = scenario.respond(turn(index++, [{ id: 'full', text: `内容 ${reference}：模型可读\n本页字符 0-${full.get(reference)!.length}\n${JSON.stringify(full.get(reference))}\n追踪 ${index}`, isError: false }])) as any[];
  }
  assert.equal(reads, 4);
  assert.equal(scenario.check([]).find(check => check.name === '原件用例数')?.ok, true);
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
  assert.equal(scenario.check([]).find(check => check.name === '上传字节')?.ok, true);
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
  assert.equal(scenario.check([]).find(check => check.name === '上传字节')?.ok, false);
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
  assert.ok(!checks.some(check => check.ok && !['上传字节', '对话没有被压缩'].includes(check.name)));
  assert.equal(checks.find(check => check.name === '副本回答完整')?.ok, false);
});
test('review 9: missing or malformed category output is not interpreted as complete coverage', () => {
  assert.equal(parseSummary('用例 1 个；没有类别结果', CATEGORIES).valid, false);
  assert.equal(parseSummary('用例 1 个；缺 2 个模板类别：功能测试（functional）', CATEGORIES).valid, false);
  assert.equal(parseSummary('用例 1 个；缺 1 个模板类别：不存在（not_in_table）', CATEGORIES).valid, false);
});
