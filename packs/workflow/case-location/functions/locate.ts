// The owner's attribution scheme for one case or document (pure). The root of the agile tree decides the product (a root
// name equal to a name of the run's product line belongs to that line; anything else is reported as the tree names it, with
// no line). The version comes from the version level of the folders: the convention's line and release-train nodes
// (`NNN：<line>` / `NNN：<line>-<train>`) and labels that are only a version; the one nearest the root wins, and the level
// must name one version line, else the answer reports a definite conflict with every value kept. A version only mentioned among other words
// of a folder, or only in the title, is a reference version (confidence low, unknown); no version is version unknown, not an
// error. Build dates and patches count at the version level only. Module by the convention; build names as written, never
// derived; linked ids from the title, the folders below the version level and, for a case, the map. The caller's
// declarations fill only what the tree does not give; one that contradicts the tree is a conflict. The folders are the
// system pack's metadata of the read, not a cited fragment, and every statement says so. The answer is a fact only when the
// tree gives the product line and a consistent version level.
import {
  CONFLICT_CODE,
  buildVersionsOf,
  LABELS,
  lineKey,
  lineOfLabel,
  lineOfVersion,
  moduleOfLabel,
  parseLabel,
  pureVersionOf,
  schemeScan,
  trainOfLabel,
  versionsAgree,
  writtenBuilds,
  type Label,
  type SchemeKind,
  type SchemeMatch,
} from './convention.ts';
import { extractIds, hasIds } from './ids.ts';
import { kindByRange, readParameters } from './params.ts';
import { fold, guarded, isRecord, shown, strings, unique } from './text.ts';
import type { Confidence, Conflict, Declared, FormSource, IdRanges, IdSource, ItemFields, Judgment, LinkedId, LocateAnswer, LocateInput, VersionSource } from './types.ts';

export const LIMITS = {
  /** Folder labels read, from the root down. */
  maxLabels: 64,
  /** Map path labels read for a case item. */
  maxPath: 64,
  /** Ids per kind (requirements, defects, unclassified). */
  maxIds: 50,
  maxBuildNames: 24,
  maxNotes: 16,
  /** Longest text kept in an answer. */
  maxText: 200,
} as const;

/** Where the folder facts come from: the cited location is the item's node, which does not hold them (B01, B03). */
export const FOLDERS_BASIS = '目录是敏捷平台读取时列出的，取自系统包的元数据，没有引用片段';

const ID_SOURCE_LABEL: Readonly<Record<IdSource, string>> = { title: '标题', folders: '目录', map: '脑图' };
const FORM_LABEL: Readonly<Record<Exclude<SchemeKind, 'version'>, string>> = { build: '构建日期', patch: 'patch' };

type Notes = string[];
/** Why an answer is not a fact: in full (the statement) and in a few words (the summary lead). */
type Doubt = { text: string; brief: string; missing?: string; next?: string };

/** What is missing when the folders have no version level, decided from whether line was already declared. */
function missingVersionNext(declaredLine: string | null): string {
  return declaredLine === null
    ? '缺少目录里的版本层；下一步由整理敏捷平台目录的人补齐版本层，或开始运行时用参数 line 声明（结论标为声明）。'
    : '缺少目录里的版本层；下一步由整理敏捷平台目录的人把文档放到声明的版本线下；版本线已经声明，整理目录后才能核对。';
}

function note(notes: Notes, text: string): void {
  if (notes.length < LIMITS.maxNotes && !notes.includes(text)) notes.push(text);
}

const quoted = (text: string): string => `“${shown(text, 60)}”`;
const listOf = (items: readonly string[]): string => (items.length <= 3 ? items.join('、') : `${items.slice(0, 3).join('、')} 等 ${items.length} 个`);
const lineOf = (version: string): string => lineKey(lineOfVersion(version));

// ---------------------------------------------------------------- the folder convention

type Convention = {
  /** The line node nearest above the train, else the first line node, else the train's version. */
  line: string | null;
  /** Where that line node is; -1 when the line is the train's version or there is none. */
  lineAt: number;
  train: string | null;
  trainAt: number;
  trainVersion: string | null;
  module: string | null;
  /** Every line node of the path, root first. */
  lineNodes: Array<{ at: number; line: string }>;
};

