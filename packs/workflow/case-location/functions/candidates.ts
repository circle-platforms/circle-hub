// The build_candidates check (K01 R[10]): for each item (document), the candidates are the builds of the located version
// line that the run's frozen context lists (every name family, an alias shown with the build it is based on), sorted with
// the released first by date descending, then by name. A build name written in the folders or the title is cross-checked
// against the knowledge base's builds of every line: known (it is a candidate, or the base one alias is based on) is a
// support; known but of another line is an advisory violation (the document names a build of a line it was not located
// into); not known is an unknown — the knowledge base lists only the builds of the build site, never a violation. No
// located line, or a line without any known build, is an unknown with the reason, never a pass.
import { lineKey, lineOfVersion } from './convention.ts';
import { locate, locateInputOf } from './locate.ts';
import { fold, guarded, internalError, isRecord, isReference } from './text.ts';
import type { CheckOutcome, ContextBuild, LocateSubject } from './types.ts';

const TIER = 'advisory' as const;

function isBuild(value: unknown): value is ContextBuild {
  if (!isRecord(value)) return false;
  return (
    typeof value.name === 'string' &&
    typeof value.family === 'string' &&
    typeof value.line === 'string' &&
    typeof value.base === 'string' &&
    (value.platform === null || typeof value.platform === 'string') &&
    (value.built_at === null || typeof value.built_at === 'string') &&
    (value.released_at === null || typeof value.released_at === 'string') &&
    typeof value.has_root === 'boolean'
  );
}

type Candidate = { name: string; family: string; base: string; alias: boolean; platform: string | null; built_at: string | null; released: boolean; released_at: string | null };

function candidateOf(build: ContextBuild): Candidate {
  return { name: build.name, family: build.family, base: build.base, alias: build.name !== build.base, platform: build.platform, built_at: build.built_at, released: build.released_at !== null, released_at: build.released_at };
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Built time descending, then by name; a build without a built time is last (by name). */
function orderCandidates(candidates: Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => {
    if ((a.built_at === null) !== (b.built_at === null)) return a.built_at === null ? 1 : -1;
    const byTime = (b.built_at ?? '').localeCompare(a.built_at ?? '');
    return byTime !== 0 ? byTime : compareText(a.name, b.name);
  });
}

/** The date-time part of an ISO time stamp as a person reads it (YYYY-MM-DD HH:mm), or the raw string. */
const builtText = (builtAt: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(builtAt) ? `${builtAt.slice(0, 10)} ${builtAt.slice(11, 16)}` : builtAt);

/** The date part of an ISO time stamp, or the raw string when it is not one. */
const dateOf = (releasedAt: string): string => (/^\d{4}-\d{2}-\d{2}/.test(releasedAt) ? releasedAt.slice(0, 10) : releasedAt);

/** One candidate as a person reads it: build (family) built at a time, an alias with the build it is based on, the
 * release state written apart (a formal release and the built time are different things). */
function candidateText(candidate: Candidate): string {
  const family = `${candidate.name}（${candidate.family}${candidate.alias ? `，基于 ${candidate.base}` : ''}）`;
  const built = candidate.built_at === null ? '制作时间未知' : `制作于 ${builtText(candidate.built_at)}`;
  const released = candidate.released ? `，已发布 ${dateOf(candidate.released_at ?? '')}` : '，未发布';
  return `${family}${built}${released}`;
}

/** How many candidates the statement writes out; the rest are counted, not listed. */
const MAX_LISTED = 12;

/** The version line used to list candidates. A located line is kept as stored. A version level with no line node
 * uses that version's own line (first three numbers, leading zeros removed, trailing zeros kept) so 10.7.0 still
 * matches the knowledge base. lineKey would collapse 10.7.0 to 10.7 and miss those builds. */
function candidateLine(answer: { line: string | null; version: string | null; version_values: readonly unknown[] }): string | null {
  if (answer.line !== null) return answer.line;
  if (answer.version === null || answer.version_values.length === 0) return null;
  return answer.version.split('.').slice(0, 3).map((part) => part.replace(/^0+(?=[0-9])/, '')).join('.');
}

