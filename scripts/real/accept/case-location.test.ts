import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Synthetic renderer-shaped answers exercise document ownership, candidate fields, IDs, paging and redacted reports.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { LoggedTurn } from '../lib/accept.ts';
import { renderReport } from '../lib/report.ts';
import type { Turn } from '../scripted-model.ts';
import caseLocation, { MAX_PAGES, orderGoldCandidates, parseNextCall, parseReportedCandidates, type BuildCandidateGold, type DocumentLocationGold, type LocationGold } from './case-location.ts';

const builds = (line = '10.8.1'): BuildCandidateGold[] => {
  const stem = line.replaceAll('.', '_');
  return [
    { name: `Rel_FAMX_${stem}_41`, family: 'FAMX', base: `Rel_FAMX_${stem}_41`, built: '2026-08-20T12:30:40', released: '2026-08-21' },
    { name: `Rel_FAMY_${stem}_42`, family: 'FAMY', base: `Rel_FAMX_${stem}_41`, built: '2026-08-19T12:30:00', released: null },
  ];
};
const doc = (fields: Partial<DocumentLocationGold> = {}): DocumentLocationGold => ({ document: '930801', product: 'famx', line: '10.8.1', train: '10.8.1-R9', module: '合成模块甲', buildCandidates: builds(fields.line), ...fields });
const statement = (list: BuildCandidateGold[], line: string): string => `版本线 ${line} 的构建候选 ${list.length} 个，其中别名 ${list.filter(c => c.name !== c.base).length} 个（别名基于它所基于的构建），按制作时间从新到旧：` + orderGoldCandidates(list).slice(0, 12).map(c => `${c.name}（${c.family}${c.name !== c.base ? `，基于 ${c.base}` : ''}）${c.built ? `制作于 ${c.built.slice(0, 16).replaceAll('T', ' ')}` : '制作时间未知'}，${c.released ? `已发布 ${c.released}` : '未发布'}`).join('；') + (list.length > 12 ? `；另有 ${list.length - 12} 个` : '');
// 现行核对只认 JSON 里的 statement.verdict。候选原文放在 statement.text，判定不再靠句尾的“支持”。
const position = (id: string, requirement: string, said: string) => `    - 位置：条目 ${id}，要求项 ${requirement}，/data；陈述：${JSON.stringify({ statement: { verdict: 'support', text: said } })}；性质与依据等级：事实`;
const row = (d: DocumentLocationGold) => `- ${d.document} | 合成标题 | 产品线 famx；版本 ${d.line}（目录，置信度高）${d.train ? `；发布火车 ${d.train}` : ''}${d.module ? `；模块 ${d.module}` : ''}${d.stories?.length ? `；需求 ${d.stories.join('、')}` : ''}${d.bugs?.length ? `；缺陷 ${d.bugs.join('、')}` : ''}${d.unclassified?.length ? `；未分类编号 ${d.unclassified.join('、')}` : ''}`;
const answer = (d: DocumentLocationGold) => `问题与未知（条目 | 名称 | 分区 | 要求项）：\n- ${d.document} | 合成标题 | 未知 | other | 合成问题\n条目（1 个；编号 | 名称 | 摘要）：\n${row(d)}\n- ${d.document} | 合成标题 | 已交付\n  · location 用例定位：满足\n${position(d.document, 'location', row(d).split(' | ').slice(2).join(' | '))}\n  · build_candidates 构建候选：满足\n${position(d.document, 'build_candidates', statement(Array.isArray(d.buildCandidates) ? d.buildCandidates : d.buildCandidates!.candidates, d.line))}`;
const turnsOf = (text: string): LoggedTurn[] => [{ index: 0, tools: [], toolResults: [{ id: 'synthetic', text, isError: false }] }];
const checks = (d: DocumentLocationGold, text = answer(d)) => caseLocation(d).check(turnsOf(`运行 run_synthetic\n${text}`));
const allOk = (d: DocumentLocationGold, text = answer(d)) => checks(d, text).every(c => c.ok);
const idsCheck = (rows: ReturnType<typeof checks>) => rows.find(c => c.name.includes('关联编号集合'))!;
const candidateChecks = (d: DocumentLocationGold, text: string) => checks(d, text).filter(c => /候选|写出的构建名/.test(c.name));