/** Line, train and module by the folder convention, with notes where it holds only in part. */
function convention(labels: readonly Label[], notes: Notes): Convention {
  const lineNodes = labels.flatMap((label, at) => {
    const line = lineOfLabel(label);
    return line === null ? [] : [{ at, line }];
  });
  const trainAt = labels.findIndex((label) => trainOfLabel(label) !== null);
  if (trainAt >= 0) {
    const { train, version } = trainOfLabel(labels[trainAt])!;
    const above = lineNodes.filter((n) => n.at < trainAt);
    const nearest = above.length > 0 ? above[above.length - 1] : null;
    if (nearest === null) note(notes, `发布火车上面没有版本线节点，版本线取自发布火车 ${train}`);
    let module: string | null = null;
    if (trainAt + 1 < labels.length) {
      module = moduleOfLabel(labels[trainAt + 1], hasIds);
      if (module === null) note(notes, `发布火车下一层${quoted(labels[trainAt + 1].rest)}不是模块名`);
    } else note(notes, '发布火车下面没有模块层');
    return { line: nearest?.line ?? version, lineAt: nearest?.at ?? -1, train, trainAt, trainVersion: version, module, lineNodes };
  }
  if (lineNodes.length === 0) {
    note(notes, '目录里没有版本线节点（NNN：版本线）');
    return { line: null, lineAt: -1, train: null, trainAt: -1, trainVersion: null, module: null, lineNodes };
  }
  note(notes, '版本线下面没有发布火车节点（NNN：版本线-火车）');
  return { line: lineNodes[0].line, lineAt: lineNodes[0].at, train: null, trainAt: -1, trainVersion: null, module: null, lineNodes };
}

// ---------------------------------------------------------------- the version level

type Level = {
  /** Index of the last label of the version level (the train, else the first line node, else the first version label); -1 without one. */
  end: number;
  /** The version nearest the root at the version level, or null without one. */
  value: string | null;
  /** Indexes of the labels whose version belongs to the level (their versions are no quotes). */
  labels: ReadonlySet<number>;
  /** Why the level contradicts itself, or null. */
  disagreement: Doubt | null;
  values: Array<{ at: number; value: string }>;
};

/**
 * The version level of the folders: the labels from the root to the release train (or the first line node, or the first
 * label that is only a version), with every line node of the path. Its versions must name one version line.
 */
function versionLevel(labels: readonly Label[], conv: Convention, names: readonly string[], notes: Notes): Level {
  const pure = labels.map((label) => pureVersionOf(label, names));
  const builds = labels.map(label => buildVersionsOf(label, names));
  const firstPure = pure.findIndex((v, at) => v !== null || builds[at].length > 0);
  const end = conv.trainAt >= 0 ? conv.trainAt : conv.lineNodes.length > 0 ? conv.lineNodes[0].at : firstPure;
  if (end < 0) return { end: -1, value: null, labels: new Set(), disagreement: null, values: [] };
  const values: Array<{ at: number; value: string }> = [];
  for (let at = 0; at <= end; at++) {
    const node = conv.lineNodes.find((n) => n.at === at);
    if (node !== undefined) values.push({ at, value: node.line });
    else if (at === conv.trainAt && conv.trainVersion !== null) values.push({ at, value: conv.trainVersion });
    else if (pure[at] !== null) values.push({ at, value: pure[at]! });
    else for (const build of builds[at]) {
      values.push({ at, value: build.version });
      note(notes, `版本取自目录名里的构建名 ${build.name}`);
    }
  }
  for (const n of conv.lineNodes) if (n.at > end) values.push({ at: n.at, value: n.line });
  const level = { end, values, value: values[0]?.value ?? null, labels: new Set(values.map((v) => v.at)) };
  if (unique(values.map((v) => lineOf(v.value))).length <= 1) return { ...level, disagreement: null };
  const distinct = (list: readonly string[]): string[] => list.filter((v, k) => list.findIndex((w) => lineOf(w) === lineOf(v)) === k);
  const lines = distinct(conv.lineNodes.map((n) => n.line));
  if (lines.length > 1) {
    return { ...level, disagreement: { text: `目录里有几个版本线节点（${listOf(lines)}），版本层自相矛盾`, brief: `目录里有几个版本线：${listOf(lines)}` } };
  }
  if (conv.lineAt >= 0 && conv.trainVersion !== null && lineOf(conv.trainVersion) !== lineOf(conv.line!)) {
    return { ...level, disagreement: { text: `发布火车 ${shown(conv.train!, 60)} 的版本与版本线 ${conv.line} 不一致，版本层自相矛盾`, brief: '发布火车与版本线不一致' } };
  }
  const all = distinct(values.map((v) => v.value));
  return { ...level, disagreement: { text: `目录里版本层的版本不一致（${listOf(all)}），版本层自相矛盾`, brief: `目录里的版本不一致：${listOf(all)}` } };
}

// ---------------------------------------------------------------- ids

type IdRead = { text: string; from: IdSource; leading: boolean };

