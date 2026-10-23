// Gold script: build candidates of one version line computed independently from the build site listing page.
// Strictly independent by design — imports nothing from hub/ or packs/; the build naming, version line, and
// based-on alias rules are re-implemented directly from packs/product/apv/README.md.
//   node scripts/real/gold/builds.ts --page <listing.html> --line <versionLine> --out <gold.json>
// The output JSON is an array of { name, family, base, released }.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export interface BuildCandidate {
  name: string;
  family: string;
  base: string;
  /** The page's “build on” time, ISO YYYY-MM-DDTHH:mm:ss; null when the page carries none or an unreadable one. */
  built: string | null;
  released: string | null;
}

interface RawEntry {
  name: string;
  family: string;
  line: string;
  built: string | null;
  released: string | null;
  basedOn: string | null;
  hasCommandTree: boolean;
}

/** Drop leading zeros and trailing .0 beyond the second part, so 10.6 and 10.6.0 are one line. */
export function lineKey(line: string): string {
  const parts = line
    .split(/[._]/)
    .filter((p) => p.length > 0)
    .map((p) => String(parseInt(p, 10)));
  while (parts.length > 2 && parts[parts.length - 1] === '0') {
    parts.pop();
  }
  return parts.join('.');
}

/** Parses version line from the numbers following the family and optional platform token. */
function parseLineFromNumbers(nums: string[]): string {
  if (nums.length >= 3) return nums.slice(0, 3).join('.');
  return nums.join('.');
}

/** Extracts the name, family, and version line from a build name. */
function parseBuildName(name: string): { family: string; line: string } | null {
  // Pattern: [prefix-]Rel|Beta <sep> family[-PLATFORM] <sep> n <sep> n ... [suffix]
  const match = /(?:^|[._\-])(?:Rel|Beta)[_.](APV|NSAE)(?:-([A-Za-z0-9-]+))?[_.]([0-9]+(?:[_.][0-9]+)*)/i.exec(name);
  if (!match) return null;
  const family = match[1].toUpperCase();
  const numParts = match[3].split(/[._]/);
  const line = parseLineFromNumbers(numParts);
  return { family, line };
}

/** Reads a complete release date (YYYY-MM-DD or YYYY-MM), returning ISO string or null. */
function parseReleasedDate(text: string): string | null {
  const match = /Released\s+on\s+([0-9]{4}[-/][0-9]{2}(?:[-/][0-9]{2}|-xx)?)/i.exec(text);
  if (!match) return null;
  const raw = match[1].replace(/\//g, '-');
  if (raw.endsWith('-xx')) return raw.slice(0, 7);
  // Must be YYYY-MM-DD or YYYY-MM
  if (/^[0-9]{4}-[0-9]{2}(?:-[0-9]{2})?$/.test(raw)) return raw;
  return null;
}

/** Parses raw build entries from HTML content. */
function parseRawEntries(html: string): RawEntry[] {
  // An entry starts with: <buildName> (build on <date> <time> ):
  const entryPattern = /(?:^|>|\s)([A-Za-z0-9_.\-]*?(?:Rel|Beta)[_.](?:APV|NSAE)[A-Za-z0-9_.\-]*)\s*\(\s*build\s+on\s+([^)]*)\)\s*:/gi;

  const matches: Array<{ name: string; built: string | null; index: number; matchEnd: number }> = [];
  for (const m of html.matchAll(entryPattern)) {
    const cleanName = m[1].replace(/<[^>]+>/g, '').trim();
    const timeMatch = /([0-9]{4}[-/.][0-9]{2}[-/.][0-9]{2})\s+([0-9]{2}:[0-9]{2}:[0-9]{2})/.exec(m[2]);
    let built: string | null = null;
    if (timeMatch !== null) {
      const date = timeMatch[1].replace(/[/.]/g, '-');
      const [year, month, day] = date.split('-').map((p) => parseInt(p, 10));
      const [hour, minute, second] = timeMatch[2].split(':').map((p) => parseInt(p, 10));
      // A real calendar time only: month 01-12, day 01-31, hour 00-23, minute/second 00-59.
      const plausible = month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59 && second <= 59;
      if (plausible) built = `${date}T${timeMatch[2]}`;
    }
    matches.push({ name: cleanName, built, index: m.index ?? 0, matchEnd: (m.index ?? 0) + m[0].length });
  }

  const entries: RawEntry[] = [];
  for (let i = 0; i < matches.length; i++) {
    const cur = matches[i];
    const parsed = parseBuildName(cur.name);
    if (!parsed) continue;

    const nextIndex = i + 1 < matches.length ? matches[i + 1].index : html.length;
    const body = html.slice(cur.matchEnd, nextIndex);

    // Entry line text is before the blockquote / links
    const firstBlock = body.search(/<BLOCKQUOTE|<blockquote|<A\s|<a\s/i);
    const lineText = firstBlock >= 0 ? body.slice(0, firstBlock) : body.split('\n')[0];

    // based on <base>
    const basedOnMatch = /based\s+on\s+([A-Za-z0-9_.\-]+)/i.exec(lineText);
    const basedOn = basedOnMatch ? basedOnMatch[1] : null;

    // Released on <date>
    const released = parseReleasedDate(lineText);

    // Command tree link
    const hasCommandTree = /href\s*=\s*["']?[^"'>]*command_tree[^"'>]*\.xml["']?/i.test(body);

    entries.push({
      name: cur.name,
      family: parsed.family,
      line: parsed.line,
      built: cur.built,
      released,
      basedOn,
      hasCommandTree,
    });
  }

  return entries;
}

/** Resolves the base build of an entry, following basedOn chain for aliases without command trees. */
function resolveBase(entry: RawEntry, byName: Map<string, RawEntry>): string {
  // APV names are their own base unless explicitly declared based on another
  if (entry.family === 'APV' && !entry.basedOn) return entry.name;
  // An NSAE build with its own command tree is its own base
  if (entry.hasCommandTree && !entry.basedOn) return entry.name;

  if (entry.basedOn) {
    let curName = entry.basedOn;
    const seen = new Set<string>([entry.name]);
    while (curName && !seen.has(curName)) {
      seen.add(curName);
      const target = byName.get(curName);
      if (!target) return curName;
      if (target.hasCommandTree || target.family === 'APV' || !target.basedOn) {
        return target.name;
      }
      curName = target.basedOn;
    }
    return curName ?? entry.name;
  }

  return entry.name;
}

/** Parses candidate builds of the specified version line from build site HTML. */
export function parseBuildCandidates(html: string | readonly string[], targetLine: string): BuildCandidate[] {
  const targetKey = lineKey(targetLine);
  const rawEntries = (typeof html === 'string' ? [html] : html).flatMap(parseRawEntries);

  // Map by name keeping latest copy if duplicated
  const byName = new Map<string, RawEntry>();
  for (const entry of rawEntries) {
    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
    } else {
      // Keep copy with later build time, then release, then command tree
      const keepNew =
        (entry.built ?? '') > (existing.built ?? '') ||
        (existing.released === null && entry.released !== null) ||
        (!existing.hasCommandTree && entry.hasCommandTree);
      if (keepNew) byName.set(entry.name, entry);
    }
  }

  const results: BuildCandidate[] = [];
  for (const entry of byName.values()) {
    if (lineKey(entry.line) !== targetKey) continue;
    const base = resolveBase(entry, byName);
    results.push({
      name: entry.name,
      family: entry.family,
      base,
      built: entry.built,
      released: entry.released,
    });
  }

  return results;
}