describe('mandatory independent candidate input', () => {
  test('starts without buildCandidates but records a failed check instead of retaining the old success', () => {
    const scenario = caseLocation({ document: '930801', line: '10.8.1' });
    const rows = scenario.check(turnsOf('运行 run_synthetic'));
    assert.ok(rows.some(row => !row.ok && row.name.includes('候选')));
  });
  test('fails when version line mismatches', () => assert.ok(!allOk(doc(), answer(doc()).replaceAll('版本 10.8.1', '版本 10.9.1'))));
});

describe('candidate comparison', () => {
  test('holds when candidate set equals gold, alias brings out base, and written builds classify matching gold', () => {
    const d = doc({ buildCandidates: { candidates: builds(), written: [{ name: builds()[0].name, classification: 'known' }] } });
    const text = answer(d) + '\n' + position(d.document, 'build_candidates', `写出的构建名 ${builds()[0].name} 是定位到的版本线的构建`);
    assert.ok(allOk(d, text));
  });
  test('compares the built time and the based-on base of each candidate when gold carries them', () => {
    assert.ok(allOk(doc()));
    assert.ok(!allOk(doc(), answer(doc()).replaceAll('12:30', '12:31')));
  });
  test('fails when candidate set is missing one candidate', () => assert.ok(!allOk(doc(), answer(doc()).replace(/；Rel_FAMY[^；\n]+/, ''))));
  test('fails when candidate set has an extra candidate', () => assert.ok(!allOk(doc(), answer(doc()).replace('未发布"}', '未发布；Rel_FAMX_10_8_1_99（FAMX）制作时间未知，未发布"}'))));
  test('fails when alias does not bring out its base build', () => assert.ok(!allOk(doc(), answer(doc()).replaceAll('，基于 Rel_FAMX_10_8_1_41', ''))));
  test('fails when written build classification does not match gold', () => {
    const d = doc({ buildCandidates: { candidates: builds(), written: [{ name: builds()[0].name, classification: 'known' }] } });
    assert.ok(candidateChecks(d, answer(d) + '\n' + position(d.document, 'build_candidates', `知识库不认识写出的构建名 ${builds()[0].name}`)).some(c => c.name.includes('写出的构建名') && !c.ok));
  });
});

describe('fifteen candidates', () => {
  const list = [...builds(), ...Array.from({ length: 13 }, (_, i) => ({ name: `Rel_FAMX_10_8_1_${100 + i}`, family: 'FAMX', base: `Rel_FAMX_10_8_1_${100 + i}`, built: null, released: null }))];
  const d = doc({ buildCandidates: list });
  test('holds when candidate set equals top 12, more count matches 3, aliases and built times match', () => assert.ok(allOk(d)));
  test('fails when candidate set is missing one candidate', () => assert.ok(!allOk(d, answer(d).replace(/Rel_FAMX_10_8_1_41（FAMX）[^；]+；/, ''))));
  test('fails when candidate set has an extra candidate', () => assert.ok(!allOk(d, answer(d).replaceAll('；另有 3 个', '；Rel_FAMX_10_8_1_999（FAMX）制作时间未知，未发布；另有 3 个'))));
  test('fails when more count mismatches', () => assert.ok(!allOk(d, answer(d).replaceAll('另有 3 个', '另有 2 个'))));
});

describe('parseReportedCandidates and guideline section avoidance', () => {
  test('accurately matches conclusion prefix and parses top 12 candidates without being disturbed by section 4 guideline', () => {
    const list = [...builds(), ...Array.from({ length: 13 }, (_, i) => ({ name: `Rel_FAMX_10_8_1_${100 + i}`, family: 'FAMX', base: `Rel_FAMX_10_8_1_${100 + i}`, built: null, released: null }))];
    const result = parseReportedCandidates('4. 构建候选：例如 Rel_IGNORED\n' + statement(list, '10.8.1'));
    assert.equal(result.length, 12);
    assert.equal(result[0].name, list[0].name);
    assert.equal(result[1].base, list[0].name);
    assert.equal(result[0].built, '2026-08-20T12:30:00');
  });
  test('returns empty array when conclusion prefix is missing', () => assert.deepEqual(parseReportedCandidates('规程示例 Rel_IGNORED'), []));
});