/** The linked ids of the texts read: marked kinds, unmarked ids, where each was read, and the kinds the caller's ranges give. */
function idsOf(reads: readonly IdRead[], ranges: IdRanges | null | undefined, notes: Notes): Pick<LocateAnswer, 'requirements' | 'defects' | 'unclassified' | 'id_sources' | 'ranged'> {
  const sources: LinkedId[] = [];
  const counts = { story: 0, bug: 0, unmarked: 0 };
  for (const read of reads) {
    for (const found of extractIds(read.text, { leading: read.leading })) {
      let entry = sources.find((s) => s.kind === found.kind && s.id === found.id);
      if (entry === undefined) {
        const key = found.kind ?? 'unmarked';
        if (counts[key] >= LIMITS.maxIds) continue;
        counts[key] += 1;
        entry = { id: found.id, kind: found.kind, from: [], ...(found.spellings ? { spellings: [...found.spellings] } : {}) };
        sources.push(entry);
      }
      if (entry.spellings || found.spellings) entry.spellings = unique([...(entry.spellings ?? [entry.id]), ...(found.spellings ?? [found.id])]);
      if (!entry.from.includes(read.from)) entry.from.push(read.from);
    }
  }
  // A number a word marks somewhere is that kind wherever else it stands unmarked.
  const marked = sources.filter((s) => s.kind !== null);
  const kept: LinkedId[] = [];
  for (const s of sources) {
    const named = s.kind === null ? marked.filter((m) => m.id === s.id) : [];
    if (named.length === 0) kept.push(s);
    else for (const m of named) {
      for (const from of s.from) if (!m.from.includes(from)) m.from.push(from);
      if (m.spellings || s.spellings) m.spellings = unique([...(m.spellings ?? [m.id]), ...(s.spellings ?? [s.id])]);
    }
  }
  const unclassified = kept.filter((s) => s.kind === null).map((s) => s.id);
  const ranged = {
    requirements: unclassified.filter((id) => kindByRange(id, ranges) === 'story'),
    defects: unclassified.filter((id) => kindByRange(id, ranges) === 'bug'),
  };
  const display = (ids: string[]) => ids.map(id => kept.find(entry => entry.id === id)?.spellings?.join('、') ?? id);
  const open = unclassified.filter((id) => !ranged.requirements.includes(id) && !ranged.defects.includes(id));
  if (ranged.requirements.length + ranged.defects.length > 0) {
    const parts = [ranged.requirements.length > 0 ? `需求 ${listOf(display(ranged.requirements))}` : '', ranged.defects.length > 0 ? `缺陷 ${listOf(display(ranged.defects))}` : ''].filter(Boolean);
    note(notes, `按调用方声明的编号范围（参数 id_ranges）分出${parts.join('，')}：这是声明，不是目录树给出的`);
  }
  if (open.length > 0) {
    note(notes, `编号 ${listOf(display(open))} 没有标明是需求还是缺陷${ranges ? '，声明的编号范围也分不出' : '（参数 id_ranges 给出缺陷系统的编号范围可以分开）'}`);
  }
  return {
    requirements: kept.filter((s) => s.kind === 'story').map((s) => s.id),
    defects: kept.filter((s) => s.kind === 'bug').map((s) => s.id),
    unclassified,
    id_sources: kept,
    ranged,
  };
}

// ---------------------------------------------------------------- the answer

