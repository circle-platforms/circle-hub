// Expected sources of a case-location run (expected-sources-input@1 -> expected-sources-output@1): the PLM stories and bugs the
// items link (in the title, the folders below the version level, a case's map), bound with role expected so that their text
// is part of the run and the linked ids can be checked against the defect system. A requirement id is read as
// plm:story:<id>, a defect id as plm:bug:<id>, an unmarked id as the kind the caller's id ranges give it (a declaration, said
// in the reason). An unmarked id whose kind nothing decides is not read: stories and bugs are separate numberings, so a guess
// would show a false evidence gap for the kind that does not exist, or bind an unrelated record of the other numbering.
import { bugToCaseIds } from './ids.ts';
import { displayId, locate, locateInputOf } from './locate.ts';
import { PACK, guarded, isRecord } from './text.ts';
import type { IdSource, LinkedId, PackWarning } from './types.ts';

/** Most sources one run binds (each is one read of the defect system). */
export const MAX_SOURCES = 200;
/** Unread ids named in the warning. */
const MAX_NAMED = 50;

type Source = { external: string; role: 'expected'; reason: string };

const WHERE: Readonly<Record<IdSource, string>> = { title: '标题', folders: '上级目录', map: '脑图路径' };
const KIND = { story: '需求', bug: '缺陷' } as const;

const whereOf = (sources: readonly LinkedId[], id: string, kind: LinkedId['kind']): string => WHERE[sources.find((s) => s.id === id && s.kind === kind)?.from[0] ?? 'title'];

export function expectedSources(input: unknown): { sources: Source[]; warnings: PackWarning[] } {
  const raw = isRecord(input) ? input : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const parameters = raw.parameters ?? context.parameters;
  const sources: Source[] = [];
  const warnings: PackWarning[] = [];
  const seen = new Set<string>();
  const unread: string[] = [];
  const unreadOriginals = new Map<string, string>();
  let dropped = 0;
  const bind = (external: string, reason: string): void => {
    if (seen.has(external)) return;
    seen.add(external);
    if (sources.length >= MAX_SOURCES) {
      dropped += 1;
      return;
    }
    sources.push({ external, role: 'expected', reason });
  };
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    const locatedInput = locateInputOf(item.id, item.fields, { ...context, parameters });
    const answer = locate(locatedInput);
    const titleBugs = new Set(bugToCaseIds(locatedInput.title ?? ''));
    for (const [kind, ids] of [['story', answer.requirements], ['bug', answer.defects]] as const) {
      for (const id of ids) bind(`plm:${kind}:${id}`, kind === 'bug' && titleBugs.has(id) ? `条目 ${item.id} 的标题里“bug to case”后面的编号 ${displayId(answer, id, kind)}，按缺陷号读` : `条目 ${item.id} 的${whereOf(answer.id_sources, id, kind)}里标明的${KIND[kind]} ${displayId(answer, id, kind)}`);
    }
    for (const [kind, ids] of [['story', answer.ranged.requirements], ['bug', answer.ranged.defects]] as const) {
      for (const id of ids) bind(`plm:${kind}:${id}`, `条目 ${item.id} 的${whereOf(answer.id_sources, id, null)}里的编号 ${displayId(answer, id, null)} 没有标明类型，按调用方声明的编号范围（参数 id_ranges）读作${KIND[kind]}`);
    }
    for (const id of answer.unclassified) {
      if (answer.ranged.requirements.includes(id) || answer.ranged.defects.includes(id) || unread.includes(id)) continue;
      // An unmarked id whose kind nothing decides is read both ways: stories and bugs are separate numberings, and the
      // record that exists decides the kind (owner's rule 10-24: read both, the existing one decides; a guess would show
      // a false evidence gap for the kind that does not exist, or bind an unrelated record of the other numbering).
      bind(`plm:story:${id}`, `条目 ${item.id} 的${whereOf(answer.id_sources, id, null)}里的编号 ${displayId(answer, id, null)} 没有标明类型，需求与缺陷分别读取（不存在的那个读不到，不会绑上无关记录）`);
      bind(`plm:bug:${id}`, `条目 ${item.id} 的${whereOf(answer.id_sources, id, null)}里的编号 ${displayId(answer, id, null)} 没有标明类型，需求与缺陷分别读取（不存在的那个读不到，不会绑上无关记录）`);
      unread.push(id); unreadOriginals.set(id, displayId(answer, id, null));
    }
  }
  if (unread.length > 0) {
    const named = unread.slice(0, MAX_NAMED);
    warnings.push({
      code: `${PACK}.id_kind_unknown`,
      message: `${unread.length} 个编号没有标明是需求还是缺陷（${named.slice(0, 5).map(id => unreadOriginals.get(id) ?? id).join('、')}${unread.length > 5 ? ' 等' : ''}），需求与缺陷分别读取，存在的那一个决定种类；两种都存在时保留来源歧义，下一步作者补类型；参数 id_ranges 给出编号范围时按声明读作一种`,
      data: { ids: named, count: unread.length },
    });
  }
  if (dropped > 0) {
    warnings.push({ code: `${PACK}.sources_capped`, message: `关联的编号对应的来源超过 ${MAX_SOURCES} 个，还有 ${dropped} 个没有绑定`, data: { dropped, max: MAX_SOURCES } });
  }
  return { sources, warnings };
}

export default function expected(input: unknown): unknown {
  return guarded<unknown>(
    () => expectedSources(input),
    (message) => ({ sources: [], warnings: [{ code: `${PACK}.internal_error`, message: `期望来源函数内部出错：${message}` }] }),
  );
}
