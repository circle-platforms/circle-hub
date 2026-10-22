// The sync plan of the product (product@1 sync.plan, SyncPlanInput -> SyncPlanOutput). Each round the Hub hands back every
// page read so far; the plan is recomputed from them: index -> hub pages -> listing pages (depth 2, dead links tolerated,
// pages of both name families; platform, customer and patch pages only when an `include` pattern opts them in), then the
// builds of the listing pages. The plan lists:
// - every released build of a mainline page on the main platform, and every released build of an opted-in page;
// - the newest build of each version line and name family on the main platform, released or not (a line under test may have
//   no release yet: such a build has released_at null);
// - the base of every listed alias, so that an NSAE name resolves to the build whose tree it uses.
// A build with its own command tree (an APV name, or an NSAE name of the newest lines) is its own base and carries the
// sources tree (and fixed_bugs when linked); an NSAE name without a tree is an alias of the build its "based on" chain ends
// in and carries no sources. Options: include, exclude (globs over page names) and lines (set by the caller); case_index
// and min_line (cases-sync.ts; product.json leaves case_index off): with case_index on, every build with its own tree also
// lists its case documents (case_documents) and the agile tree they were located in (case_tree), read from
// agile:tree:roots (fetched in round 1); while that tree is not read, unreadable or incomplete, the builds with their own
// tree on min_line or later are not listed (they would list documents), the others are.
import type { BuildInfo, SyncPlanInput, SyncPlanOutput } from '../../../../contracts/src/product.ts';
import { hasCommandTree } from './builds.ts';
import { CASE_TREE_ID } from './cases-rules.ts';
import { caseDocumentsFor, caseIndexOptions, caseNote, caseSources, caseTree, uncoveredDocuments, type CaseTree } from './cases-sync.ts';
import { parseListing } from './listing.ts';
import { compareLines, lineKey } from './naming.ts';
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

function optionsOf(value: unknown): { include: string[]; exclude: string[]; lines: Set<string> | null } {
  const options = isRecord(value) ? value : {};
  const lines = Array.isArray(options.lines) ? new Set(asStrings(options.lines).map(lineKey)) : null;
  return { include: asStrings(options.include), exclude: asStrings(options.exclude), lines };
}