/** The answer for one item and how it is reported. Total: malformed input gives an answer with notes, never an exception. */
export function locateItem(input: LocateInput): { answer: LocateAnswer; judgment: Judgment } {
  const notes: Notes = [];
  const productDoubts: Doubt[] = [];
  const versionDoubts: Doubt[] = [];
  const names = strings(input.names);
  const productId = typeof input.product === 'string' && input.product !== '' ? input.product : null;
  const bound = names.length > 0 && productId !== null;
  const root = typeof input.root === 'string' && input.root.trim() !== '' ? input.root : null;
  if (!Array.isArray(input.ancestors)) note(notes, '没有目录标签（不是数组）');
  let ancestors = strings(input.ancestors);
  if (root !== null && ancestors.length > 0 && ancestors[0] === root) ancestors = ancestors.slice(1);
  if (ancestors.length > LIMITS.maxLabels) note(notes, `目录超过 ${LIMITS.maxLabels} 层，只看前 ${LIMITS.maxLabels} 层`);
  ancestors = ancestors.slice(0, LIMITS.maxLabels);
  const labels = ancestors.map(parseLabel);
  const title = typeof input.title === 'string' && input.title.trim() !== '' ? input.title : null;
  const kind = input.kind === 'case' ? 'case' : 'document';
  const path = kind === 'case' ? strings(input.path).slice(0, LIMITS.maxPath) : [];
  const caseTitle = kind === 'case' && typeof input.case_title === 'string' ? input.case_title : null;
  // Declarations by the parameter rules (a direct call may pass anything; what the rules cannot read is no declaration).
  const given = isRecord(input.declared) ? input.declared : {};
  const declared: Declared = readParameters({ product: given.product ?? undefined, line: given.line ?? undefined }).declared;

  // ---- line, train, module and the version level
  const conv = convention(labels, notes);
  const level = versionLevel(labels, conv, names, notes);
  const scans = labels.map((l) => schemeScan(l.rest, names));
  const titleScan = title === null ? null : schemeScan(parseLabel(title).text, names);
  scans.forEach((s) => rejected(s.rejects, '目录', notes));
  if (titleScan !== null) rejected(titleScan.rejects, '标题', notes);
  const versionsOf = (matches: readonly SchemeMatch[]): string[] => matches.filter((m) => m.kind === 'version').map((m) => m.value);

  let version: string | null = null;
  let versionSource: VersionSource = 'none';
  let confidence: Confidence = 'none';
  if (level.value !== null) {
    version = level.value;
    versionSource = 'folders';
    confidence = level.disagreement === null ? 'high' : 'low';
    if (level.disagreement !== null) versionDoubts.push(level.disagreement);
  } else {
    const mention = scans.flatMap((s) => versionsOf(s.matches))[0];
    const titled = titleScan === null ? undefined : versionsOf(titleScan.matches)[0];
    if (mention !== undefined) {
      version = mention;
      versionSource = 'folders';
      confidence = 'low';
      versionDoubts.push({ text: `版本只是目录名里顺带提到的（${mention}），目录里没有版本层（版本线节点、发布火车或只写版本的目录）`, brief: '版本只是目录名里提到的', missing: '目录里的版本层', next: missingVersionNext(declared.line) });
    } else if (titled !== undefined) {
      version = titled;
      versionSource = 'title';
      confidence = 'low';
      note(notes, `目录里没有版本，标题里的版本 ${titled} 只作参考，置信度低`);
    } else note(notes, '目录和标题里都没有版本，版本未知');
  }
  // Every other version is a quote: in folders outside the version level, and in the title once the folders gave one.
  const quotes = unique(scans.flatMap((s, at) => (level.labels.has(at) ? [] : versionsOf(s.matches)))).filter((v) => v !== version);
  if (quotes.length > 0) note(notes, `目录里另外提到的版本（${listOf(quotes)}）只当引用，版本取${level.value !== null ? '版本层' : '最靠近根'}的 ${version}`);
  const titleQuotes = versionSource === 'folders' && titleScan !== null ? unique(versionsOf(titleScan.matches)).filter((v) => v !== version) : [];
  if (titleQuotes.length > 0) note(notes, `标题里提到的版本（${listOf(titleQuotes)}）只当引用`);

  // ---- build date and patch: at the version level only; without one, the nearest the root, else the title (references)
  const form = (kind: Exclude<SchemeKind, 'version'>): { value: string | null; source: FormSource } => {
    const what = FORM_LABEL[kind];
    const inLevel = (at: number): boolean => level.end < 0 || at <= level.end;
    const found = scans.flatMap((s, at) => (inLevel(at) ? s.matches.filter((m) => m.kind === kind).map((m) => m.value) : []))[0];
    const deeper = unique(scans.flatMap((s, at) => (inLevel(at) ? [] : s.matches.filter((m) => m.kind === kind).map((m) => m.value)))).filter((v) => v !== found);
    if (deeper.length > 0) note(notes, `版本层以下的目录里写的${what} ${listOf(deeper)} 只当引用`);
    const titled = titleScan?.matches.find((m) => m.kind === kind)?.value;
    if (found !== undefined) return { value: found, source: 'folders' };
    if (titled === undefined) return { value: null, source: 'none' };
    if (level.end < 0) return { value: titled, source: 'title' };
    note(notes, `标题里写的${what} ${titled} 只当引用，${what}只取目录的版本层`);
    return { value: null, source: 'none' };
  };
  const build = form('build');
  const patch = form('patch');

  // ---- the product by the root: a name of the bound line, else as the tree names it
  let productLine: string | null = null;
  let productName: string | null = null;
  const rootName = root === null ? undefined : names.find((n) => n === root);
  if (root === null) note(notes, '没有目录树的根，产品线定不出');
  else if (rootName !== undefined && productId !== null) {
    productLine = productId;
    productName = rootName;
  } else {
    productName = shown(root, LIMITS.maxText);
    if (!bound) note(notes, `运行没有绑定产品线：开始运行时用 product 写明产品名称，目录树的根${quoted(root)}才能对上产品线`);
    else note(notes, `目录树的根${quoted(root)}不是这条产品线的名称（${names.join('、')}），产品线定不出`);
  }

  // ---- declarations fill in what the tree does not give; one that contradicts the tree is a conflict
  const filled: string[] = [];
  const conflicts: Conflict[] = [];
  if (declared.product !== null) {
    const declaredName = names.find((n) => n === declared.product!);
    if (root === null) {
      productName = declaredName ?? shown(declared.product, LIMITS.maxText);
      productLine = declaredName !== undefined && productId !== null ? productId : null;
      filled.push('product_name', ...(productLine !== null ? ['product_line'] : []));
      note(notes, `产品取自调用方声明（参数 product）${productName}，未经目录树核对`);
    } else if (productLine !== null) {
      if (declaredName !== undefined) note(notes, `调用方声明的产品 ${declared.product} 与目录树的根同属产品线 ${productLine}`);
      else conflicts.push({ field: 'product', declared: declared.product, tree: productName! });
    } else if (declared.product === root) note(notes, `调用方声明的产品 ${declared.product} 与目录树的根一致，但它不是这条产品线的名称`);
    else if (!bound) note(notes, `运行没有绑定产品线，调用方声明的产品 ${declared.product} 与目录树的根是否同属一条产品线定不出`);
    else conflicts.push({ field: 'product', declared: declared.product, tree: productName! });
  }
  if (productLine === null) {
    if (!bound) productDoubts.push({ text: '产品线定不出（运行没有绑定产品线）', brief: '运行没有绑定产品线', missing: '运行绑定的产品线', next: '下一步开始这次运行时绑定这条产品线。' });
    else if (root === null && declared.product !== null) productDoubts.push({ text: `产品线定不出（没有目录树的根，调用方声明的产品${quoted(declared.product)}不是这条产品线的名称）`, brief: `声明的产品${quoted(declared.product)}不是产品名称`, missing: '目录树的根', next: '下一步把文档放到产品的根目录下，目录才能核对声明的产品。' });
    else if (root === null) productDoubts.push({ text: '产品线定不出（没有目录树的根）', brief: '没有目录树的根', missing: '目录树的根', next: '下一步把文档放到产品的根目录下。' });
    else productDoubts.push({ text: `产品线定不出（目录树的根${quoted(root)}不是产品线的名称）`, brief: `根${quoted(root)}不是产品名称`, missing: '作为产品线名称的根目录', next: '下一步把文档放到产品的根目录下。' });
  } else if (filled.includes('product_line')) productDoubts.push({ text: '产品线来自调用方声明，未经目录树核对', brief: '产品线是声明的', missing: '目录树对产品线的核对', next: '下一步把文档放到产品的根目录下，才能核对声明的产品。' });

  let line = conv.line ?? labels.slice(0, level.end + 1).flatMap(label => buildVersionsOf(label, names))[0]?.version ?? null;
  if (declared.line !== null) {
    if (level.value !== null) {
      // Against every value the tree gives at the version level: the version it reports, the line node and the train.
      const tree = unique([version, conv.lineAt >= 0 ? conv.line : null, conv.trainVersion].filter((v): v is string => v !== null));
      const against = tree.find((v) => !versionsAgree(declared.line!, v));
      if (level.disagreement !== null) {
        const matching = level.values.filter(v => versionsAgree(declared.line!, v.value)).map(v => v.value);
        note(notes, `调用方声明的版本线 ${declared.line} ${matching.length ? `与 ${unique(matching).join('、')} 一致` : '与版本层的每个值都不一致'}，声明不消除目录版本层的冲突`);
      } else if (against !== undefined) conflicts.push({ field: 'line', declared: declared.line, tree: against });
      else note(notes, `调用方声明的版本线 ${declared.line} 与目录给出的 ${listOf(tree)} 一致`);
    } else {
      line = declared.line;
      filled.push('line');
      if (version === null) {
        version = declared.line;
        versionSource = 'parameter';
        confidence = 'low';
        filled.push('version');
      } else if (!versionsAgree(version, declared.line)) note(notes, `参考版本 ${version} 与调用方声明的版本线 ${declared.line} 不一致`);
      note(notes, `版本线取自调用方声明（参数 line）${declared.line}，未经目录树核对`);
    }
  }
  if (versionSource === 'title') versionDoubts.push({ text: `版本只在标题里（参考版本 ${version}）`, brief: '版本只在标题里', missing: '目录里的版本层', next: missingVersionNext(declared.line) });
  else if (versionSource === 'parameter') versionDoubts.push({ text: '版本来自调用方声明，未经目录树核对', brief: '版本是声明的', missing: '目录里的版本层', next: missingVersionNext(declared.line) });
  else if (versionSource === 'none') versionDoubts.push({ text: '目录里没有版本层，版本未知', brief: '没有版本层', missing: '目录里的版本层', next: missingVersionNext(declared.line) });

  if (conv.train === null) versionDoubts.push({text:'缺少声明语法的发布火车层',brief:'发布火车层未知',missing:'famx-directory@1 的发布火车层身份',next:'下一步由包作者补目录语法或作者调整目录层级后重产。'});
  if (conv.module === null) versionDoubts.push({text:'缺少声明语法的模块层',brief:'模块层未知',missing:'famx-directory@1 的模块层身份',next:'下一步由包作者补目录语法或作者调整目录层级后重产。'});
  // ---- build names as written, of the line's families
  const builds = writtenBuilds([...ancestors, ...(title !== null ? [title] : []), ...path, ...(caseTitle !== null ? [caseTitle] : [])], names, LIMITS.maxBuildNames);
  if (builds.foreign.length > 0) {
    note(notes, bound ? `写出的构建名 ${listOf(builds.foreign)} 不是这条产品线的名称族，没有列出` : `运行没有绑定产品线，写出的构建名 ${listOf(builds.foreign)} 分不出名称族，没有列出`);
  }

  // ---- linked ids: the title, the folders below the version level (a document folder in the module place also by its
  // leading number), and the case's map texts after a marker word only
  const reads: IdRead[] = [];
  if (title !== null) reads.push({ text: title, from: 'title', leading: true });
  for (let at = level.end + 1; at < ancestors.length; at++) {
    reads.push({ text: ancestors[at], from: 'folders', leading: conv.trainAt >= 0 && at === conv.trainAt + 1 && conv.module === null });
  }
  for (const text of path) reads.push({ text, from: 'map', leading: false });
  if (caseTitle !== null) reads.push({ text: caseTitle, from: 'map', leading: false });
  const ids = idsOf(reads, input.id_ranges, notes);
  const ancestorPath = [...(root !== null ? [root] : []), ...ancestors, ...(kind === 'case' && title !== null ? [title] : []), ...path].map((t) => shown(t, LIMITS.maxText));

  const answer: LocateAnswer = {
    case_id: typeof input.case_id === 'string' ? input.case_id : '',
    product_line: productLine,
    product_name: productName,
    version,
    version_values: level.values.map(v => ({ version: v.value, level: v.at + 1, label: ancestors[v.at] })),
    missing: unique([
      ...(level.value === null ? ['目录里的版本层'] : []),
      ...productDoubts.flatMap((doubt) => doubt.missing === undefined ? [] : [doubt.missing]),
      ...versionDoubts.flatMap((doubt) => doubt.missing === undefined ? [] : [doubt.missing]),
    ]),
    build: build.value,
    patch: patch.value,
    line,
    train: conv.train,
    module: conv.module,
    ancestor_path: ancestorPath,
    version_source: versionSource,
    confidence,
    build_source: build.source,
    patch_source: patch.source,
    source: typeof input.source === 'string' ? input.source : null,
    build_names: builds.names,
    ...ids,
    declared: filled,
    conflicts,
    notes,
  };
  return { answer, judgment: judgmentOf(answer, [...productDoubts, ...versionDoubts], root !== null || ancestors.length > 0, declared.line) };
}

