// Build selection for a run (W03 R[0], W06 F[6], K01 R[10]). A declared build name wins (either family); otherwise the
// rule picks the latest released build of the line across both families on the main platform whose knowledge root can be
// determined. An FAMY-named build with its own command tree is its own base (the newest lines); one without a tree
// resolves to the base build its "based on" text names (the older lines).
import type { Build, SelectBuildInput, SelectBuildResult } from './types.ts';
import { compareCopies, hasCommandTree } from './builds.ts';
import { lineKey, sameLine } from './naming.ts';
import { asArray, asString, asStrings, canonicalJson, compareDotted, compareNullable, compareText, guarded, internalError, isRecord } from './util.ts';

const MAX_CHAIN = 8;

/** A variant build (prefix or suffix around the core name); JSON inputs may carry null for none. */
function isVariant(build: Build): boolean {
  return typeof build.variant === 'string' && build.variant !== '';
}

/** Rule order, best first: release date, build time, FAMX before FAMY, build number, then name. */
export function compareForRule(a: Build, b: Build): number {
  return (
    compareNullable(b.released, a.released) ||
    compareNullable(b.built, a.built) ||
    (a.family === b.family ? 0 : a.family === 'FAMX' ? -1 : b.family === 'FAMX' ? 1 : 0) ||
    compareDotted(b.number, a.number) ||
    compareText(a.name, b.name)
  );
}

function validBuild(value: unknown): value is Build {
  return (
    isRecord(value) &&
    typeof value.name === 'string' &&
    value.name.trim() !== '' &&
    (value.family === 'FAMX' || value.family === 'FAMY' || value.family === 'other') &&
    (value.platform === null || typeof value.platform === 'string') &&
    (value.line === null || typeof value.line === 'string') &&
    (value.number === null || typeof value.number === 'string') &&
    (value.built === null || typeof value.built === 'string') &&
    (value.released === null || typeof value.released === 'string') &&
    (value.basedOn === null || typeof value.basedOn === 'string')
  );
}

/**
 * Valid builds by name, in name order. A name given more than once keeps one copy by content (compareCopies: later build
 * time, then release, then command tree), never by the order of the input; copies that differ are named in a note.
 */
export function indexBuilds(values: unknown[], notes: string[]): Map<string, Build> {
  const copies = new Map<string, Build[]>();
  let invalid = 0;
  for (const value of values) {
    if (!validBuild(value)) {
      invalid++;
      continue;
    }
    const list = copies.get(value.name);
    if (list === undefined) copies.set(value.name, [value]);
    else list.push(value);
  }
  if (invalid > 0) notes.push(`有 ${invalid} 个候选构建格式不对，已忽略`);
  const byName = new Map<string, Build>();
  for (const name of [...copies.keys()].sort(compareText)) {
    const list = (copies.get(name) as Build[]).sort(compareCopies);
    byName.set(name, list[0]);
    if (list.length > 1 && new Set(list.map((copy) => canonicalJson(copy))).size > 1) {
      notes.push(`构建 ${name} 出现了 ${list.length} 次，内容不一致；按构建时间、发布记录、命令树取其中一条（构建于 ${list[0].built ?? '未知'}，${list[0].released === null ? '未发布' : `发布于 ${list[0].released}`}）`);
    }
  }
  return byName;
}

/**
 * The build whose knowledge root a build uses: itself for an FAMX name, and for an FAMY name that links its own command tree
 * (the newest lines); otherwise the build its `based on` chain ends in, the first one that is FAMX-named or has its own tree.
 * Never guessed from equal numbers: they differ in about half of the real entries.
 */
export function resolveBase(build: Build, byName: ReadonlyMap<string, Build>, notes: string[]): Build | null {
  if (build.family !== 'FAMY') return build;
  if (hasCommandTree(build)) {
    if (build.basedOn !== null) notes.push(`构建 ${build.name} 自带命令树，按它自己的命令树建根（页面也写了基于 ${build.basedOn}）`);
    return build;
  }
  let current = build;
  const seen = new Set<string>([build.name]);
  for (let step = 0; step < MAX_CHAIN; step++) {
    if (current.basedOn === null) {
      notes.push(`构建 ${current.name} 没有命令树，也没有写明基础构建，知识根无法确定`);
      return null;
    }
    const next = byName.get(current.basedOn);
    if (next === undefined) {
      notes.push(`构建 ${current.name} 的基础构建 ${current.basedOn} 不在候选构建里，需先同步它所在的列表页`);
      return null;
    }
    if (seen.has(next.name)) {
      notes.push(`构建 ${build.name} 的基础构建链有环（${[...seen, next.name].join(' → ')}）`);
      return null;
    }
    seen.add(next.name);
    if (next.family === 'other') {
      notes.push(`构建 ${build.name} 的基础构建 ${next.name} 不属于 FAMX 或 FAMY 名称族，知识根无法确定`);
      return null;
    }
    if (next.family === 'FAMX' || hasCommandTree(next)) {
      if (step > 0) notes.push(`构建 ${build.name} 经 ${[...seen].join(' → ')} 落到基础构建 ${next.name}`);
      return next;
    }
    current = next;
  }
  notes.push(`构建 ${build.name} 的基础构建链超过 ${MAX_CHAIN} 层，已停止`);
  return null;
}

