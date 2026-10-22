// The sync plan of the Lumen API product (product@1 sync.plan, SyncPlanInput -> SyncPlanOutput): one page, the release list
// in the document store (manual:file:lumen/releases.md, a Markdown table: build, version, build time, release time, the path
// of the build's endpoint reference). Every listed build is planned; each is its own base and carries its endpoint reference
// as the source role `spec`. A row that does not parse is left out with a note; an unreadable page plans nothing.
import type { BuildInfo, SyncPlanInput, SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { asArray, asString, isRecord, isoTime, lineOf, tableRows } from './common.ts';

export const RELEASES = 'manual:file:lumen/releases.md';
export const FAMILY = 'Lumen API';
const BUILD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}\.md$/;

export function planBuilds(input: SyncPlanInput): SyncPlanOutput {
  const read = isRecord(input) && isRecord(input.read) ? input.read : {};
  const page = isRecord(read[RELEASES]) ? read[RELEASES] : null;
  if (page === null) return { fetch: [RELEASES], builds: [], done: false };
  if (page.ok !== true || page.parser !== 'markdown@1' || !isRecord(page.model)) {
    return { fetch: [], builds: [], done: true, note: `发布清单读不出（${asString(page.reason)?.slice(0, 200) ?? '不是 Markdown'}），没有列出构建` };
  }
  const builds: BuildInfo[] = [];
  const skipped: string[] = [];
  for (const block of asArray(page.model.blocks)) {
    if (!isRecord(block) || block.kind !== 'table' || typeof block.text !== 'string') continue;
    for (const row of tableRows(block.text)) {
      const [name, version, built, released, reference] = row;
      const line = typeof version === 'string' ? lineOf(version) : null;
      if (name === undefined || !BUILD.test(name) || line === null || reference === undefined || !PATH.test(reference) || reference.split('/').includes('..')) {
        skipped.push(row.join(' | ').slice(0, 80));
        continue;
      }
      if (builds.some((b) => b.name === name)) continue;
      builds.push({
        name,
        family: FAMILY,
        line,
        base: name,
        platform: null,
        built_at: isoTime(built ?? ''),
        released_at: isoTime(released ?? ''),
        sources: { spec: `manual:file:${reference}` },
      });
    }
  }
  return { fetch: [], builds, done: true, ...(skipped.length > 0 ? { note: `${skipped.length} 行读不出，已跳过：${skipped.slice(0, 3).join('；')}` } : {}) };
}

export default function (input: unknown): unknown {
  try {
    return planBuilds(input as SyncPlanInput);
  } catch {
    return { fetch: [], builds: [], done: true, note: '同步计划函数内部出错（任务包的缺陷）' };
  }
}