function rejected(rejects: ReturnType<typeof schemeScan>['rejects'], where: string, notes: Notes): void {
  for (const r of rejects) {
    note(notes, r.kind === 'build' ? `${where}里的${quoted(r.text)}不是有效的构建日期（build 加 8 位年月日）` : `${where}里的${quoted(r.text)}不是 patch 编号的写法（patch 加 n 或 n.n）`);
  }
}

/** The answer of one item (see locateItem). */
export function locate(input: LocateInput): LocateAnswer {
  return locateItem(input).answer;
}

function judgmentOf(answer: LocateAnswer, doubts: readonly Doubt[], fromTree: boolean, declaredLine: string | null): Judgment {
  const basis = fromTree ? `（${FOLDERS_BASIS}）` : '';
  if (unique(answer.version_values.map(v => lineOf(v.version))).length > 1) {
    const why = doubts.find(d => d.text.includes('版本层自相矛盾'));
    const matching = declaredLine === null ? [] : answer.version_values.filter(value => versionsAgree(declaredLine, value.version)).map(value => value.version);
    const declaration = declaredLine === null ? '' : `调用方声明的版本线 ${declaredLine} ${matching.length ? `与 ${unique(matching).join('、')} 一致` : '与版本层的每个值都不一致'}，声明不消除目录版本层的冲突`;
    const productConflicts = answer.conflicts.filter((conflict) => conflict.field === 'product');
    const productText = productConflicts.map((conflict) => `调用方声明的产品${quoted(conflict.declared)}与目录树的根${quoted(conflict.tree)}矛盾`).join('；');
    const productBrief = productConflicts.map((conflict) => `声明的产品${quoted(conflict.declared)}与根${quoted(conflict.tree)}矛盾`).join('，');
    const step = declaredLine === null
      ? '下一步由整理敏捷平台目录的人把文档放到一条版本线下，或开始运行时用参数 line 声明（标为声明）。'
      : '下一步由整理敏捷平台目录的人把文档放到一条版本线下；版本线已经声明，整理目录后才能核对。';
    return { verdict: 'refute', code: 'case-location.version_conflict', statement: `目录版本层自相矛盾：${why?.text ?? answer.version_values.map(v => v.version).join('、')}。${declaration}${declaration ? '；' : ''}${productText === '' ? '' : `${productText}；`}${step}已知${basis}：${described(answer)}`, brief: [why?.brief ?? '版本层自相矛盾', productBrief].filter((part) => part !== '').join('，') };
  }
  if (answer.conflicts.length > 0) {
    const parts = answer.conflicts.map((c) => (c.field === 'line' ? `版本线 ${c.declared} 与目录给出的版本 ${c.tree} 矛盾` : `产品${quoted(c.declared)}与目录树的根${quoted(c.tree)}矛盾`));
    const brief = answer.conflicts.map((c) => (c.field === 'line' ? `声明的版本线 ${c.declared} 与目录的 ${c.tree} 矛盾` : `声明的产品${quoted(c.declared)}与根${quoted(c.tree)}矛盾`));
    const itself = doubts.length > 0 ? `；目录树本身：${doubts.map((d) => d.text).join('；')}` : '';
    return { verdict: 'refute', code: CONFLICT_CODE, statement: `调用方声明的${parts.join('，')}；结论按目录树给出${basis}：${described(answer)}${itself}`, brief: [...brief, ...doubts.map((d) => d.brief)].join('，') };
  }
  if (doubts.length === 0) return { verdict: 'support', statement: `按目录树定位${basis}：${described(answer)}`, brief: '' };
  return {
    verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`定位不确定：${doubts.map((d) => d.text).join('；')}。${[...new Set(doubts.flatMap((doubt) => doubt.next === undefined ? [] : [doubt.next]))].join('')}已知${basis}：${described(answer)}`),
    reason: 'missing_input',
    statement: `定位不确定：${doubts.map((d) => d.text).join('；')}。${[...new Set(doubts.flatMap((doubt) => doubt.next === undefined ? [] : [doubt.next]))].join('')}已知${basis}：${described(answer)}`,
    brief: doubts.map((d) => d.brief).join('，'),
  };
}

