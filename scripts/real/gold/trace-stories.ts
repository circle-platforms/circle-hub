// Independent raw-input oracle. No runtime imports from Hub or packs.
import type { ProvenanceType } from '../../../contracts/generated/vocabulary.ts';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { caseGold, parseMindMap } from './cases.ts';
import { extractAssociatedIds, locationsGold } from './locations.ts';
import { parseDocumentList } from './trace.ts';

export type Scalar = string | number | boolean | null;
const scalar = (value: unknown): Scalar => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : null;
export type StoryRecord = { id: string | number; status?: unknown; stage?: unknown; title?: unknown };
export type StoryGoldRow = { story: string; status: Scalar; stage: Scalar; fields_absent?: string[]; plm_returned: boolean; cases: Array<{ id: string; title: string }> };
export type StoryGold = { product: string; build: string; stories: StoryGoldRow[]; traced: number; untraced: number; plm_unread: number; status_absent?: number; statuses: Array<{ status: Scalar; count: number }>; documents: number; documents_without_cases: number; missing_documents: string[]; scope: ProvenanceType };
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (id: string): string => id.replace(/^0+/, '') || '0';
const isId = (id: string): boolean => /^[0-9]{1,15}$/.test(id) && norm(id) !== '0';


// Temporary compatibility until the integrator merges the shared extractor fix (gold-trace 36455d4).
// Use collision-free, equal-width numeric stand-ins only inside labels, then restore and normalise extracted ids.
// Keeping the width preserves the extractor's version/date/short-number boundary rules; document ids never change.
class CompatibilityError extends Error {}
function zeroPrefixCompatibility(raw: unknown) {
  const labels: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (!record(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && ['label', 'title', 'name', 'text'].includes(key)) labels.push(child.normalize('NFKC'));
      else collect(child);
    }
  };
  collect(raw);
  const runs = labels.flatMap(label => label.match(/[0-9]+/g) ?? []);
  const occupied = new Set(runs);
  const tokens = [...new Set(runs.filter(id => id.length >= 2 && id.length <= 9 && id.startsWith('0')))];
  const forward = new Map<string, string>(); const backward = new Map<string, string>();
  const date = (text: string): boolean => text.length === 8 && Number(text.slice(0, 4)) >= 1970 && Number(text.slice(0, 4)) <= 2099 && Number(text.slice(4, 6)) >= 1 && Number(text.slice(4, 6)) <= 12 && Number(text.slice(6, 8)) >= 1 && Number(text.slice(6, 8)) <= 31;
  for (let width = 2; width <= 9; width++) {
    const pending = tokens.filter(id => id.length === width).sort(); let candidate = 10 ** (width - 1);
    for (const [at, id] of pending.entries()) {
      while (candidate < 10 ** width && (occupied.has(String(candidate)) || date(String(candidate)))) candidate++;
      if (candidate >= 10 ** width) throw new CompatibilityError(`编号兼容空间不足：位宽 ${width}，尚缺 ${pending.length - at} 个占位值`);
      const standIn = String(candidate++); occupied.add(standIn); forward.set(id, standIn); backward.set(standIn, norm(id));
    }
  }
  const encode = (text: string): string => text.normalize('NFKC').replace(/[0-9]+/g, id => forward.get(id) ?? id);
  const decode = (id: string): string => backward.get(id) ?? norm(id);
  const tree = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(tree);
    if (!record(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key,
      typeof child === 'string' && ['label', 'title', 'name', 'text'].includes(key) ? encode(child) : tree(child)]));
  };
  return { encode, decode, tree };
}