/** The candidates outcome of one item: support with the list, or unknown with the reason (never a pass without a list). */
function candidatesOutcome(item: string, grounds: string[], pointer: string, line: string | null, builds: ContextBuild[]): CheckOutcome {
  if (line === null) {
    return {
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('定位没有给出版本线（目录树没有版本层），定不出构建候选'),
      reason: 'missing_input',
      statement: '定位没有给出版本线（目录树没有版本层），定不出构建候选',
      grounds,
      tier: TIER,
      item,
      pointer,
      data: { kind: 'candidates', line: null, candidates: [] },
    };
  }
  const ofLine = orderCandidates(builds.filter((b) => lineKey(b.line) === lineKey(line)).map(candidateOf));
  if (ofLine.length === 0) {
    return {
      verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`版本线 ${line} 在知识库里没有已知构建（知识库只收录构建站列出的构建），定不出构建候选`),
      reason: 'missing_input',
      statement: `版本线 ${line} 在知识库里没有已知构建（知识库只收录构建站列出的构建），定不出构建候选`,
      grounds,
      tier: TIER,
      item,
      pointer,
      data: { kind: 'candidates', line, candidates: [] },
    };
  }
  const aliases = ofLine.filter((c) => c.alias).length;
  const listed = ofLine.slice(0, MAX_LISTED).map(candidateText);
  const more = ofLine.length - listed.length;
  const statement = `版本线 ${line} 的构建候选 ${ofLine.length} 个${aliases > 0 ? `，其中别名 ${aliases} 个（别名基于它所基于的构建）` : ''}，按制作时间从新到旧：${listed.join('；')}${more > 0 ? `；另有 ${more} 个` : ''}`;
  return {
    verdict: 'support',
    statement,
    grounds,
    tier: TIER,
    item,
    pointer,
    data: { kind: 'candidates', line, candidates: ofLine.map(({ released_at: _r, ...rest }) => rest) },
  };
}

/** The cross-check of one written build name against the knowledge base's builds. `conflictLines` is the set of
 * lines the version level named when it contradicts itself; membership is by lineKey, and the statement names the
 * build's own line and those conflicting lines. */
function writtenOutcome(item: string, grounds: string[], pointer: string, name: string, line: string | null, builds: ContextBuild[], candidates: Candidate[], conflictLines: readonly string[] | null): CheckOutcome {
  const folded = fold(name);
  const data = { kind: 'written_build', name };
  const conflict = conflictLines !== null && conflictLines.length > 1;
  const prefix = conflict ? '目录版本层自相矛盾；' : '';
  const belongs = (buildLine: string): boolean => conflictLines?.some((entry) => lineKey(entry) === lineKey(buildLine)) ?? false;
  // Known to the located line: the name of a candidate, or the base one alias is based on.
  const known = candidates.find((c) => fold(c.name) === folded) ?? candidates.find((c) => fold(c.base) === folded);
  if (known !== undefined) {
    const isBase = fold(known.name) !== folded;
    const knownLine = builds.find((build) => fold(build.name) === fold(known.name))?.line;
    const statement = conflict
      ? (isBase
        ? `${prefix}写出的构建名 ${name} 是冲突版本线之一 ${knownLine} 的候选 ${known.name} 所依据的构建`
        : `${prefix}写出的构建名 ${name} 是冲突版本线之一 ${knownLine} 的构建`)
      : (isBase ? `写出的构建名 ${name} 是候选 ${known.name} 所依据的构建` : `写出的构建名 ${name} 是定位到的版本线的构建`);
    return {
      verdict: 'support',
      statement,
      grounds,
      tier: TIER,
      item,
      pointer,
      data: { ...data, build: known.name },
    };
  }
  const elsewhere = builds.find((b) => fold(b.name) === folded);
  if (elsewhere !== undefined) {
    if (conflict && conflictLines !== null) {
      if (belongs(elsewhere.line)) {
        return {
          verdict: 'support',
          statement: `${prefix}写出的构建名 ${name} 是冲突版本线之一 ${elsewhere.line} 的构建`,
          grounds,
          tier: TIER,
          item,
          pointer,
          data: { ...data, build: elsewhere.name, line: elsewhere.line },
        };
      }
      return {
        verdict: 'refute',
        code: 'case-location.build_other_line',
        statement: `${prefix}写出的构建名 ${name} 属于版本线 ${elsewhere.line}，不是冲突版本线 ${conflictLines.join('、')} 的构建`,
        grounds,
        tier: TIER,
        item,
        pointer,
        data: { ...data, line: elsewhere.line },
      };
    }
    if (line !== null && elsewhere.line !== line) {
      return {
        verdict: 'refute',
        code: 'case-location.build_other_line',
        statement: `写出的构建名 ${name} 属于版本线 ${elsewhere.line}，不是定位到的版本线 ${line} 的构建`,
        grounds,
        tier: TIER,
        item,
        pointer,
        data: { ...data, line: elsewhere.line },
      };
    }
    return {
      verdict: 'support',
      statement: `写出的构建名 ${name} 是版本线 ${elsewhere.line} 的构建${line === null ? '（定位没有给出版本线，谈不上“另一条线”）' : ''}`,
      grounds,
      tier: TIER,
      item,
      pointer,
      data: { ...data, build: elsewhere.name, line: elsewhere.line },
    };
  }
  return {
    verdict: 'refute',
    code: 'case-location.build_not_listed',
    statement: `构建站没有列出写出的构建名 ${name}（本次运行冻结的构建清单只收录构建站列出的构建；不认识不等于写错）`,
    grounds,
    tier: 'advisory',
    item,
    pointer,
    data,
  };
}