describe('paging', () => {
  const rec = `rec:${'b'.repeat(64)}`;
  const turn = (index: number, text = ''): Turn => ({ index, toolResults: text ? [{ id: 'synthetic', text, isError: false }] : [] } as Turn);
  test('extracts reference and cursor from balanced JSON after 下一页：get_nodes ', () => assert.deepEqual(parseNextCall(`下一页：get_nodes {"reference":"${rec}","cursor":"next"}`), { reference: rec, cursor: 'next' }));
  test('handles nested braces and extracts first complete JSON object', () => assert.deepEqual(parseNextCall(`下一页：get_nodes {"reference":"${rec}","cursor":"next","nested":{"n":1}}`), { reference: rec, cursor: 'next' }));
  test('returns null when there is no next page line or invalid format', () => { assert.equal(parseNextCall('完成'), null); assert.equal(parseNextCall('下一页：get_nodes {broken'), null); });
  test('calls hub_get_nodes with reference in turn 1 when start_run returns rec reference', async () => {
    const s = caseLocation(doc()); await s.respond(turn(0));
    assert.deepEqual(await s.respond(turn(1, `完整结果 ${rec}：用 get_nodes 读`)), [{ tool: 'hub_get_nodes', input: { reference: rec } }]);
  });
  test('two-page answer flow: reads page 1, gets cursor, reads page 2, finishes and passes all candidate checks', async () => {
    const d = doc(), s = caseLocation(d), full = position(d.document, 'build_candidates', statement(builds(), d.line));
    const at = 170;
    await s.respond(turn(0)); await s.respond(turn(1, `完整结果 ${rec}：用 get_nodes 读`));
    const first = `条目（1 个；编号 | 名称 | 摘要）：\n${row(d)}\n- ${d.document} | 合成标题 | 已交付\n  · location 用例定位：满足\n${position(d.document, 'location', row(d).split(' | ').slice(2).join(' | '))}\n${full.slice(0, at)}\n下一页：get_nodes {"reference":"${rec}","cursor":"next"}`;
    assert.deepEqual(await s.respond(turn(2, first)), [{ tool: 'hub_get_nodes', input: { reference: rec, cursor: 'next' } }]);
    const second = `内容 ${rec}\n共 1 行，这一页从第 1 行的第 ${at + 1} 个字符起：\n（接上页：第 1 行的前 ${at} 个字符在上一页）\n${full.slice(at)}`;
    assert.deepEqual(await s.respond(turn(3, second)), [{ text: '定位完成。' }]);
    assert.ok(s.check([...turnsOf('运行 run_synthetic\n' + first), ...turnsOf(second)]).every(c => c.ok));
  });
  test('caps get_nodes paging at maximum 6 pages', async () => {
    const s = caseLocation(doc()); await s.respond(turn(0)); await s.respond(turn(1, `完整结果 ${rec}：用 get_nodes 读`));
    for (let i = 1; i < MAX_PAGES; i++) assert.ok('tool' in (await s.respond(turn(i + 1, `下一页：get_nodes {"reference":"${rec}","cursor":"next"}`)))[0]);
    assert.deepEqual(await s.respond(turn(20, `下一页：get_nodes {"reference":"${rec}","cursor":"next"}`)), [{ text: '定位完成。' }]);
  });
});