export function parseStoryIds(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.stories) ? raw.stories : null;
  if (!list || list.length === 0 || list.some(id => (typeof id !== 'string' && typeof id !== 'number') || !isId(String(id)))) throw new Error('需求编号列表无效');
  return [...new Set(list.map(id => norm(String(id))))].sort((a, b) => Number(a) - Number(b));
}
export function parseStoryRecords(raw: unknown): StoryRecord[] {
  const list = Array.isArray(raw) ? raw : record(raw) && Array.isArray(raw.stories) ? raw.stories : record(raw) && Array.isArray(raw.data) ? raw.data : null;
  if (list === null || list.some(r => !record(r) || !isId(String(r.id)))) throw new Error('PLM 原件形状无效');
  return list as StoryRecord[];
}
export function storyGold(options: { ids: string[]; plm: StoryRecord[]; maps: Array<{ document: string; map: unknown }>; tree: unknown; product: string; build: string; caseRule?: 'marked' | 'tagged'; missingDocuments?: string[] }): StoryGold {
  const ids = parseStoryIds(options.ids);
  const parsed = options.maps.map(({ map }) => parseMindMap(map).nodes);
  const compatibility = zeroPrefixCompatibility([options.tree, parsed.flatMap(nodes => nodes.map(node => ({ text: node.text })))]);
  const locations = locationsGold(compatibility.tree(options.tree));
  const folderStories = new Map([...locations.documents, ...locations.nonconforming].map(d => [d.document, d.stories.map(compatibility.decode)]));
  const cases: Array<{ id: string; title: string; stories: string[] }> = [];
  let documentsWithoutCases = 0;
  for (const [at, { document, map }] of options.maps.entries()) {
    const nodes = parsed[at];
    let counted;
    try { counted = caseGold([{ document, map }], { caseRule: options.caseRule ?? 'marked' }).documents[0]; }
    catch (error) {
      if (error instanceof Error && /^文档 .* 里没有带(?:资源标签|用例标记或资源标签)的用例节点$/.test(error.message)) { documentsWithoutCases++; continue; }
      throw error;
    }
    for (const c of counted.items) {
      const node = nodes.find(n => (n.id || `@${n.index}`) === c.id);
      if (!node) throw new Error('用例节点位置缺失');
      const found = extractAssociatedIds(compatibility.encode(node.text), node.ancestors.map(compatibility.encode)).stories.map(compatibility.decode);
      cases.push({ id: `${document}:${c.id}`, title: c.title, stories: [...found, ...(folderStories.get(document) ?? [])].map(norm) });
    }
  }
  const stories = ids.map((id): StoryGoldRow => {
    const returned = options.plm.filter(r => norm(String(r.id)) === id);
    const first = returned[0];
    if (returned.some(r => JSON.stringify([r.status ?? null, r.stage ?? null]) !== JSON.stringify([first.status ?? null, first.stage ?? null]))) throw new Error('需求原件冲突');
    return { story: id, status: scalar(first?.status), stage: scalar(first?.stage), fields_absent: first ? ['status', 'stage'].filter(key => !Object.hasOwn(first, key)) : [], plm_returned: returned.length > 0,
      cases: cases.filter(c => c.stories.some(s => s === id)).map(c => ({ id: c.id, title: c.title })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
  });
  const traced = stories.filter(s => s.cases.length > 0).length;
  const states = new Map<Scalar, number>();
  for (const s of stories) if (s.plm_returned && !s.fields_absent?.includes('status')) states.set(s.status, (states.get(s.status) ?? 0) + 1);
  return { product: options.product, build: options.build, stories, traced, untraced: stories.length - traced, plm_unread: stories.filter(s => !s.plm_returned).length,
    status_absent: stories.filter(s => s.plm_returned && s.fields_absent?.includes('status')).length, statuses: [...states].sort(([a], [b]) => JSON.stringify([typeof a, a]) < JSON.stringify([typeof b, b]) ? -1 : JSON.stringify([typeof a, a]) > JSON.stringify([typeof b, b]) ? 1 : 0).map(([status, count]) => ({ status, count })), documents: options.maps.length, documents_without_cases: documentsWithoutCases,
    missing_documents: options.missingDocuments ?? [], scope: 'declared' };
}
export function main(argv: string[]): number {
  const value = (name: string) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const names = ['stories', 'cases-dir', 'tree', 'docs', 'product', 'build', 'out'];
  if (names.some(n => !value(n))) { process.stderr.write('用法：trace-stories.ts --stories <文件> --plm <文件>… --cases-dir <目录> --tree <文件> --docs <文件> --product <产品> --build <构建> --out <文件>\n'); return 2; }
  try {
    const read = (path: string): unknown => JSON.parse(readFileSync(resolve(path), 'utf8'));
    const docs = parseDocumentList(readFileSync(resolve(value('docs')!), 'utf8'));
    if (docs.size === 0) throw new Error('文档清单为空');
    const maps: Array<{ document: string; map: unknown }> = [];
    for (const file of readdirSync(resolve(value('cases-dir')!)).sort()) {
      const document = file.replace(/\.(?:km\.)?json$/i, '');
      if (!/\.json$/i.test(file) || !docs.has(document)) continue;
      maps.push({ document, map: read(resolve(value('cases-dir')!, file)) });
    }
    const missingDocuments = [...docs].filter(d => !maps.some(m => m.document === d)).sort();
    const plm = [];
    for (let i = 0; i < argv.length; i++) if (argv[i] === '--plm') {
      for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) plm.push(...parseStoryRecords(read(argv[j])));
    }
    if (!argv.includes('--plm')) throw new Error('缺少 PLM 原件');
    const caseRule = value('case-rule');
    if (caseRule !== undefined && caseRule !== 'marked' && caseRule !== 'tagged') throw new Error('用例规则无效');
    const gold = storyGold({ ids: parseStoryIds(read(value('stories')!)), plm, maps, tree: read(value('tree')!), product: value('product')!, build: value('build')!, caseRule, missingDocuments });
    const text = JSON.stringify(gold, null, 2) + '\n';
    writeFileSync(resolve(value('out')!), text);
    process.stdout.write(`需求 ${gold.stories.length}；已追溯 ${gold.traced}；未追溯 ${gold.untraced}；PLM 未返回 ${gold.plm_unread}；文档 ${maps.length}；无用例文档 ${gold.documents_without_cases}；缺原件 ${missingDocuments.length}；SHA-256 ${createHash('sha256').update(text).digest('hex').slice(0, 12)}；${missingDocuments.length ? '不通过' : '通过'}\n`);
    return missingDocuments.length ? 1 : 0;
  } catch (error) { process.stderr.write(error instanceof CompatibilityError ? `生成需求独立答案不通过；${error.message}\n` : '生成需求独立答案不通过；请核对输入原件和编号清单\n'); return 1; }
}
if (import.meta.main) process.exitCode = main(process.argv.slice(2));