/** Outcomes of the check for a subject of the subject builder (functions/subject.ts): per item, the candidates, then one
 * outcome per written build name. */
export function candidatesOutcomes(subject: unknown): CheckOutcome[] {
  const raw = isRecord(subject) ? subject : {};
  const context = isRecord(raw.context) ? raw.context : {};
  const builds = (Array.isArray(context.builds) ? context.builds : []).filter(isBuild);
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isRecord);
  const out: CheckOutcome[] = [];
  for (const [at, value] of items.entries()) {
    if (typeof value.id !== 'string' || value.id === '') continue;
    const id = value.id;
    const location = typeof value.location === 'string' ? value.location : '';
    const grounds = isReference(location) ? [location] : [];
    const pointer = `/items/${at}/fields`;
    try {
      const answer = locate(locateInputOf(id, value.fields, context));
      const located = candidateLine(answer);
      const candidates = located === null ? [] : orderCandidates(builds.filter((b) => lineKey(b.line) === lineKey(located)).map(candidateOf));
      // One original line per lineKey. Matching uses lineKey, so 10.7.0 still finds builds stored as 10.7.0; the statement keeps the trailing zero.
      const byKey = new Map<string, string>();
      for (const versionValue of answer.version_values) {
        const raw = lineOfVersion(versionValue.version);
        const key = lineKey(raw);
        if (!byKey.has(key)) byKey.set(key, raw);
      }
      const lines = [...byKey.keys()];
      if (lines.length > 1) {
        for (const line of byKey.values()) {
          const outcome = candidatesOutcome(id, grounds, pointer, line, builds);
          out.push({ ...outcome, statement: `目录版本层自相矛盾，分别列出候选；${outcome.statement}` });
        }
      } else if (located === null && answer.version_values.length > 0) {
        out.push({
          verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('版本层没有版本线节点，定不出构建候选；下一步由整理敏捷平台目录的人在版本层写上版本线节点。'),
          reason: 'missing_input',
          statement: '版本层没有版本线节点，定不出构建候选；下一步由整理敏捷平台目录的人在版本层写上版本线节点。',
          grounds,
          tier: TIER,
          item: id,
          pointer,
          data: { kind: 'candidates', line: null, candidates: [] },
        });
      } else out.push(candidatesOutcome(id, grounds, pointer, located, builds));
      const conflictLines = lines.length > 1 ? lines : null;
      const writtenCandidates = conflictLines === null ? candidates : orderCandidates(builds.filter(build => conflictLines.some(line => lineKey(line) === lineKey(build.line))).map(candidateOf));
      for (const name of answer.build_names) out.push(writtenOutcome(id, grounds, pointer, name, conflictLines === null ? located : null, builds, writtenCandidates, conflictLines));
    } catch (error) {
      out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`构建候选检查出错（任务包缺陷）：${internalError(error)}`), reason: 'check_error', statement: `构建候选检查出错（任务包缺陷）：${internalError(error)}`, grounds, tier: TIER, item: id, pointer });
    }
  }
  if (out.length === 0) out.push({ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + ('构建候选检查的被判对象里没有条目（子对象构建函数没有给出 items）'), reason: 'check_error', statement: '构建候选检查的被判对象里没有条目（子对象构建函数没有给出 items）', grounds: [], tier: TIER });
  return out;
}

/** Pack check function: PackCheckInput of hub/rules -> check-outcome@1 array. */
export default function candidatesCheck(input: unknown): unknown {
  return guarded<unknown>(
    () => candidatesOutcomes(isRecord(input) ? input.subject : undefined),
    (message) => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`构建候选检查出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `构建候选检查出错（任务包缺陷）：${message}`, grounds: [], tier: TIER }],
  );
}