export function selectBuild(input: SelectBuildInput): SelectBuildResult {
  const notes: string[] = [];
  let declared: string | null = null;
  const result = (build: Build | null, base: Build | null, alternatives: Build[] = []): SelectBuildResult => ({
    build,
    base,
    basis: declared !== null ? 'declared' : 'projected',
    alternatives,
    notes,
  });
  try {
    if (!isRecord(input)) {
      notes.push('输入不是对象');
      return result(null, null);
    }
    const declaredText = asString(input.declared);
    declared = declaredText !== null && declaredText.trim() !== '' ? declaredText.trim() : null;
    const byName = indexBuilds(asArray(input.candidates), notes);
    const lineText = asString(input.line);
    const line = lineText !== null && lineText.trim() !== '' ? lineText.trim() : null;
    const platforms = new Set(asStrings(input.includePlatforms).map((platform) => platform.trim().toLowerCase()));

    if (declared !== null) {
      const wanted = declared;
      let build = byName.get(wanted);
      if (build === undefined) {
        const folded = [...byName.values()].filter((candidate) => candidate.name.toLowerCase() === wanted.toLowerCase());
        if (folded.length === 1) {
          build = folded[0];
          notes.push(`声明的构建 ${declared} 按不区分大小写对上了 ${build.name}`);
        }
      }
      if (build === undefined) {
        notes.push(`声明的构建 ${declared} 不在候选构建里`);
        return result(null, null);
      }
      if (build.family === 'other') {
        notes.push(`声明的构建 ${build.name} 不属于 FAMX 或 FAMY 名称族`);
        return result(null, null);
      }
      if (line !== null && build.line !== null && !sameLine(line, build.line)) notes.push(`声明的构建 ${build.name} 属于版本线 ${build.line}，不是 ${line}`);
      if (build.released === null) notes.push(`声明的构建 ${build.name} 没有发布记录`);
      if (build.platform !== null) notes.push(`声明的构建 ${build.name} 是 ${build.platform} 平台的构建`);
      if (isVariant(build)) notes.push(`声明的构建 ${build.name} 是变体构建（${build.variant}）`);
      return result(build, resolveBase(build, byName, notes));
    }

    if (line === null) {
      notes.push('没有给版本线，也没有声明构建，无法按规则选择');
      return result(null, null);
    }
    const ofLine = [...byName.values()].filter((build) => build.line !== null && lineKey(build.line) === lineKey(line));
    const qualifying = ofLine.filter(
      (build) =>
        build.family !== 'other' &&
        build.released !== null &&
        (build.platform === null || platforms.has(build.platform.toLowerCase())) &&
        !isVariant(build),
    );
    if (qualifying.length === 0) {
      if (ofLine.length === 0) notes.push(`候选构建里没有版本线 ${line} 的构建（共 ${byName.size} 个候选）`);
      else {
        const unreleased = ofLine.filter((build) => build.released === null).length;
        const otherPlatform = ofLine.filter((build) => build.released !== null && build.platform !== null && !platforms.has(build.platform.toLowerCase())).length;
        const variants = ofLine.filter((build) => build.released !== null && isVariant(build)).length;
        notes.push(
          `版本线 ${line} 没有符合规则的构建：${ofLine.length} 个候选里 ${unreleased} 个未发布，${otherPlatform} 个属于其他平台，${variants} 个是变体构建`,
        );
      }
      return result(null, null);
    }
    qualifying.sort(compareForRule);
    // The first qualifying build whose root can be determined; better-ranked ones without a root are passed over with a
    // note and stay among the alternatives. When none has a root, the best one is named without a base.
    const reasons: string[][] = [];
    let chosen = -1;
    let base: Build | null = null;
    for (let k = 0; k < qualifying.length && chosen < 0; k++) {
      const local: string[] = [];
      base = resolveBase(qualifying[k], byName, local);
      reasons.push(local);
      if (base !== null) chosen = k;
    }
    if (chosen < 0) chosen = 0;
    const build = qualifying[chosen];
    const alternatives = qualifying.filter((_, k) => k !== chosen);
    notes.push(`按规则选定版本线 ${line} 最新发布的${build.platform === null ? '主平台' : ` ${build.platform} 平台`}构建 ${build.name}（发布于 ${build.released}）`);
    if (base !== null && chosen > 0) {
      const passed = qualifying.slice(0, chosen).map((item, k) => `${item.name}（${reasons[k].join('；')}）`);
      notes.push(`排在前面的 ${passed.join('、')} 知识根无法确定，改选 ${build.name}`);
    }
    const next = qualifying[chosen + 1];
    if (next !== undefined && next.released === build.released) notes.push(`${next.name} 同日发布，按构建时间、名称族和构建号排在后面`);
    notes.push(...reasons[chosen]);
    return result(build, base, alternatives);
  } catch (error) {
    notes.push(internalError(error));
    return result(null, null);
  }
}

/** Pack function entry: SelectBuildInput. */
export default function selectBuildFunction(input: unknown): SelectBuildResult {
  return guarded(
    () => selectBuild(input as SelectBuildInput),
    (warning) => ({ build: null, base: null, basis: 'projected', alternatives: [], notes: [warning] }),
  );
}