/** Associated ids in the conclusion: every one of them, grouped by kind （需求、缺陷、未分类）; above 20 in total,
 * the first 20 in that order and 另有 N 个. These are the ids the capability hands to the user — never a top 3. */
const MAX_LISTED_IDS = 20;

function groupedIds(answer: LocateAnswer, shownId: (id: string, kind: LinkedId['kind']) => string): string[] {
  const groups: Array<[string, string[]]> = [];
  if (answer.requirements.length > 0) groups.push(['需求', answer.requirements.map((id) => shownId(id, 'story'))]);
  if (answer.defects.length > 0) groups.push(['缺陷', answer.defects.map((id) => shownId(id, 'bug'))]);
  if (answer.unclassified.length > 0) groups.push(['未分类编号', answer.unclassified.map((id) => shownId(id, null))]);
  const total = groups.reduce((sum, [, ids]) => sum + ids.length, 0);
  if (total <= MAX_LISTED_IDS) return groups.map(([label, ids]) => `${label} ${ids.join('、')}`);
  const parts: string[] = [];
  let left = MAX_LISTED_IDS;
  for (const [label, ids] of groups) {
    if (left === 0) break;
    parts.push(`${label} ${ids.slice(0, left).join('、')}`);
    left -= Math.min(left, ids.length);
  }
  return [...parts, `另有 ${total - MAX_LISTED_IDS} 个`];
}

