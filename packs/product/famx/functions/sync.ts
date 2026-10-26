import {addAdocSources} from './adoc/deployment.ts';
import {specificationScope} from './specifications.ts';
// The sync plan of the product (product@1 sync.plan, SyncPlanInput -> SyncPlanOutput). Each round the Hub hands back every
// page read so far; the plan is recomputed from them: index -> hub pages -> listing pages (depth 2, dead links tolerated,
// pages of both name families; platform, customer and patch pages only when an `include` pattern opts them in), then the
// builds of the listing pages. The plan lists:
// - every released build of a mainline page on the main platform, and every released build of an opted-in page;
// - the newest build of each version line and name family on the main platform, released or not (a line under test may have
//   no release yet: such a build has released_at null), and likewise the newest build of each version line, name family
//   and platform of an opted-in page, released or not (a Beta build under test may have no release yet);
// - the base of every listed alias, so that an FAMY name resolves to the build whose tree it uses.
// A build with its own command tree (an FAMX name, or an FAMY name of the newest lines) is its own base and carries the
// sources tree (and fixed_bugs when linked); an FAMY name without a tree is an alias of the build its "based on" chain ends
// in and carries no sources. Options: include, exclude (globs over page names) and lines (set by the caller); case_index
// and min_line (cases-sync.ts; product.json leaves case_index off): with case_index on, every build with its own tree also
// lists its case documents (case_documents) and the agile tree they were located in (case_tree), read from
// agile:tree:roots (fetched in round 1); while that tree is not read, unreadable or incomplete, the builds with their own
// tree on min_line or later are not listed (they would list documents), the others are.
import type { BuildInfo, SyncPlanInput, SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { hasCommandTree } from './builds.ts';
import { CASE_TREE_ID } from './cases-rules.ts';
import { caseDocumentsFor, caseIndexOptions, caseNote, caseSources, caseTree, uncoveredDocuments, unversionedCaseSources, type CaseTree } from './cases-sync.ts';
import { parseListing } from './listing.ts';
import { compareLines, deviceSpelling, lineKey } from './naming.ts';
import { indexBuilds, resolveBase } from './select-build.ts';
import { INDEX_ID, SOURCE_ROLES, fileId, listingId } from './sources.ts';
import { planSync } from './sync-plan.ts';
import type { Build, HtmlModel, ListingPage, ReadHub } from './types.ts';
import { asStrings, compareDotted, compareNullable, compareText, internalError, isRecord } from './util.ts';

type Read = { ok?: unknown; parser?: unknown; model?: unknown; reason?: unknown };

const MAX_NOTE = 900;

function htmlOf(read: Read | undefined): HtmlModel | null {
  return read !== undefined && read.ok === true && read.parser === 'html@1' && isRecord(read.model) ? (read.model as unknown as HtmlModel) : null;
}

/** ISO 8601 UTC of a listed time: the page states no zone, the time is recorded as written (date only: midnight). */
export function isoTime(text: string | null): { iso: string | null; partial: boolean } {
  if (text === null) return { iso: null, partial: false };
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text)) return { iso: `${text}Z`, partial: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return { iso: `${text}T00:00:00Z`, partial: false };
  // A month-only release date (2026-03-xx on the page): the first of the month, reported in the note.
  if (/^\d{4}-\d{2}$/.test(text)) return { iso: `${text}-01T00:00:00Z`, partial: true };
  return { iso: null, partial: false };
}

/** Newest first on one line and family: build time, then build number, then name. */
function newestFirst(a: Build, b: Build): number {
  return compareNullable(b.built, a.built) || compareDotted(b.number, a.number) || compareText(a.name, b.name);
}

function optionsOf(value: unknown): { include: string[]; exclude: string[]; mainline_page_words:string[]; lines: Set<string> | null; pinned: string[] } {
  const options = isRecord(value) ? value : {};
  const lines = Array.isArray(options.lines) ? new Set(asStrings(options.lines).map(lineKey)) : null;
  return { include: asStrings(options.include), exclude: asStrings(options.exclude), mainline_page_words:asStrings(options.mainline_page_words), lines, pinned: asStrings(options.pinned) };
}