describe('document ownership and report redaction', () => {
  const docs = Array.from({ length: 5 }, (_, i) => doc({ document: String(930801 + i), line: i < 3 ? '10.8.1' : '10.9.1', module: i % 2 ? '合成模块乙' : '合成模块甲', stories: [String(810001 + i)], buildCandidates: builds(i < 3 ? '10.8.1' : '10.9.1') }));
  const text = '运行 run_synthetic\n' + docs.map(answer).join('\n');
  test('holds on a Hub-shaped multi-document answer with 5 items across 2 lines and 3 modules', () => assert.ok(caseLocation({ documents: docs }).check(turnsOf(text)).every(c => c.ok)));
  test('single document gold without plmFound has no sections; with plmFound outputs manual spot check section', () => {
    assert.equal(caseLocation(doc()).sections, undefined);
    const s = caseLocation(doc({ plmFound: { '810001': true, '810002': false } }));
    assert.deepEqual(s.sections?.[0].lines, ['找到 1 个，没找到 1 个']);
    assert.ok(!JSON.stringify(s.sections).includes('810001'));
  });
  test('fails when list has fewer than 5 documents or lacks line/module diversity', () => assert.ok(caseLocation({ documents: docs.slice(0, 2) }).check(turnsOf(text)).some(c => !c.ok)));
  test('fails when a document in the list has line mismatch', () => assert.ok(caseLocation({ documents: docs }).check(turnsOf(text.replaceAll('版本 10.9.1', '版本 10.8.1'))).some(c => !c.ok)));
  test('missing document rows never borrow another document with identical location and ids', () => {
    const d = doc({ stories: ['810002'] });
    const rows = checks(d, answer({ ...d, document: '930899' }));
    assert.ok(rows.some(c => !c.ok && c.name.includes('第 1 份文档') && c.name.includes('定位数据')));
    const report = renderReport({ title: '合成核对', generatedAt: 'synthetic', checks: rows, limits: [] });
    for (const value of [d.document, '930899', d.line, d.train!, d.module!, '810002', '合成标题', builds()[0].name]) assert.ok(!report.includes(value), value);
  });
  test('a location claim for the document supplies the row fallback, without using another requirement', () => {
    const d = doc(), claims = position(d.document, 'location', row(d));
    assert.ok(allOk(d, claims + '\n' + position(d.document, 'build_candidates', statement(builds(), d.line))));
    assert.ok(checks(d, claims.replaceAll('要求项 location', '要求项 something_else')).some(c => !c.ok && c.name.includes('定位数据')));
  });
});

describe('associated IDs and complete structured result data', () => {
  const d = doc({ stories: ['810001'], bugs: ['820001'], unclassified: ['830001'] });
  test('checks associated ID set and respective categories: bug to case (unclassified), bug to case 需求 (story), 缺陷 (bug)', () => assert.ok(allOk(d)));
  test('reads complete result from hub_get_nodes claim.statement.data when start_run summary is truncated with 等 N 个', () => {
    const data = JSON.stringify({ partitions: { delivered: [{ item: d.document, requirements: [{ requirement: 'location', claims: [{ statement: { data: { requirements: d.stories, defects: d.bugs, unclassified: d.unclassified } } }] }] }] } });
    const rows = caseLocation(d).check([...turnsOf('运行 run_synthetic\n' + answer(d).replaceAll('未分类编号 830001', '未分类编号 等 1 个')), ...turnsOf(data)]);
    assert.ok(rows.every(c => c.ok), JSON.stringify(rows));
  });
  test('a start_run summary that lists every id (the new full listing) passes without get_nodes data', () => assert.ok(allOk(d)));
  test('a summary capped at 20 with 另有 N 个 does not read the count as an id', () => {
    const many = doc({ unclassified: Array.from({ length: 22 }, (_, i) => String(830001 + i)) });
    const truncated = answer(many).replaceAll('、830021、830022', '；另有 2 个');
    const item = idsCheck(checks(many, truncated));
    assert.equal(item.ok, false); assert.match(item.actual, /缺 2 个/);
  });
  test('the src hex digest of a 位置 segment after the ids is not read as ids', () => assert.ok(allOk(d, answer(d).replaceAll('未分类编号 830001', `未分类编号 830001 | 位置 src:${'1'.repeat(64)}`))));
  test('fails when an associated ID is misclassified (gold expects defect but reported as unclassified)', () => assert.ok(checks(d, answer(d).replaceAll('缺陷 820001', '未分类编号 820001')).some(c => !c.ok && c.name.includes('缺陷分类'))));
  test('fails when associated ID set has missing or extra items', () => {
    const item = idsCheck(checks(d, answer(d).replaceAll('未分类编号 830001', '未分类编号 830099')));
    assert.equal(item.ok, false); assert.match(item.actual, /缺 1 个，多 1 个/);
  });
});