/** The answer in one line of Chinese (statements and item summaries); references and declared readings say what they are. */
export function described(answer: LocateAnswer): string {
  const parts: string[] = [];
  if (answer.product_line !== null) parts.push(`产品线 ${answer.product_line}（${answer.product_name}）`);
  else if (answer.product_name !== null) parts.push(`产品 ${shown(answer.product_name, 40)}（产品线未定）`);
  else parts.push('产品线未定');
  parts.push(answer.version === null ? '版本未知' : `版本 ${answer.version}（${LABELS.version_source[answer.version_source]}，置信度${LABELS.confidence[answer.confidence]}）`);
  const reference = answer.confidence !== 'high';
  const form = (label: string, value: string | null, source: FormSource): void => {
    if (value !== null) parts.push(`${label} ${value}${reference ? `（${LABELS.version_source[source]}，参考）` : ''}`);
  };
  form(FORM_LABEL.build, answer.build, answer.build_source);
  form(FORM_LABEL.patch, answer.patch, answer.patch_source);
  if (answer.line !== null && answer.line !== answer.version) parts.push(`版本线 ${answer.line}`);
  if (answer.train !== null) parts.push(`发布火车 ${shown(answer.train, 60)}`);
  if (answer.module !== null) parts.push(`模块 ${answer.module}`);
  if (answer.build_names.length > 0) parts.push(`写出的构建名 ${listOf(answer.build_names)}`);
  const shownId = (id: string, kind: LinkedId['kind']): string => {
    const from = answer.id_sources.find((s) => s.id === id && s.kind === kind)?.from ?? ['title'];
    const marks = from.includes('title') ? [] : [from.map((f) => ID_SOURCE_LABEL[f]).join('、')];
    if (kind === null && answer.ranged.requirements.includes(id)) marks.push('声明的范围：需求');
    if (kind === null && answer.ranged.defects.includes(id)) marks.push('声明的范围：缺陷');
    const original = displayId(answer, id, kind);
    return marks.length === 0 ? original : `${original}（${marks.join('；')}）`;
  };
  parts.push(...groupedIds(answer, shownId));
  return parts.join('；');
}

