// The build choice of a run without a declared build (product@1 select_build, SelectBuildInput -> SelectBuildOutput). The
// candidates are the builds of every name family that have a knowledge root. The rule of select-build.ts: the latest
// released build of the line across both families on the main platform (release date, build time, FAMX before FAMY, build
// number, name), every other qualifying build listed as an alternative. A line under test may have no release yet: then the
// newest build of the line on the main platform is chosen and the basis says it is not released. Without a line, the line of
// the newest released build is used.
import type { KnownBuild, SelectBuildInput, SelectBuildOutput } from '../../../../contracts/src/product.ts';
import { compareLines, deviceSpelling, lineKey, parseBuildName } from './naming.ts';
import { compareForRule, selectBuild } from './select-build.ts';
import type { Build, Family } from './types.ts';
import { compareDotted, compareNullable, compareText, internalError, isRecord } from './util.ts';

const NO_BUILD: SelectBuildOutput = { build: '-', basis: '没有可选的构建' };

/** A known build as the rule reads it: dates as the listing gives them, its own tree (it has a root). */
export function asBuild(known: KnownBuild): Build {
  const family: Family = known.family === 'FAMX' || known.family === 'FAMY' ? known.family : 'other';
  const parts = parseBuildName(known.name);
  return {
    name: known.name,
    family,
    platform: known.platform,
    line: known.line,
    number: parts.number,
    built: known.built_at,
    released: known.released_at === null ? null : known.released_at.slice(0, 10),
    basedOn: null,
    files: { image: null, commandTree: { name: 'tree', href: 'root' } },
    ...(parts.variant !== null ? { variant: parts.variant } : {}),
  };
}

export function chooseBuild(input: SelectBuildInput): SelectBuildOutput {
  try {
    if (!isRecord(input) || !Array.isArray(input.candidates)) return NO_BUILD;
    const all = input.candidates.filter((c): c is KnownBuild => isRecord(c) && typeof c.name === 'string' && typeof c.line === 'string');
    if (all.length === 0) return NO_BUILD;
    // The device display spelling of a build is its verified alias, not a build of its own (the pack's naming
    // declaration, C07 R[9]): it is never a candidate. Dropped only when the build it aliases is itself a candidate.
    const names = new Set(all.map((c) => c.name));
    const aliases = new Set(all.flatMap((c) => { const spelling = deviceSpelling(c.name); return spelling !== c.name && names.has(spelling) ? [spelling] : []; }));
    const candidates = all.filter((c) => !aliases.has(c.name));
    const builds = candidates.map(asBuild);
    let line = typeof input.line === 'string' && input.line.trim() !== '' ? input.line.trim() : null;
    if (line === null) {
      const released = builds.filter((b) => b.released !== null && b.family !== 'other' && b.platform === null).sort(compareForRule);
      line = released[0]?.line ?? [...builds].sort((a, b) => compareLines(b.line, a.line))[0].line;
      if (line === null) return NO_BUILD;
    }
    const result = selectBuild({ candidates: builds, line });
    if (result.build !== null) {
      return {
        build: result.build.name,
        basis: result.notes.join('；') || `按规则选定版本线 ${line} 最新发布的构建 ${result.build.name}`,
        alternatives: result.alternatives.map((b) => b.name),
      };
    }
    // No released build of the line: the newest one on the main platform, said to be unreleased.
    const ofLine = builds
      .filter((b) => b.family !== 'other' && b.platform === null && b.line !== null && lineKey(b.line) === lineKey(line as string) && !(typeof b.variant === 'string' && b.variant !== ''))
      .sort((a, b) => compareNullable(b.built, a.built) || (a.family === b.family ? 0 : a.family === 'FAMX' ? -1 : 1) || compareDotted(b.number, a.number) || compareText(a.name, b.name));
    if (ofLine.length === 0) return { build: NO_BUILD.build, basis: result.notes.join('；') || `版本线 ${line} 没有可选的构建` };
    return {
      build: ofLine[0].name,
      basis: `版本线 ${line} 还没有已发布的构建，选定主平台上最新的构建 ${ofLine[0].name}（构建于 ${ofLine[0].built ?? '未知'}，未发布）`,
      alternatives: ofLine.slice(1).map((b) => b.name),
    };
  } catch (error) {
    return { build: NO_BUILD.build, basis: internalError(error) };
  }
}

/** Pack function entry: SelectBuildInput -> SelectBuildOutput. */
export default function select(input: unknown): SelectBuildOutput {
  return chooseBuild(input as SelectBuildInput);
}
