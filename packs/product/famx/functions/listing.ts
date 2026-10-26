// Listing page parser: build entries of one build-site listing page (an html@1 model) with their files.
// Entry line: `<build> (build on <date> <time> ): [based on <base>] [Released on <date>]`; released entries sit in a red
// font element; the links that follow an entry (until the next entry) are its files.
import type { Build, BuildFiles, FileRef, HtmlModel, ImageRef, ListingContext, ListingResult } from './types.ts';
import { compareCopies } from './builds.ts';
import { parseBuildName } from './naming.ts';
import { asArray, asString, guarded, internalError, isRecord, pad2, squeeze, validDate } from './util.ts';

type Segment = { text: string; red: boolean };
type Line = { segments: Segment[]; links: number[]; seen: Set<number> };
type Link = { href: string; text: string };

const BUILD_ON = /\(\s*build\s+on\b/i;
const NAME = /^[A-Za-z][A-Za-z0-9_.\-]{0,255}$/;
const RED = /^(?:red|#?f00|#?ff0000)$/i;
const RED_STYLE = /(?:^|;)\s*color\s*:\s*(?:red|#f00|#ff0000)\s*(?:;|$)/i;

function isRedWrapper(wrapper: unknown): boolean {
  if (!isRecord(wrapper) || !isRecord(wrapper.attributes)) return false;
  const color = asString(wrapper.attributes.color);
  const style = asString(wrapper.attributes.style);
  return (wrapper.tag === 'font' && color !== null && RED.test(color.trim())) || (style !== null && RED_STYLE.test(style));
}

/** Lines of a block with their red flags and links, rebuilt from the runs (or from the text when runs are missing). */
function newLine(): Line {
  return { segments: [], links: [], seen: new Set() };
}

function linesOf(block: { [key: string]: unknown }): Line[] {
  const runs = Array.isArray(block.runs) ? block.runs : null;
  const lines: Line[] = [newLine()];
  if (runs === null) {
    const text = asString(block.text) ?? '';
    const out = text.split('\n').map((part) => ({ ...newLine(), segments: [{ text: part, red: false }] }));
    const links = asArray(block.links).filter((link): link is number => Number.isInteger(link));
    if (out.length > 0) out[out.length - 1].links.push(...links);
    return out;
  }
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const text = asString(run.text) ?? '';
    const red = asArray(run.wrappers).some(isRedWrapper);
    const link = Number.isInteger(run.link) ? (run.link as number) : null;
    const parts = text.split('\n');
    parts.forEach((part, k) => {
      if (k > 0) lines.push(newLine());
      const line = lines[lines.length - 1];
      if (part !== '') line.segments.push({ text: part, red });
      // A set per line: a line of many links stays linear.
      if (link !== null && !line.seen.has(link)) {
        line.seen.add(link);
        line.links.push(link);
      }
    });
  }
  return lines;
}

function plain(line: Line): string {
  return line.segments.map((segment) => segment.text).join('');
}

/** Whether the character at `index` of the joined line text lies in a red segment. */
function redAt(line: Line, index: number): boolean {
  let at = 0;
  for (const segment of line.segments) {
    if (index < at + segment.text.length) return segment.red;
    at += segment.text.length;
  }
  return false;
}

// A release date as the pages write it: four-digit year, two-digit month and day (or xx / ?? for a month-only date), one
// separator throughout, then no letter or digit. Anything shorter or longer is not read: a truncated date must not become
// a wrong full date.
const RELEASE_DATE = /^([0-9]{4})([-/])([0-9]{2})\2([0-9]{2}|[xX?]{2})(?![0-9A-Za-z])/;

/** The release date at the start of `text`; `length` is how much of the text it takes (0 when none was read). */
function parseDate(text: string): { iso: string | null; partial: boolean; length: number } {
  const match = RELEASE_DATE.exec(text);
  if (!match) return { iso: null, partial: false, length: 0 };
  const year = Number(match[1]);
  const month = Number(match[3]);
  if (!/^[0-9]+$/.test(match[4])) {
    if (!validDate(year, month, 1)) return { iso: null, partial: false, length: 0 };
    return { iso: `${year}-${pad2(month)}`, partial: true, length: match[0].length };
  }
  const day = Number(match[4]);
  if (!validDate(year, month, day)) return { iso: null, partial: false, length: 0 };
  return { iso: `${year}-${pad2(month)}-${pad2(day)}`, partial: false, length: match[0].length };
}

function parseBuildTime(text: string): string | null {
  const value=squeeze(text);
  const reverse=/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s+(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value);
  const match=/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?:[ T]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(value);
  if(!reverse&&!match)return null;
  const [year,month,day]=reverse?[Number(reverse[4]),Number(reverse[5]),Number(reverse[6])]:[Number(match![1]),Number(match![3]),Number(match![4])];
  if(!validDate(year,month,day))return null;
  const date=`${year}-${pad2(month)}-${pad2(day)}`;
  if(!reverse&&match![5]===undefined)return date;
  const [hour,minute,second]=reverse?[Number(reverse[1]),Number(reverse[2]),Number(reverse[3]??'0')]:[Number(match![5]),Number(match![6]),Number(match![7]??'0')];
  if (hour > 23 || minute > 59 || second > 59) return null;
  return `${date}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
}

type Header = { raw: string; name: string; built: string | null; released: string | null; basedOn: string | null; note: string | null; problems: string[] };

/** Parses one entry line; null when the line is not an entry. */
function parseHeader(text: string): Header | null {
  const found = BUILD_ON.exec(text);
  if (!found) return null;
  const before = text.slice(0, found.index).trimEnd();
  const space = before.lastIndexOf(' ');
  const name = before.slice(space + 1);
  const problems: string[] = [];
  if (!NAME.test(name)) return null;
  // Text before the name on the same line (a page note in red, for example) is not part of the entry.
  const close = text.indexOf(')', found.index);
  if (close < 0) {
    problems.push(`构建 ${name} 的构建时间没有右括号`);
    return { raw: text, name, built: null, released: null, basedOn: null, note: null, problems };
  }
  const inside = text.slice(found.index + found[0].length, close);
  const built = parseBuildTime(inside);
  if (built === null) problems.push(`构建 ${name} 的构建时间认不出：${squeeze(inside).slice(0, 40)}`);
  let rest = squeeze(text.slice(close + 1).replace(/^\s*:/, ''));
  let basedOn: string | null = null;
  const base = /\bbased\s+on\s+([A-Za-z][A-Za-z0-9_.\-]{0,255})/i.exec(rest);
  if (base) {
    basedOn = base[1].replace(/[.,;:]+$/, '');
    rest = squeeze(rest.slice(0, base.index) + ' ' + rest.slice(base.index + base[0].length));
  }
  let released: string | null = null;
  const release = /\breleased\s+on\b\s*:?\s*/i.exec(rest);
  if (release) {
    const after = release.index + release[0].length;
    const date = parseDate(rest.slice(after));
    const written = rest.slice(after).split(' ')[0].slice(0, 20);
    // An unreadable date stays in the note as written.
    if (date.iso === null) problems.push(`构建 ${name} 写了 Released on，但发布日期认不出（${written === '' ? '空' : written}）`);
    else if (date.partial) problems.push(`构建 ${name} 的发布日期只写到月份（${rest.slice(after, after + date.length)}），记为 ${date.iso}`);
    released = date.iso;
    rest = squeeze(rest.slice(0, release.index) + ' ' + rest.slice(after + date.length));
  }
  return { raw: text, name, built, released, basedOn, note: rest === '' ? null : rest, problems };
}

function basename(href: string): string {
  const path = href.split(/[?#]/)[0];
  const last = path.slice(path.lastIndexOf('/') + 1);
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

type FileKind = 'commandTree' | 'bugsFixed' | 'mib' | 'image';

/**
 * famx-assets@1 (declared grammar; origin: the listing page's own file naming as documented in this pack's README —
 * `command_tree-<build>.xml`, `Bugs_Fixed_with_<build>.html`, `<prefix>-MIB[_<language>]-<build>.txt|mib|my` and
 * `<prefix>-<build>.<image extension>`, with `<build>` a complete build name in the product's own naming grammar —
 * declared for the owner's R6 rule 2026-10-24). A role is read from a whole file name; nothing is recognised by a
 * substring, a word or an extension alone, and a name the grammar does not read keeps its link and is reported as an
 * unchecked role. A variant build's entry is named after its own image file, which the same image form covers.
 */
const ASSET_BUILD = '(?:Rel|Beta)[_.][A-Za-z][A-Za-z0-9]{0,31}(?:-[A-Za-z0-9]{1,16}){0,6}[_.][0-9]{1,9}(?:[_.][0-9]{1,9}){1,15}';
const ASSET_FORMS: ReadonlyArray<[FileKind, RegExp]> = [
  ['commandTree', new RegExp(`^command_tree-${ASSET_BUILD}\\.xml$`)],
  ['bugsFixed', new RegExp(`^Bugs_Fixed_with_${ASSET_BUILD}\\.html?$`)],
  ['mib', new RegExp(`^[A-Za-z0-9]+-MIB(?:_[A-Za-z0-9]+)?-${ASSET_BUILD}\\.(?:txt|mib|my)$`)],
  ['image', new RegExp(`^[A-Za-z0-9]+-${ASSET_BUILD}\\.(?:array|click|img|iso|qcow2|ova|bin|tgz|tar\\.gz)$`)],
];

function fileKind(name: string): FileKind | null {
  for (const [kind, form] of ASSET_FORMS) if (form.test(name)) return kind;
  return null;
}

function imageDetails(text: string): { size?: string; sha256?: string; md5?: string } {
  const out: { size?: string; sha256?: string; md5?: string } = {};
  const sha = /SHA-?256\s*:?\s*([0-9a-fA-F]{64})(?![0-9a-fA-F])/i.exec(text);
  if (sha) out.sha256 = sha[1].toLowerCase();
  const md5 = /MD5\s*:?\s*([0-9a-fA-F]{32})(?![0-9a-fA-F])/i.exec(text);
  if (md5) out.md5 = md5[1].toLowerCase();
  const size = /\(\s*([0-9]{1,9}(?:\.[0-9]{1,3})?\s?[KMGTP]?i?B?)\s*[,)]/i.exec(text);
  if (size) out.size = size[1].replace(/\s+/g, '');
  return out;
}

function filesOf(name: string, links: Link[], warnings: string[]): BuildFiles {
  const files: BuildFiles = { image: null };
  const other: FileRef[] = [];
  for (const link of links) {
    const file = basename(link.href);
    const ref: FileRef = { name: file, href: link.href };
    if (file !== '' && !file.includes(name)) warnings.push(`构建 ${name} 的链接 ${file} 不含构建名，仍按位置归到该构建`);
    const kind = file === '' ? null : fileKind(file);
    if (kind === null) warnings.push(`构建 ${name} 的资产角色未核对：${file} 不符合 famx-assets@1 整名语法；下一步由包作者补资产语法或作者声明角色后重读，保留原链接`);
    if (kind === 'image' && files.image === null) {
      const image: ImageRef = { ...ref, ...imageDetails(link.text) };
      files.image = image;
    } else if (kind === 'commandTree' && files.commandTree === undefined) files.commandTree = ref;
    else if (kind === 'bugsFixed' && files.bugsFixed === undefined) files.bugsFixed = ref;
    else if (kind === 'mib' && files.mib === undefined) files.mib = ref;
    else other.push(ref);
  }
  if (other.length > 0) files.other = other;
  return files;
}

function readLinks(model: { [key: string]: unknown }): Array<Link | null> {
  return asArray(model.links).map((link) => {
    if (!isRecord(link)) return null;
    const href = asString(link.href);
    if (href === null || href.trim() === '') return null;
    return { href, text: asString(link.text) ?? '' };
  });
}

/** Links of the model that name a web page (.html or .htm, query and fragment aside). */
function pageLinks(links: Array<Link | null>): number {
  return links.filter((link) => link !== null && /\.html?$/i.test(link.href.trim().split(/[?#]/)[0])).length;
}

/**
 * Build entries of a listing page, in page order. A build listed twice keeps one entry by content (later build time, then
 * release, then command tree). A page without build entries that links other pages is flagged as a hub page.
 */
export function parseListing(model: HtmlModel, context: ListingContext = {}): ListingResult {
  const warnings: string[] = [];
  try {
    if (!isRecord(model) || !Array.isArray(model.blocks)) return { builds: [], hub: false, warnings: ['输入不是 html@1 模型（缺 blocks）'] };
    const pagePlatform = isRecord(context) && typeof context.platform === 'string' && context.platform.trim() !== '' ? context.platform.trim().toLowerCase() : null;
    const links = readLinks(model as unknown as { [key: string]: unknown });
    type Draft = { header: Header; red: boolean; links: Link[]; hrefs: Set<string> };
    const drafts: Draft[] = [];
    let orphanLinks = 0;
    let suspicious = 0;
    for (const block of model.blocks as unknown[]) {
      if (!isRecord(block)) continue;
      for (const line of linesOf(block)) {
        const raw = plain(line);
        const text = squeeze(raw);
        const header = text === '' ? null : parseHeader(text);
        if (header) {
          const offset = raw.indexOf(header.name);
          drafts.push({ header, red: offset >= 0 && redAt(line, offset), links: [], hrefs: new Set() });
          warnings.push(...header.problems);
        } else if (BUILD_ON.test(text)) suspicious++;
        for (const index of line.links) {
          const link = links[index];
          if (link === undefined || link === null) continue;
          const draft = drafts[drafts.length - 1];
          if (draft === undefined) orphanLinks++;
          else if (!draft.hrefs.has(link.href)) {
            draft.hrefs.add(link.href);
            draft.links.push(link);
          }
        }
      }
    }
    if (suspicious > 0) warnings.push(`有 ${suspicious} 行含“build on”却认不出构建名，已跳过`);
    if (orphanLinks > 0) warnings.push(`有 ${orphanLinks} 个链接出现在第一个构建条目之前，未归入任何构建`);

    const builds: Build[] = [];
    const position = new Map<string, number>();
    for (const draft of drafts) {
      const { header } = draft;
      if (header.released !== null && !draft.red) warnings.push(`构建 ${header.name} 有发布日期，但不在红色标注里`);
      if (header.released === null && draft.red) warnings.push(`构建 ${header.name} 有红色标注，但没有写发布日期，按未发布处理`);
      const parts = parseBuildName(header.name);
      const build: Build = {
        name: header.name,
        family: parts.family,
        platform: parts.platform ?? pagePlatform,
        line: parts.line,
        number: parts.number,
        built: header.built,
        ...(header.built===null ? {failure:'构建时间格式无法识别；请修正构建站列表后重新同步', built_raw: header.raw} : {}),
        released: header.released,
        basedOn: header.basedOn,
        files: filesOf(header.name, draft.links, warnings),
      };
      if (parts.variant !== null) build.variant = parts.variant;
      if (header.note !== null) build.note = header.note;
      if (parts.line === null) warnings.push(`构建名 ${header.name} 不符合命名规则，版本线与构建号未知`);
      const seen = position.get(build.name);
      if (seen === undefined) {
        position.set(build.name, builds.length);
        builds.push(build);
        continue;
      }
      const kept = builds[seen];
      const [winner, loser] = compareCopies(build, kept) < 0 ? [build, kept] : [kept, build];
      warnings.push(
        `构建 ${build.name} 列了两次（构建时间 ${loser.built ?? '未知'} 与 ${winner.built ?? '未知'}），按构建时间、发布记录、命令树保留构建于 ${winner.built ?? '未知'} 的一条` +
          (loser.released !== null && winner.released === null ? `；丢弃的一条写着发布于 ${loser.released}` : ''),
      );
      builds[seen] = winner;
    }
    const linked = builds.length === 0 ? pageLinks(links) : 0;
    if (linked > 0) warnings.push(`这一页没有构建条目，却链接了 ${linked} 个页面：像是导航页，可交给 planSync 当导航页读`);
    return { builds, hub: linked > 0, warnings };
  } catch (error) {
    return { builds: [], hub: false, warnings: [...warnings, internalError(error)] };
  }
}

/** Pack function entry: the html@1 model, or `{ model, context }`. */
export default function listing(input: unknown): ListingResult {
  return guarded(
    () => {
      if (isRecord(input) && isRecord(input.model) && !Array.isArray(input.blocks)) {
        return parseListing(input.model as unknown as HtmlModel, isRecord(input.context) ? (input.context as ListingContext) : {});
      }
      return parseListing(input as HtmlModel);
    },
    (warning) => ({ builds: [], hub: false, warnings: [warning] }),
  );
}