/** The one-line summary of an item that the model reads next to its id and label: the answer, and why it is not a fact. */
export function summaryOf(answer: LocateAnswer, judgment: Judgment): string {
  const lead = judgment.verdict === 'support' ? '' : `${judgment.verdict === 'refute' ? (judgment.code === 'case-location.version_conflict' ? '目录版本层自相矛盾' : '与声明矛盾') : '不确定'}（${judgment.brief}）：`;
  return shown(`${lead}${described(answer)}`, 240);
}

/** The scheme's input from an item's fields and the run facts (names, product, parameters). */
export function locateInputOf(id: string, fields: unknown, context: { product?: unknown; names?: unknown; parameters?: unknown }): LocateInput {
  const f = (isRecord(fields) ? fields : {}) as Partial<ItemFields>;
  const parameters = readParameters(context.parameters);
  return {
    case_id: id,
    kind: f.kind === 'case' ? 'case' : 'document',
    root: typeof f.root === 'string' ? f.root : null,
    ancestors: strings(f.ancestors),
    title: typeof f.title === 'string' ? f.title : null,
    path: strings(f.path),
    case_title: typeof f.case_title === 'string' ? f.case_title : null,
    source: typeof f.source === 'string' ? f.source : null,
    names: strings(context.names),
    product: typeof context.product === 'string' ? context.product : null,
    declared: parameters.declared,
    id_ranges: parameters.idRanges,
  };
}

/** The answer of a call that failed inside (a pack defect): every field unknown, the failure in the notes. */
export function emptyAnswer(id: string, message: string): LocateAnswer {
  return {
    case_id: id,
    product_line: null,
    product_name: null,
    version: null,
    version_values: [],
    missing: ['目录树和版本层'],
    build: null,
    patch: null,
    line: null,
    train: null,
    module: null,
    ancestor_path: [],
    version_source: 'none',
    confidence: 'none',
    build_source: 'none',
    patch_source: 'none',
    source: null,
    build_names: [],
    requirements: [],
    defects: [],
    unclassified: [],
    id_sources: [],
    ranged: { requirements: [], defects: [] },
    declared: [],
    conflicts: [],
    notes: [message],
  };
}

/** Pack function entry (direct calls and the sandbox test): a LocateInput, answered with the answer and its judgment. */
export default function locateFunction(input: unknown): unknown {
  return guarded<{ answer: LocateAnswer; judgment: Judgment }>(
    () => locateItem((isRecord(input) ? input : {}) as LocateInput),
    (message) => ({
      answer: emptyAnswer(isRecord(input) && typeof input.case_id === 'string' ? input.case_id : '', message),
      judgment: { verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (`定位出错（任务包缺陷）：${message}`), reason: 'check_error', statement: `定位出错（任务包缺陷）：${message}`, brief: '定位出错' },
    }),
  );
}

/** Raw identifier spellings for display; arrays used for identity and external reads remain normalized. */
export function displayId(answer: LocateAnswer, id: string, kind: LinkedId['kind']): string {
  return answer.id_sources.find(entry => entry.id === id && entry.kind === kind)?.spellings?.join('、') ?? id;
}