test('module and train fields match whole values rather than a prefix of another value', () => {
  const d = doc();
  assert.ok(checks(d, answer(d).replaceAll('模块 合成模块甲', '模块 合成模块甲额外')).some(c => c.name.includes('模块与') && !c.ok));
  assert.ok(checks(d, answer(d).replaceAll('发布火车 10.8.1-R9', '发布火车 10.8.1-R99')).some(c => c.name.includes('发布火车与') && !c.ok));
});

test('location review 1: real problem rows and result item blocks do not hide the own location claim', () => {
  const d = doc();
  const text = `运行 run_synthetic\n问题与未知（条目 | 名称 | 分区 | 要求项）：\n- ${d.document} | 合成标题 | 未知 | location | 输入缺少\n条目（1 个；编号 | 名称 | 摘要）：\n${row(d)}\n内容 rec:${'a'.repeat(64)}\n- ${d.document} | 合成标题 | 已交付\n  · location 用例定位：满足\n${position(d.document, 'location', row(d).split(' | ').slice(2).join(' | '))}\n  · build_candidates 构建候选：满足\n${position(d.document, 'build_candidates', statement(builds(), d.line))}`;
  assert.ok(allOk(d, text), JSON.stringify(checks(d, text).filter(c => !c.ok)));
});

test('location review 3: unknown location values cannot pass as facts and private reasons remain private', t => {
  const directory = mkdtempSync(join(tmpdir(), 'location-fact-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const d = doc({ product: undefined });
  const text = answer(d).replace(position(d.document, 'location', row(d).split(' | ').slice(2).join(' | ')), position(d.document, 'location', '定位不确定：根 private-root 不是产品名称；已知：' + row(d).split(' | ').slice(2).join(' | ')).replace('"verdict":"support"', '"verdict":"unknown","reason":"missing_input","missing":"产品名称","exit":{"action":"rerun"}'));
  const rows = caseLocation(d, directory).check(turnsOf('运行 run_synthetic\n' + text));
  assert.ok(rows.some(c => c.name.includes('定位结论是事实') && !c.ok));
  assert.ok(!JSON.stringify(rows).includes('private-root'));
  assert.ok(readFileSync(join(directory, 'case-location-details.json'), 'utf8').includes('private-root'));
  assert.equal(statSync(join(directory, 'case-location-details.json')).mode & 0o777, 0o600);
  const list = caseLocation({ product: 'famx', documents: [d] }).check(turnsOf('运行 run_synthetic\n' + answer(d).replaceAll('产品线 famx', '产品线 wrong-product')));
  assert.ok(list.some(c => c.name.includes('产品线') && !c.ok));
});

test('pack findings never accepts an unknown build-candidate claim whose values happen to match',()=>{
 const d=doc(),said=answer(d).replace(position(d.document,'build_candidates',statement(builds(),d.line)),position(d.document,'build_candidates',statement(builds(),d.line)).replace('"verdict":"support"','"verdict":"unknown","reason":"missing_input","missing":"构建候选","exit":{"action":"rerun"}'));
 const scenario=caseLocation(d);const rows=scenario.check(turnsOf('运行 run_synthetic\n'+said));assert.ok(rows.some(row=>!row.ok&&row.name.includes('构建候选结论')&&row.actual.includes('未知')));
 assert.ok(scenario.countLines?.some(line=>line.includes('原因')&&line.includes('下一步')));
 scenario.check(turnsOf('运行 run_synthetic\n'+answer(d)));assert.deepEqual(scenario.countLines,[]);
});
