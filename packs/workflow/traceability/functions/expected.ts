// Expected sources function for traceability (workflow@1 expected_sources, ExpectedSourcesInput -> ExpectedSourcesOutput).
// Groups defect IDs from projected items into external identifiers plm:bugs:<id>+<id>+... with at most 50 IDs each.
// Numbers are sorted numerically and deduplicated.
// Defects whose system is bugzilla are skipped from the PLM query to avoid cross-system ID collisions.
import type { ExpectedSource, PackWarning, ProjectedItem } from '../../../../contracts/src/pack.ts';
import { normalizeId } from './ids.ts';
import { guarded, isRecord } from './text.ts';

export const MAX_BUGS_PER_SOURCE = 50;

export function expectedSources(input: unknown): { sources: ExpectedSource[]; warnings: PackWarning[] } {
  if (!isRecord(input)) return { sources: [], warnings: [] };
  const items = (Array.isArray(input.items) ? input.items : []).filter(isRecord) as ProjectedItem[];

  const idsToQuery = new Set<string>();
  for (const item of items) {
    const fields = isRecord(item.fields) ? item.fields : {};
    const systems = Array.isArray(fields.systems) ? (fields.systems as string[]) : [];
    // Only query PLM when the systems list explicitly includes 'plm'; unknown or other systems are skipped.
    if (!systems.includes('plm')) continue;

    const bug = typeof fields.bug === 'string' && fields.bug !== '' ? fields.bug : item.id;
    if (typeof bug === 'string' && /^[0-9]+$/.test(bug)) {
      idsToQuery.add(normalizeId(bug));
    }
  }

  const sortedIds = [...idsToQuery].sort((a, b) => Number(a) - Number(b));
  const sources: ExpectedSource[] = [];

  for (let i = 0; i < sortedIds.length; i += MAX_BUGS_PER_SOURCE) {
    const chunk = sortedIds.slice(i, i + MAX_BUGS_PER_SOURCE);
    const key = chunk.join('+');
    sources.push({
      external: `plm:bugs:${key}`,
      role: 'expected',
      reason: '构建的缺陷编号，从缺陷系统查询状态以核验已关闭缺陷的追溯情况',
    });
  }

  return { sources, warnings: [] };
}

export default function expected(input: unknown): unknown {
  return guarded<unknown>(
    () => expectedSources(input),
    (message) => ({ sources: [], warnings: [{ code: 'traceability.internal_error', message: `期望来源函数内部出错：${message}` }] }),
  );
}