export function planBuilds(input: SyncPlanInput): SyncPlanOutput {
  const notes: string[] = [];
  try {
    const read = (isRecord(input) && isRecord(input.read) ? input.read : {}) as Record<string, Read>;
    const options = optionsOf(isRecord(input) ? input.options : undefined);
    const caseIndex = caseIndexOptions(isRecord(input) ? input.options : undefined);
    const index = htmlOf(read[INDEX_ID]);
    if (index === null) {
      const reason = read[INDEX_ID]?.reason;
      return { fetch: [], builds: [], done: true, note: `索引页读不出（${typeof reason === 'string' ? reason.slice(0, 200) : '没有读到'}），没有列出构建` };
    }
    const walk = { include: options.include, exclude: options.exclude };
    const first = planSync({ index, options: walk });
    const hubs: ReadHub[] = first.hubs.filter((hub) => Object.hasOwn(read, listingId(hub.page))).map((hub) => ({ page: hub.page, href: hub.href, model: htmlOf(read[listingId(hub.page)]) }));
    const plan = hubs.length > 0 ? planSync({ index, hubs, options: walk }) : first;
    const fetch: string[] = [];
    const want = (id: string): void => {
      if (!Object.hasOwn(read, id) && !fetch.includes(id)) fetch.push(id);
    };
    for (const hub of plan.hubs) want(listingId(hub.page));
    for (const page of plan.pages) want(listingId(page.page));
    const cases: CaseTree | null = caseIndex.on ? caseTree(read, caseIndex) : null;
    if (cases?.status === 'pending') want(CASE_TREE_ID);
    const lineCache = new Map<string, boolean>();
    const listedCases = { listed: 0, cut: 0 };
    // Lines of the builds that listed their case documents, and the builds held back while the tree is not at hand.
    const caseLines: string[] = [];
    const withheld = new Set<string>();

    // Builds of the listing pages read so far, each with the kind of the page that lists it (mainline wins).
    const listed: Build[] = [];
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
    // The newest build of each line and family on the main platform, released or not.
    const newest = new Map<string, Build>();
    for (const build of ofProduct) {
      if (!onLines(build) || build.platform !== null || pageOf.get(build.name)?.kind !== 'mainline') continue;
      const key = `${lineKey(build.line as string)}\u0000${build.family}`;
      const best = newest.get(key);
      if (best === undefined || newestFirst(build, best) < 0) newest.set(key, build);
    }
    for (const build of newest.values()) chosen.set(build.name, build);
    // The base of every chosen alias.
    const bases = new Map<string, string>();
    for (const build of [...chosen.values()]) {
      const local: string[] = [];
      const base = resolveBase(build, byName, local);
      if (base !== null && base !== build) chosen.set(base.name, base);
      bases.set(build.name, base?.name ?? build.basedOn ?? build.name);
      if (base === null && build.basedOn !== null) notes.push(...local);
    }

    const builds: BuildInfo[] = [];
    let partialDates = 0;
    for (const build of chosen.values()) {
      const base = bases.get(build.name) ?? resolveBase(build, byName, [])?.name ?? build.name;
      const built = isoTime(build.built);
      const released = isoTime(build.released);
      if (released.partial) partialDates++;
      const sources: Record<string, string | string[]> = {};
      if (base === build.name && hasCommandTree(build)) {
        const tree = fileId(build.files.commandTree?.href ?? '');
        if (tree !== null) sources[SOURCE_ROLES.tree] = tree;
        const bugs = build.files.bugsFixed === undefined ? null : fileId(build.files.bugsFixed.href);
        if (tree !== null && bugs !== null) sources[SOURCE_ROLES.fixedBugs] = bugs;
        // The case documents of the build's line and earlier ones (an alias without a tree of its own lists nothing). Without
        // the tree, a build of a line before min_line still lists nothing whatever the tree holds; the others wait for it.
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
    }
    builds.sort((a, b) => compareLines(a.line, b.line) || compareText(a.name, b.name));
    // A build that would list case documents is not listed without them: a root produced now would lose the cases it has.
    const kept = withheld.size === 0 ? builds : builds.filter((build) => !withheld.has(build.name));
    const uncovered = cases?.status === 'ready' ? uncoveredDocuments(cases.documents, caseLines) : [];

    const summary = [`读了 ${Object.keys(read).length} 个页面`, `${plan.pages.length} 个列表页`, `列出 ${kept.length} 个构建（${kept.filter((b) => b.released_at !== null).length} 个已发布）`];
    if (cases !== null) summary.push(caseNote(cases, caseIndex, { ...listedCases, withheld: withheld.size, uncovered }));
    if (failed.length > 0) summary.push(`读不出的列表页：${failed.slice(0, 8).join('、')}${failed.length > 8 ? ' 等' : ''}`);
    if (partialDates > 0) summary.push(`${partialDates} 个发布日期只写到月份，记为当月 1 日`);
    if (options.lines !== null) summary.push(`只列版本线 ${[...options.lines].join('、')}`);
    if (notes.length > 0) summary.push(notes.slice(0, 3).join('；'));
    const note = summary.join('；');
    return { fetch, builds: kept, done: fetch.length === 0, note: note.length > MAX_NOTE ? `${note.slice(0, MAX_NOTE)}…` : note };
  } catch (error) {
    return { fetch: [], builds: [], done: true, note: internalError(error) };
  }
}

/** Pack function entry: SyncPlanInput -> SyncPlanOutput. */
export default function syncPlan(input: unknown): SyncPlanOutput {
  return planBuilds(input as SyncPlanInput);
}
