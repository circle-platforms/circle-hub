import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LoggedTurn } from '../lib/accept.ts';
import scenario, { type BuildCandidateGold, orderGoldCandidates } from './case-location.ts';

const candidates: BuildCandidateGold[] = [
  { name: 'Rel_FAMX_10_8_1_21', family: 'FAMX', base: 'Rel_FAMX_10_8_1_21', built: '2026-08-02T12:34:50', released: '2026-08-03' },
  { name: 'Rel_FAMY_10_8_1_22', family: 'FAMY', base: 'Rel_FAMX_10_8_1_21', built: null, released: null },
];
export function candidateStatement(list: BuildCandidateGold[]): string {
  const ordered = orderGoldCandidates(list);
  return `版本线 10.8.1 的构建候选 ${list.length} 个，其中别名 ${list.filter(c => c.name !== c.base).length} 个（别名基于它所基于的构建），按制作时间从新到旧：` + ordered.slice(0, 12).map(c => `${c.name}（${c.family}${c.base === c.name ? '' : `，基于 ${c.base}`}）${c.built ? `制作于 ${c.built.slice(0, 16).replace('T', ' ')}` : '制作时间未知'}，${c.released ? `已发布 ${c.released}` : '未发布'}`).join('；') + (list.length > 12 ? `；另有 ${list.length - 12} 个` : '');
}
const claim = (id: string, text: string) => `    - 位置：条目 ${id}，要求项 build_candidates，/data；陈述：${JSON.stringify({ statement: { verdict: 'support', text } })}；性质与依据等级：事实`;
const turns = (text: string): LoggedTurn[] => [{ index: 0, tools: [], toolResults: [{ id: 'synthetic', isError: false, text }] }];
const gold = { document: '930201', line: '10.8.1', buildCandidates: candidates };
const locationClaim = JSON.stringify({ statement: { verdict: 'support', text: '产品线 famx；版本 10.8.1（目录，置信度高）' } });
const locationBlock = `问题与未知（条目 | 名称 | 分区 | 要求项）：\n- 930201 | 合成文档 | 未知 | other | 合成问题\n条目（1 个；编号 | 名称 | 摘要）：\n- 930201 | 合成文档 | 产品线 famx；版本 10.8.1（目录，置信度高）\n- 930201 | 合成文档 | 已交付\n  · location 用例定位：满足\n    - 位置：条目 930201，要求项 location，/data；陈述：${locationClaim}；性质与依据等级：事实\n  · build_candidates 构建候选：满足`;
const checks = (text: string, input = gold) => scenario(input).check(turns(`运行 run_synthetic\n${locationBlock}\n${text}`)).filter(c => /候选|名称族|别名/.test(c.name));

test('two families and an alias compare every displayed field', () => {
  const result = checks(claim(gold.document, candidateStatement(candidates)));
  assert.ok(result.length > 5);
  assert.ok(result.every(c => c.ok), JSON.stringify(result));
});
test('candidate gold is mandatory', () => {
  const rows = scenario({ document: gold.document, line: gold.line }).check(turns('运行 run_synthetic'));
  assert.ok(rows.some(row => !row.ok && row.name.includes('候选')));
});

for (const [name, transform] of [
  ['missing claim', () => ''],
  ['another document', (text: string) => text.replace(gold.document, '930202')],
  ['unknown claim', (text: string) => text.replace('"verdict":"support"', '"verdict":"unknown","reason":"missing_input","missing":"合成构建事实","exit":{"action":"rerun"}')],
  ['wrong family', (text: string) => text.replace('（FAMY，', '（FAMX，')],
  ['wrong base', (text: string) => text.replace('基于 Rel_FAMX_10_8_1_21', '基于 Rel_FAMX_10_8_1_20')],
  ['wrong built time', (text: string) => text.replace('12:34', '12:35')],
  ['wrong released state', (text: string) => text.replace('已发布 2026-08-03', '未发布')],
  ['wrong release date', (text: string) => text.replace('2026-08-03', '2026-08-04')],
  ['wrong order', () => claim(gold.document, candidateStatement(candidates).replace(/(Rel_FAMX_10_8_1_21（FAMX）[^；]+)；(Rel_FAMY[^；]+)/, '$2；$1'))],
] as const) test(name, () => assert.ok(checks(transform(claim(gold.document, candidateStatement(candidates)))).some(c => !c.ok)));

test('fifteen candidates compare the ordered first twelve and own remaining count', () => {
  const list = [...candidates.map(c => ({ ...c, built: c.built ?? '2026-08-01T00:00:00' })), ...Array.from({ length: 13 }, (_, i) => ({ name: `Rel_FAMX_10_8_1_${100 + i}`, family: 'FAMX', base: `Rel_FAMX_10_8_1_${100 + i}`, built: null, released: null }))];
  const input = { ...gold, buildCandidates: list };
  const good = checks(claim(gold.document, candidateStatement(list)), input);
  assert.ok(good.every(c => c.ok), JSON.stringify(good));
  const wrong = claim(gold.document, candidateStatement(list).replace('另有 3 个', '另有 2 个'));
  assert.ok(checks(wrong + '\n- 930201 | 标题 | 未分类编号 123456；另有 3 个', input).some(c => !c.ok));
});
test('an unrelated associated-id remainder cannot supply a missing candidate remainder', () => {
  const list = [...candidates.map(c => ({ ...c, built: c.built ?? '2026-08-01T00:00:00' })), ...Array.from({ length: 13 }, (_, i) => ({ name: `Rel_FAMX_10_8_1_${100 + i}`, family: 'FAMX', base: `Rel_FAMX_10_8_1_${100 + i}`, built: null, released: null }))];
  const text = claim(gold.document, candidateStatement(list).replace('；另有 3 个', '')) + '\n- 930201 | 标题 | 未分类编号 123456；另有 3 个';
  assert.ok(checks(text, { ...gold, buildCandidates: list }).some(c => !c.ok));
});
test('coverage fails without FAMY and aliases', () => {
  const list = [candidates[0]];
  assert.ok(checks(claim(gold.document, candidateStatement(list)), { ...gold, buildCandidates: list }).some(c => !c.ok));
});
test('a page-split claim is reassembled before extracting its own candidates', () => {
  const text = claim(gold.document, candidateStatement(candidates)), at = 150;
  const pages = turns('运行 run_synthetic\n' + locationBlock + '\n' + text.slice(0, at));
  pages.push({ index: 1, tools: [], toolResults: [{ id: 'page2', isError: false, text: `内容 rec:${'a'.repeat(64)}\n共 1 行，这一页从第 1 行的第 ${at + 1} 个字符起：\n（接上页：第 1 行的前 ${at} 个字符在上一页）\n${text.slice(at)}` }] });
  const result = scenario(gold).check(pages).filter(c => /候选|名称族|别名/.test(c.name));
  assert.ok(result.every(c => c.ok), JSON.stringify(result));
});
