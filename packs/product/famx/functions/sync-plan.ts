// Knowledge sync planning (brief sections 6 and 8). planSync walks the build site by page names: index -> hub pages ->
// listing pages (depth 2, tolerant of dead links). It selects the mainline listing pages of both families (platform,
// customer and patch pages by opt-in pattern) and returns the hub pages still to read; the caller reads them and calls
// again with their models. syncBuilds lists the base builds that still need a knowledge root and every FAMY alias.
import type {
  Alias,
  Build,
  HtmlModel,
  HubPage,
  ListingPage,
  PlanSyncInput,
  PlanSyncOptions,
  PlanSyncResult,
  SyncBuildsInput,
  SyncBuildsResult,
} from './types.ts';
import { hasCommandTree } from './builds.ts';
import { parseListing } from './listing.ts';
import { compareLines, parseHubName, parsePageName } from './naming.ts';
import { indexBuilds, resolveBase } from './select-build.ts';
import { asArray, asString, asStrings, canonicalJson, compareDotted, compareText, globMatch, guarded, internalError, isRecord } from './util.ts';

const MAX_PATTERN = 200;
const MAX_HUBS = 500;
const KIND_TEXT: { [kind: string]: string } = { mainline: '主线页', platform: '平台分支页', customer: '客户或功能分支页', patch: '补丁页' };