/** Reject any Git checkout, including worktrees and symlinks into a checkout. Values never go into Git. */
export function privatePath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) throw new Error('路径无效');
    existing = parent;
  }
  const canonical = resolve(realpathSync(existing), relative(existing, absolute));
  for (let cursor = canonical; ; cursor = dirname(cursor)) {
    if (existsSync(join(cursor, '.git'))) throw new Error('路径必须在 Git 仓库之外');
    if (dirname(cursor) === cursor) break;
  }
  return canonical;
}

/** Writes a private, immutable capture. Only newly created directories and files receive permissions. */
export function writePrivateJson(path: string, value: unknown): string {
  const target = privatePath(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(value, null, 2) + '\n';
  writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
  return text;
}

export interface BuildsGold { line: string; candidates: BuildCandidate[] }

export async function main(argv: string[]): Promise<number> {
  const pages: string[] = [];
  let line: string | undefined, out: string | undefined;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!value || value.startsWith('--') || !['--page', '--line', '--out'].includes(flag)) { process.stderr.write('参数无效\n'); return 2; }
    if (flag === '--page') pages.push(value);
    else if (flag === '--line') line = value;
    else out = value;
  }
  if (!pages.length || !line || !out || !/^v?[0-9]+(?:[._][0-9]+)+$/i.test(line)) {
    process.stderr.write('用法：--page <页面> [--page <页面>] --line <版本线> --out <仓库外文件>\n');
    return 2;
  }
  try {
    const candidates = parseBuildCandidates(pages.map(page => readFileSync(privatePath(page), 'utf8')), line.replace(/^v/i, ''));
    writePrivateJson(out, { line: lineKey(line.replace(/^v/i, '')), candidates } satisfies BuildsGold);
    process.stdout.write(`候选 ${candidates.length} 个，APV ${candidates.filter(c => c.family === 'APV').length}、NSAE ${candidates.filter(c => c.family === 'NSAE').length}、别名 ${candidates.filter(c => c.name !== c.base).length}、没有制作时间 ${candidates.filter(c => c.built === null).length}\n`);
    return 0;
  } catch {
    process.stderr.write('读取或写入失败：输入输出须在仓库外，输出不可覆盖\n');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