export function planBuilds(input: SyncPlanInput): SyncPlanOutput {
  const notes: string[] = [];
  try {
    const read = (isRecord(input) && isRecord(input.read) ? input.read : {}) as Record<string, Read>;
    const options = optionsOf(isRecord(input) ? input.options : undefined);
    const caseIndex = caseIndexOptions(isRecord(input) ? input.options : undefined);
    const specifications = isRecord(input.options) && input.options.spec_index === true ? specificationScope(read) : null;
    const cases: CaseTree | null = caseIndex.on ? caseTree(read, caseIndex) : null;
    const scopeFor=(lines:string[]):{scope?:SyncPlanOutput['scope'];note:string}=>{
      if(specifications&&!specifications.sources||cases&&cases.status!=='ready')return {note:'不分版本来源尚未完整读取，旧根不动；下一步补齐规格清单和用例树后重跑同步'};
      const scoped=cases?.status==='ready'?unversionedCaseSources(cases,lines):null;
      return {...(specifications||scoped?{scope:{...specifications?.sources,...(scoped?{unversioned_case_documents:scoped.ids,case_tree:CASE_TREE_ID}:{})}}:{}),note:scoped?`用例文档进不分版本：没有版本线 ${scoped.noLine} 份，没有覆盖构建 ${scoped.uncovered} 份；仍未列出 ${scoped.excluded} 份（早于下限或编号读不了）；空目录 ${cases?.status==='ready'?cases.counts.emptyFolders.count:0} 个`:''};
    };
    const index = htmlOf(read[INDEX_ID]);
    if (index === null) {
      const reason = read[INDEX_ID]?.reason;
      const fetch=[...specifications?.fetch??[],...(cases?.status==='pending'?[CASE_TREE_ID]:[])];
      const scoped=cases?{note:'缺少完整构建索引，不移动不分版本的根；下一步补齐构建索引后重跑同步'}:scopeFor([]);
      return {fetch,builds:[],done:fetch.length===0,...(scoped.scope?{scope:scoped.scope}:{}),note:[specifications?.note,scoped.note,`索引页读不出（${typeof reason === 'string' ? reason.slice(0, 200) : '没有读到'}），没有列出构建`].filter(Boolean).join('；')};
    }
    const walk = { include: options.include, exclude: options.exclude, mainline_page_words:options.mainline_page_words };
    const first = planSync({ index, options: walk });
    const hubs: ReadHub[] = first.hubs.filter((hub) => Object.hasOwn(read, listingId(hub.page))).map((hub) => ({ page: hub.page, href: hub.href, model: htmlOf(read[listingId(hub.page)]) }));
    const plan = hubs.length > 0 ? planSync({ index, hubs, options: walk }) : first;
    const fetch: string[] = [];
    const want = (id: string): void => {
      if (!Object.hasOwn(read, id) && !fetch.includes(id)) fetch.push(id);
    };
    for (const hub of plan.hubs) want(listingId(hub.page));
    for (const page of plan.pages) want(listingId(page.page));
    for (const id of specifications?.fetch??[]) want(id);
    if (cases?.status === 'pending') want(CASE_TREE_ID);
    const lineCache = new Map<string, boolean>();
    const listedCases = { listed: 0, cut: 0 };
    // Lines of the builds that listed their case documents, and the builds held back while the tree is not at hand.
    const caseLines: string[] = [];
    const withheld = new Set<string>();

    // Builds of the listing pages read so far, each with the kind of the page that lists it (mainline wins).
    const listed: Build[] = [];
    const failedBuilds: NonNullable<SyncPlanOutput['failed_builds']> = [];
    const pageOf = new Map<string, ListingPage>();
    const failed: string[] = [];
    for (const page of plan.pages) {
      const entry = read[listingId(page.page)];
      if (entry === undefined) continue;
      const model = htmlOf(entry);
      if (model === null) {
        failed.push(page.page);
        continue;
      }
      for (const build of parseListing(model, { platform: page.platform }).builds) {
        if (build.failure) {
          if (build.line !== null && build.family !== 'other' && (options.lines === null || options.lines.has(lineKey(build.line)))) failedBuilds.push({
            source: listingId(page.page), build: {name:build.name, family:build.family, line:build.line, base:build.name,
              platform:build.platform, built_at:null, released_at:isoTime(build.released).iso, sources:{}},
            raw: { ...build }, reason:'SOURCE_UNPARSEABLE', fix:build.failure,
          });
          continue;
        }
        listed.push(build);
        const seen = pageOf.get(build.name);
        if (seen === undefined || (seen.kind !== 'mainline' && page.kind === 'mainline')) pageOf.set(build.name, page);
      }
    }
    const byName = indexBuilds(listed, notes);
    const ofProduct = [...byName.values()].filter((build) => build.family !== 'other' && build.line !== null);
    const onLines = (build: Build): boolean => options.lines === null || options.lines.has(lineKey(build.line as string));

    const chosen = new Map<string, Build>();
    for (const build of ofProduct) {
      if (!onLines(build) || build.released === null) continue;
      const mainline = pageOf.get(build.name)?.kind === 'mainline';
      if ((mainline && build.platform === null) || !mainline) chosen.set(build.name, build);
    }
    // The newest build of each line and family on the main platform, released or not, and the newest build of each
    // line, family and platform of an opted-in page, released or not (a Beta build of a platform line may have no
    // release yet: it is listed with released_at null, so an include-unreleased sync can produce its root; whether
    // that root exists still depends on the page linking the build's command tree).
    const newest = new Map<string, Build>();
    for (const build of ofProduct) {
      if (!onLines(build)) continue;
      const kind = pageOf.get(build.name)?.kind;
      const mainlineMain = kind === 'mainline' && build.platform === null;
      const optedIn = kind !== undefined && kind !== 'mainline';
      if (!mainlineMain && !optedIn) continue;
      const line = lineKey(build.line as string);
      const key = mainlineMain ? `${line}\u0000${build.family}` : `${line}\u0000${build.family}\u0000${build.platform ?? ''}`;
      const best = newest.get(key);
      if (best === undefined || newestFirst(build, best) < 0) newest.set(key, build);
    }
    for (const build of newest.values()) chosen.set(build.name, build);
    // Builds pinned by name (the pack passes the declared variable FAMX_PINNED_BUILDS through sync.options.pinned): on a read opted-in page, an entry whose build name equals a
    // member exactly (no transformation of any kind, not even case folding) is chosen as a build of its own tree,
    // released or not. A pinned name the read pages do not list is reported in the note, never guessed.
    const pinnedSet = new Set(options.pinned);
    const pinnedFound = new Set<string>();
    if (pinnedSet.size > 0) {
      for (const build of ofProduct) {
        if (!pinnedSet.has(build.name) || chosen.has(build.name)) continue;
        if (pageOf.get(build.name)?.kind === 'mainline') continue;
        chosen.set(build.name, build);
        pinnedFound.add(build.name);
      }
    }
    // The base of every chosen alias.
    const bases = new Map<string, string>();
    for (const build of [...chosen.values()]) {
      const local: string[] = [];
      const base = resolveBase(build, byName, local);
      if (base !== null && base !== build) chosen.set(base.name, base);
      bases.set(build.name, base?.name ?? build.basedOn ?? build.name);
      if (base === null && build.basedOn !== null) notes.push(...local);
    }
    // Every other mainline build of the read pages is known by name only (name, family, line, dates; base itself, no
    // sources): the real lines hold dozens of builds without a tree of their own (unreleased, Beta, superseded), and
    // the case-location candidates read the names. Opted-in platform, customer and patch pages keep their own rules
    // (their builds are not added here).
    const mainlineMain = new Set<string>();
    for (const build of ofProduct) {
      if (!onLines(build)) continue;
      if (pageOf.get(build.name)?.kind !== 'mainline') continue;
      if (build.platform !== null) continue;
      mainlineMain.add(build.name);
    }
    const namesOnly: Build[] = [];
    const namesOnlyBase = new Map<string, string>();
    for (const build of ofProduct) {
      if (!mainlineMain.has(build.name) || chosen.has(build.name)) continue;
      // A released FAMY name whose base resolves keeps that base (a known alias, read by name only). Every other
      // mainline build is registered by name only, with the built time the page lists and the base the page's
      // “based on” names (absent: itself) — the candidates then write both (an unreleased alias does not claim the
      // base's tree; it stays name-only, unlike a released alias).
      const local: string[] = [];
      const resolved = resolveBase(build, byName, local);
      if (resolved !== null && resolved !== build && build.released !== null) {
        chosen.set(build.name, build);
        bases.set(build.name, resolved.name);
        continue;
      }
      namesOnly.push(build);
      namesOnlyBase.set(build.name, build.basedOn ?? build.name);
    }

    const builds: BuildInfo[] = [];
    /** Builds whose device display spelling will be listed as their verified alias (filled in the loop below). */
    const deviceAliases: Build[] = [];
    let partialDates = 0;
    const pushBuild = (build: Build, base: string, sources: Record<string, string | string[]>): void => {
      const built = isoTime(build.built);
      const released = isoTime(build.released);
      if (released.partial) partialDates++;
      builds.push({
        name: build.name,
        family: build.family,
        line: lineKey(build.line as string),
        base,
        platform: build.platform,
        built_at: built.iso,
        released_at: released.iso,
        sources,
      });
      addAdocSources(builds[builds.length-1],input.options,read,want,notes);
    };
    for (const build of chosen.values()) {
      const base = bases.get(build.name) ?? resolveBase(build, byName, [])?.name ?? build.name;
      const sources: Record<string, string | string[]> = {};
      if (base === build.name && hasCommandTree(build)) {
        const tree = fileId(build.files.commandTree?.href ?? '');
        if (tree !== null) sources[SOURCE_ROLES.tree] = tree;
        const bugs = build.files.bugsFixed === undefined ? null : fileId(build.files.bugsFixed.href);
        if (tree !== null && bugs !== null) sources[SOURCE_ROLES.fixedBugs] = bugs;
        // The case documents of the build's line and earlier ones, by release-train date once the tree is read (cases-sync.ts).
        // An alias without a tree of its own lists nothing. While the tree is unread there is no train date, so "before
        // min_line" is the dotted comparison: those builds list nothing whatever the tree holds, and the others wait.
        if (tree !== null && cases !== null) {
          const line = lineKey(build.line as string);
          if (cases.status === 'ready') {
            const listed = caseDocumentsFor(cases.documents, line, lineCache);
            Object.assign(sources, caseSources(listed.ids));
            listedCases.listed += listed.ids.length;
            listedCases.cut += listed.cut;
            caseLines.push(line);
          } else if (compareLines(line, caseIndex.minLine) >= 0) withheld.add(build.name);
        }
      }
      pushBuild(build, base, sources);
      // The device display spelling (a verified alias of this build, C07 R[9]) is listed only while the build itself
      // stays listed: a withheld build leaves the plan, and an alias whose base is gone would fail the sync instead
      // of serving a locked root. See the alias pass after the withheld filter below.
      if (base === build.name && deviceSpelling(build.name) !== build.name && !withheld.has(build.name)) {
        deviceAliases.push(build);
      }
    }
    for (const build of namesOnly) pushBuild(build, namesOnlyBase.get(build.name) ?? build.name, {});
    builds.sort((a, b) => compareLines(a.line, b.line) || compareText(a.name, b.name));
    // A build that would list case documents is not listed without them: a root produced now would lose the cases it has.
    const kept = withheld.size === 0 ? builds : builds.filter((build) => !withheld.has(build.name));
    // Only retained builds have device aliases. Unreleased builds retain their aliases too: an explicit
    // includeUnreleased sync may produce their root. A withheld base must never leave a dangling alias.
    for (const build of deviceAliases) kept.push({ name: deviceSpelling(build.name), family: build.family, line: lineKey(build.line as string), base: build.name, platform: build.platform, built_at: isoTime(build.built).iso, released_at: isoTime(build.released).iso, sources: {} });
    kept.sort((a, b) => compareLines(a.line, b.line) || compareText(a.name, b.name));
    const uncovered = cases?.status === 'ready' ? uncoveredDocuments(cases.documents, caseLines) : [];
    const scoped=cases&&(failed.length||fetch.length)?{note:'缺少完整构建列表，不移动不分版本的根；下一步补齐构建列表后重跑同步'}:scopeFor(caseLines);

    const summary = [
      ...(specifications?[specifications.note]:[]),
      ...(scoped.note?[scoped.note]:[]),
      `读了 ${Object.keys(read).length} 个页面`,
      `${plan.pages.length} 个列表页`,
      `列出 ${kept.length} 个构建（${kept.filter((b) => b.released_at !== null).length} 个已发布，${kept.filter((b) => Object.keys(b.sources).length === 0 && b.base === b.name).length} 个只有名字）`,
    ];
    if (withheld.size > 0) summary.push(caseIndex.invalidMinLine
      ? `找到的 ${withheld.size} 个构建没有列出：min_line 无效，未套用下限，这次不列会带用例文档的构建，旧根不动`
      : `找到的 ${withheld.size} 个构建没有列出：用例树读不出来，这次不列构建，免得产出缺少用例的根`);
    if (cases !== null) summary.push(caseNote(cases, caseIndex, { ...listedCases, withheld: withheld.size, uncovered, scoped:scoped.scope!==undefined }));
    if (failed.length > 0) summary.push(`读不出的列表页：${failed.slice(0, 8).join('、')}${failed.length > 8 ? ' 等' : ''}`);
    if (partialDates > 0) summary.push(`${partialDates} 个发布日期只写到月份，记为当月 1 日`);
    if (pinnedSet.size > 0) {
      const absent = options.pinned.filter((name) => !pinnedFound.has(name) && !chosen.has(name));
      if (absent.length > 0) summary.push(absent.map((name) => `点名的构建 ${name} 在选入页里没有`).join('；'));
    }
    if (options.lines !== null) summary.push(`只列版本线 ${[...options.lines].join('、')}`);
    if (notes.length > 0) summary.push(notes.slice(0, 3).join('；'));
    const note = summary.join('；');
    return { fetch, builds: kept, ...(failedBuilds.length ? {failed_builds:failedBuilds} : {}), done: fetch.length === 0, ...(scoped.scope?{scope:scoped.scope}:{}), note: note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE)}…` : note };
  } catch (error) {
    return { fetch: [], builds: [], done: true, note: internalError(error) };
  }
}

/** Pack function entry: SyncPlanInput -> SyncPlanOutput. */
export default function syncPlan(input: unknown): SyncPlanOutput {
  return planBuilds(input as SyncPlanInput);
}