/** Page name of a link: the last path segment without query, fragment and .html/.htm (repeated), or null. */
export function pageNameOf(href: string): string | null {
  const path = href.trim().split(/[?#]/)[0];
  let last = path.slice(path.lastIndexOf('/') + 1);
  try {
    last = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  if (!/\.html?$/i.test(last)) return null;
  while (/\.html?$/i.test(last)) last = last.replace(/\.html?$/i, '');
  return last === '' ? null : last;
}

function patterns(value: unknown, name: string, warnings: string[]): string[] {
  const out: string[] = [];
  for (const pattern of asStrings(value)) {
    if (pattern.trim() === '' || pattern.length > MAX_PATTERN) warnings.push(`${name} 模式为空或超过 ${MAX_PATTERN} 个字符，已忽略`);
    else out.push(pattern.trim());
  }
  return out;
}

function linksOf(model: unknown): Array<{ href: string }> {
  if (!isRecord(model)) return [];
  const out: Array<{ href: string }> = [];
  for (const link of asArray(model.links)) {
    if (!isRecord(link)) continue;
    const href = asString(link.href);
    if (href !== null && href.trim() !== '') out.push({ href });
  }
  return out;
}

function isHtmlModel(value: unknown): value is HtmlModel {
  return isRecord(value) && Array.isArray(value.links) && Array.isArray(value.blocks);
}

export function planSync(input: PlanSyncInput): PlanSyncResult {
  const pages: ListingPage[] = [];
  const hubs: HubPage[] = [];
  const skipped: PlanSyncResult['skipped'] = [];
  const warnings: string[] = [];
  try {
    if (!isRecord(input)) return { pages, hubs, skipped, warnings: ['输入不是对象'] };
    const models = Array.isArray(input.index) ? input.index : [input.index];
    const options: PlanSyncOptions = isRecord(input.options) ? input.options : {};
    const include = patterns(options.include, 'include', warnings);
    const exclude = patterns(options.exclude, 'exclude', warnings);
    const excluded = (page: string): boolean => exclude.some((pattern) => globMatch(pattern, page));

    // Hub pages already read (the second call): by lower-case page name, in name order so the result never depends on
    // the order they are given in. A page given twice keeps a readable copy, then the first by canonical JSON.
    type Given = { page: string; href: string | null; model: unknown };
    const givenCopies = new Map<string, Given[]>();
    let invalidHubs = 0;
    for (const item of asArray(input.hubs).slice(0, MAX_HUBS)) {
      const page = isRecord(item) ? asString(item.page) : null;
      if (page === null || page.trim() === '') {
        invalidHubs++;
        continue;
      }
      const key = page.trim().toLowerCase();
      const record = item as { href?: unknown; model?: unknown };
      const given: Given = { page: page.trim(), href: asString(record.href), model: record.model ?? null };
      const list = givenCopies.get(key);
      if (list === undefined) givenCopies.set(key, [given]);
      else list.push(given);
    }
    const read = new Map<string, Given>();
    for (const key of [...givenCopies.keys()].sort(compareText)) {
      const list = givenCopies.get(key) as Given[];
      const ranked = list.map((given) => ({ given, text: canonicalJson(given) })).sort((a, b) => Number(isHtmlModel(b.given.model)) - Number(isHtmlModel(a.given.model)) || compareText(a.text, b.text));
      read.set(key, ranked[0].given);
      if (new Set(ranked.map((item) => item.text)).size > 1) warnings.push(`导航页 ${ranked[0].given.page} 给了 ${list.length} 次，内容不一致，取其中能读的一份`);
    }
    if (invalidHubs > 0) warnings.push(`hubs 里有 ${invalidHubs} 项没有页面名，已忽略`);
    if (asArray(input.hubs).length > MAX_HUBS) warnings.push(`导航页超过 ${MAX_HUBS} 个，其余未读`);

    const seen = new Set<string>();
    const hrefOf = new Map<string, string>();
    let duplicates = 0;
    const listing = (page: string, href: string, from: string | null): void => {
      const parts = parsePageName(page,asStrings(options.mainline_page_words));
      if (parts === null) {
        skipped.push({ page, href, reason: '名称不符合列表页命名' });
        return;
      }
      const entry: ListingPage = { page, href, from, family: parts.family, line: parts.line, platform: parts.platform, kind: parts.kind };
      if (excluded(page)) skipped.push({ page, href, reason: '被排除模式排除' });
      else if (include.some((pattern) => globMatch(pattern, page))) pages.push(entry);
      else if (parts.family === 'other') skipped.push({ page, href, reason: '不属于本产品的名称族（FAMX、FAMY）' });
      else if (parts.kind !== 'mainline') skipped.push({ page, href, reason: `${KIND_TEXT[parts.kind]}默认不选，可用包含模式选入` });
      else pages.push(entry);
    };
    // One link of a page at the given depth (1: linked from an index page, 2: linked from a hub page).
    const visit = (href: string, depth: 1 | 2, from: string | null): void => {
      const page = pageNameOf(href);
      if (page === null) {
        skipped.push({ page: href.slice(0, 200), href, reason: '不是页面链接' });
        return;
      }
      const key = page.toLowerCase();
      if (seen.has(key)) {
        duplicates++;
        return;
      }
      seen.add(key);
      hrefOf.set(key, href);
      // A page the caller read as a hub is handled below from its content, whatever its name says.
      if (read.has(key)) return;
      const hub = parseHubName(page);
      if (hub === null) listing(page, href, from);
      else if (excluded(page)) skipped.push({ page, href, reason: '被排除模式排除' });
      else if (depth === 2) skipped.push({ page, href, reason: '导航页链接的导航页，超过两层，不再读' });
      else hubs.push({ page, href, family: hub.family, line: hub.line });
    };

    models.forEach((model: unknown, k: number) => {
      if (!isRecord(model) || !Array.isArray(model.links)) {
        warnings.push(`第 ${k + 1} 个索引页不是 html@1 模型（缺 links）`);
        return;
      }
      for (const link of linksOf(model)) visit(link.href, 1, null);
    });

    // Hub pages read: a page without build entries is a hub and its links are the listing pages of depth 2; a page that
    // lists builds itself is a listing page, whatever its name says.
    for (const key of [...read.keys()].sort(compareText)) {
      const given = read.get(key) as Given;
      const { page, model } = given;
      seen.add(key);
      const href = hrefOf.get(key) ?? given.href ?? `${page}.html`;
      if (excluded(page)) {
        skipped.push({ page, href, reason: '被排除模式排除' });
        continue;
      }
      if (!isHtmlModel(model)) {
        skipped.push({ page, href, reason: '导航页读不出（链接可能失效），其下的列表页未知' });
        continue;
      }
      if (parseListing(model).builds.length > 0) {
        warnings.push(`导航页 ${page} 里有构建条目，按列表页读`);
        const hub = parseHubName(page);
        if (hub === null) listing(page, href, null);
        else pages.push({ page, href, from: null, family: hub.family, line: hub.line, platform: null, kind: 'mainline' });
        continue;
      }
      for (const link of linksOf(model)) visit(link.href, 2, page);
    }

    if (duplicates > 0) warnings.push(`有 ${duplicates} 个重复的页面链接，按第一次出现处理`);
    pages.sort((a, b) => compareText(a.family, b.family) || compareLines(a.line, b.line) || compareText(a.page, b.page));
    hubs.sort((a, b) => compareText(a.page, b.page));
    return { pages, hubs, skipped, warnings };
  } catch (error) {
    return { pages, hubs, skipped, warnings: [...warnings, internalError(error)] };
  }
}

function rootNames(value: unknown, warnings: string[]): Set<string> {
  const names = new Set<string>();
  let invalid = 0;
  for (const item of asArray(value)) {
    if (typeof item === 'string' && item.trim() !== '') names.add(item.trim());
    else if (isRecord(item) && typeof item.build === 'string' && item.build.trim() !== '') names.add(item.build.trim());
    else invalid++;
  }
  if (invalid > 0) warnings.push(`existingRoots 里有 ${invalid} 项格式不对，已忽略`);
  return names;
}

export function syncBuilds(input: SyncBuildsInput): SyncBuildsResult {
  const warnings: string[] = [];
  const out: SyncBuildsResult = { produce: [], aliases: [], skipped: [], unreleased: 0, warnings };
  try {
    if (!isRecord(input)) {
      warnings.push('输入不是对象');
      return out;
    }
    const byName = indexBuilds(asArray(input.builds), warnings);
    const existing = rootNames(input.existingRoots, warnings);
    const produce = new Map<string, Build>();
    const needed = new Set<string>();
    const skippedNames = new Set<string>();
    const skip = (name: string, reason: string): void => {
      if (skippedNames.has(name)) return;
      skippedNames.add(name);
      out.skipped.push({ name, reason });
    };
    for (const build of byName.values()) {
      if (build.family === 'other') {
        if (build.released !== null) skip(build.name, '不属于本产品的名称族（FAMX、FAMY）');
        continue;
      }
      const notes: string[] = [];
      const base = resolveBase(build, byName, notes);
      // Every alias whose base resolves is recorded, released or not; only released builds and the bases of released
      // aliases are produced.
      if (base !== null && base !== build) out.aliases.push({ alias: build.name, base: base.name, released: build.released, platform: build.platform });
      if (build.released === null) continue;
      if (base === null) {
        skip(build.name, notes.join('；'));
        continue;
      }
      needed.add(base.name);
      if (!hasCommandTree(base)) {
        skip(base.name, base === build ? '没有命令树' : `别名 ${build.name} 的基础构建 ${base.name} 没有命令树`);
        continue;
      }
      if (existing.has(base.name)) {
        skip(base.name, '知识库里已有该构建的根');
        continue;
      }
      produce.set(base.name, base);
    }
    out.unreleased = [...byName.values()].filter((build) => build.released === null && !needed.has(build.name)).length;
    out.produce = [...produce.values()].sort((a, b) => compareLines(a.line, b.line) || compareDotted(a.number, b.number) || compareText(a.name, b.name));
    out.aliases.sort((a: Alias, b: Alias) => compareText(a.base, b.base) || compareText(a.alias, b.alias));
    out.skipped.sort((a, b) => compareText(a.name, b.name));
    return out;
  } catch (error) {
    warnings.push(internalError(error));
    return out;
  }
}

/** Pack function entry: PlanSyncInput. The second step is the named export syncBuildsFunction (or syncBuilds). */
export default function planSyncFunction(input: unknown): PlanSyncResult {
  return guarded(
    () => planSync(input as PlanSyncInput),
    (warning) => ({ pages: [], hubs: [], skipped: [], warnings: [warning] }),
  );
}

/** Pack function entry for the second step: SyncBuildsInput. */
export function syncBuildsFunction(input: unknown): SyncBuildsResult {
  return guarded(
    () => syncBuilds(input as SyncBuildsInput),
    (warning) => ({ produce: [], aliases: [], skipped: [], unreleased: 0, warnings: [warning] }),
  );
}
